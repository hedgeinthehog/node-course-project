import * as aws from '@pulumi/aws';
import * as pulumi from '@pulumi/pulumi';

const config = new pulumi.Config();
const githubRepo = config.require('githubRepo');

// The budget is declared before anything that could ever cost money. It watches the whole account:
// a tag only becomes a cost-allocation key after a delay, so a tag filter would see nothing at first.
// LocalStack has no Budgets API, so its stack switches the resource off.
if (config.requireBoolean('withBudget')) {
  new aws.budgets.Budget('monthly', {
    budgetType: 'COST',
    timeUnit: 'MONTHLY',
    limitAmount: '5',
    limitUnit: 'USD',
    notifications: [
      {
        notificationType: 'ACTUAL',
        comparisonOperator: 'GREATER_THAN',
        threshold: 20,
        thresholdType: 'PERCENTAGE',
        subscriberEmailAddresses: [config.require('budgetEmail')],
      },
    ],
  });
}

const VPC_CIDR = '10.31.0.0/16';
const APP_PORT = 3000;
const POSTGRES_PORT = 5432;

const zones = aws.getAvailabilityZonesOutput({ state: 'available' });
const zone = (index: number) => zones.names[index];

const vpc = new aws.ec2.Vpc('main', {
  cidrBlock: VPC_CIDR,
  enableDnsSupport: true,
  enableDnsHostnames: true,
  tags: { Name: 'hw31' },
});

const gateway = new aws.ec2.InternetGateway('main', {
  vpcId: vpc.id,
  tags: { Name: 'hw31' },
});

const subnet = (
  name: string,
  cidrBlock: string,
  index: number,
  isPublic: boolean,
) =>
  new aws.ec2.Subnet(name, {
    vpcId: vpc.id,
    cidrBlock,
    availabilityZone: zone(index),
    mapPublicIpOnLaunch: isPublic,
    tags: { Name: `hw31-${name}`, Tier: isPublic ? 'public' : 'private' },
  });

const publicSubnets = [
  subnet('public-a', '10.31.0.0/24', 0, true),
  subnet('public-b', '10.31.1.0/24', 1, true),
];
const privateSubnets = [
  subnet('private-a', '10.31.10.0/24', 0, false),
  subnet('private-b', '10.31.11.0/24', 1, false),
];

const publicRoutes = new aws.ec2.RouteTable('public', {
  vpcId: vpc.id,
  routes: [{ cidrBlock: '0.0.0.0/0', gatewayId: gateway.id }],
  tags: { Name: 'hw31-public' },
});
// "Private" is the absence of a line: this table has no 0.0.0.0/0 route at all. Only the database
// lives behind it, and a database does not need a way out to the internet.
const privateRoutes = new aws.ec2.RouteTable('private', {
  vpcId: vpc.id,
  tags: { Name: 'hw31-private' },
});
publicSubnets.forEach(
  (item, index) =>
    new aws.ec2.RouteTableAssociation(`public-${index}`, {
      subnetId: item.id,
      routeTableId: publicRoutes.id,
    }),
);
privateSubnets.forEach(
  (item, index) =>
    new aws.ec2.RouteTableAssociation(`private-${index}`, {
      subnetId: item.id,
      routeTableId: privateRoutes.id,
    }),
);

const albSg = new aws.ec2.SecurityGroup('alb', {
  vpcId: vpc.id,
  description: 'Internet-facing load balancer',
  ingress: [
    {
      // 80 from anywhere: the balancer is the only public entry point; there is no own domain,
      // therefore no certificate and no 443.
      protocol: 'tcp',
      fromPort: 80,
      toPort: 80,
      cidrBlocks: ['0.0.0.0/0'],
    },
  ],
  egress: [
    {
      // The balancer only talks to application targets inside the VPC on the application port.
      protocol: 'tcp',
      fromPort: APP_PORT,
      toPort: APP_PORT,
      cidrBlocks: [VPC_CIDR],
    },
  ],
  tags: { Name: 'hw31-alb' },
});

const appSg = new aws.ec2.SecurityGroup('app', {
  vpcId: vpc.id,
  description: 'Application compute behind the load balancer',
  ingress: [
    {
      // 3000 only from the balancer's group: the API is never reachable from the internet directly.
      protocol: 'tcp',
      fromPort: APP_PORT,
      toPort: APP_PORT,
      securityGroups: [albSg.id],
    },
  ],
  egress: [
    {
      // The application reaches PostgreSQL inside the VPC and nothing else.
      protocol: 'tcp',
      fromPort: POSTGRES_PORT,
      toPort: POSTGRES_PORT,
      cidrBlocks: [VPC_CIDR],
    },
  ],
  tags: { Name: 'hw31-app' },
});

const dbSg = new aws.ec2.SecurityGroup('db', {
  vpcId: vpc.id,
  description: 'PostgreSQL in the private subnets',
  ingress: [
    {
      // 5432 only from the application group: a security group reference, not a CIDR, so a new
      // host in the VPC gets no access until it joins that group.
      protocol: 'tcp',
      fromPort: POSTGRES_PORT,
      toPort: POSTGRES_PORT,
      securityGroups: [appSg.id],
    },
  ],
  tags: { Name: 'hw31-db' },
});

const GITHUB_OIDC = 'token.actions.githubusercontent.com';
const github = new aws.iam.OpenIdConnectProvider('github', {
  url: `https://${GITHUB_OIDC}`,
  clientIdLists: ['sts.amazonaws.com'],
});

const ciRole = new aws.iam.Role('ci-teardown', {
  name: 'hw31-ci-teardown',
  description:
    'Assumed by GitHub Actions through OIDC to destroy the demo stack and prove it is gone',
  maxSessionDuration: 3600,
  assumeRolePolicy: pulumi.jsonStringify({
    Version: '2012-10-17',
    Statement: [
      {
        Effect: 'Allow',
        Principal: { Federated: github.arn },
        Action: 'sts:AssumeRoleWithWebIdentity',
        Condition: {
          StringEquals: { [`${GITHUB_OIDC}:aud`]: 'sts.amazonaws.com' },
          StringLike: { [`${GITHUB_OIDC}:sub`]: `repo:${githubRepo}:*` },
        },
      },
    ],
  }),
});

const TEARDOWN_ACTIONS = [
  'rds:DescribeDBInstances',
  'rds:DescribeDBSubnetGroups',
  'rds:ListTagsForResource',
  'rds:DeleteDBInstance',
  'rds:DeleteDBSubnetGroup',
  'elasticloadbalancing:DescribeLoadBalancers',
  'elasticloadbalancing:DescribeLoadBalancerAttributes',
  'elasticloadbalancing:DescribeListeners',
  'elasticloadbalancing:DescribeListenerAttributes',
  'elasticloadbalancing:DescribeTargetGroups',
  'elasticloadbalancing:DescribeTargetGroupAttributes',
  'elasticloadbalancing:DescribeTargetHealth',
  'elasticloadbalancing:DescribeTags',
  'elasticloadbalancing:DeregisterTargets',
  'elasticloadbalancing:DeleteListener',
  'elasticloadbalancing:DeleteTargetGroup',
  'elasticloadbalancing:DeleteLoadBalancer',
  'ec2:DescribeNatGateways',
  'ec2:DescribeAddresses',
  'ec2:DescribeAddressesAttribute',
  'ec2:DescribeTags',
  'ec2:DeleteNatGateway',
  'ec2:DisassociateAddress',
  'ec2:ReleaseAddress',
  'lambda:GetFunction',
  'lambda:GetFunctionCodeSigningConfig',
  'lambda:GetPolicy',
  'lambda:ListVersionsByFunction',
  'lambda:RemovePermission',
  'lambda:DeleteFunction',
  'iam:GetRole',
  'iam:ListRolePolicies',
  'iam:ListAttachedRolePolicies',
  'iam:ListInstanceProfilesForRole',
  'iam:DetachRolePolicy',
  'iam:DeleteRole',
  'tag:GetResources',
];

new aws.iam.RolePolicy('ci-teardown', {
  name: 'teardown-demo',
  role: ciRole.id,
  policy: pulumi.jsonStringify({
    Version: '2012-10-17',
    Statement: [
      {
        Sid: 'DestroyDemoStackAndProveItIsGone',
        Effect: 'Allow',
        Action: TEARDOWN_ACTIONS,
        Resource: '*',
      },
    ],
  }),
});

export const vpcId = vpc.id;
export const publicSubnetIds = publicSubnets.map((item) => item.id);
export const privateSubnetIds = privateSubnets.map((item) => item.id);
export const albSecurityGroupId = albSg.id;
export const appSecurityGroupId = appSg.id;
export const dbSecurityGroupId = dbSg.id;
export const ciRoleArn = ciRole.arn;
export const ciRoleName = ciRole.name;

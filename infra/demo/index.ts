import * as aws from '@pulumi/aws';
import * as pulumi from '@pulumi/pulumi';

// Registered before the first resource: a database that cannot be deleted, or that leaves a final
// snapshot behind, turns `destroy` into a bill that outlives it.
pulumi.runtime.registerResourceTransform((args) =>
  args.type === 'aws:rds/instance:Instance'
    ? {
        props: {
          ...args.props,
          deletionProtection: false,
          skipFinalSnapshot: true,
        },
        opts: args.opts,
      }
    : undefined,
);

const config = new pulumi.Config();
const dbPassword = process.env.DB_PASSWORD;
if (!dbPassword) {
  throw new Error(
    'missing environment variable: DB_PASSWORD — it comes from the vault',
  );
}

const base = new pulumi.StackReference(
  `organization/hw31-base/${pulumi.getStack()}`,
);
const publicSubnetIds = base.requireOutput('publicSubnetIds') as pulumi.Output<
  string[]
>;
const privateSubnetIds = base.requireOutput(
  'privateSubnetIds',
) as pulumi.Output<string[]>;
const output = (name: string) =>
  base.requireOutput(name) as pulumi.Output<string>;

const dbSubnets = new aws.rds.SubnetGroup('db', {
  subnetIds: privateSubnetIds,
  tags: { Name: 'hw31-db' },
});

// Multi-AZ *instance* deployment: one primary and one standby of a burstable class. Not the
// "Multi-AZ DB cluster", which needs db.m/db.c classes and costs several times more.
const db = new aws.rds.Instance('db', {
  identifier: 'hw31-db',
  engine: 'postgres',
  instanceClass: 'db.t4g.micro',
  multiAz: true,
  storageType: 'gp3',
  allocatedStorage: 20,
  storageEncrypted: true,
  backupRetentionPeriod: 1,
  dbName: 'marketplace',
  username: 'marketplace',
  password: pulumi.secret(dbPassword),
  dbSubnetGroupName: dbSubnets.name,
  vpcSecurityGroupIds: [output('dbSecurityGroupId')],
  publiclyAccessible: false,
  performanceInsightsEnabled: false,
  monitoringInterval: 0,
  applyImmediately: true,
});

const targetRole = new aws.iam.Role('alb-target', {
  assumeRolePolicy: JSON.stringify({
    Version: '2012-10-17',
    Statement: [
      {
        Effect: 'Allow',
        Principal: { Service: 'lambda.amazonaws.com' },
        Action: 'sts:AssumeRole',
      },
    ],
  }),
});

const target = new aws.lambda.Function('alb-target', {
  runtime: 'nodejs22.x',
  handler: 'index.handler',
  role: targetRole.arn,
  code: new pulumi.asset.AssetArchive({
    'index.js': new pulumi.asset.StringAsset(
      `exports.handler = async () => ({
  statusCode: 200,
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ status: 'ok', service: 'marketplace' }),
});`,
    ),
  }),
});

const balancer = new aws.lb.LoadBalancer('api', {
  name: 'hw31-api',
  loadBalancerType: 'application',
  internal: false,
  subnets: publicSubnetIds,
  securityGroups: [output('albSecurityGroupId')],
});

const targets = new aws.lb.TargetGroup('api', {
  name: 'hw31-api',
  targetType: 'lambda',
  healthCheck: {
    enabled: true,
    path: '/healthz',
    matcher: '200',
    interval: 10,
    timeout: 5,
    healthyThreshold: 2,
    unhealthyThreshold: 2,
  },
});

const invoke = new aws.lambda.Permission('alb', {
  action: 'lambda:InvokeFunction',
  function: target.name,
  principal: 'elasticloadbalancing.amazonaws.com',
  sourceArn: targets.arn,
});

new aws.lb.TargetGroupAttachment(
  'api',
  { targetGroupArn: targets.arn, targetId: target.arn },
  { dependsOn: [invoke] },
);

new aws.lb.Listener('http', {
  loadBalancerArn: balancer.arn,
  port: 80,
  protocol: 'HTTP',
  defaultActions: [{ type: 'forward', targetGroupArn: targets.arn }],
});

// The NAT gateway this project does not need: it exists only for the minutes it takes to measure
// that a partial hour is billed as a full one.
if (config.requireBoolean('withNat')) {
  const address = new aws.ec2.Eip('nat', { domain: 'vpc' });
  new aws.ec2.NatGateway('nat', {
    subnetId: publicSubnetIds[0],
    allocationId: address.id,
    tags: { Name: 'hw31-nat' },
  });
}

export const dbIdentifier = db.identifier;
export const albDnsName = balancer.dnsName;
export const targetGroupArn = targets.arn;

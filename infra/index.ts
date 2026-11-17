import * as k8s from '@pulumi/kubernetes';
import * as pulumi from '@pulumi/pulumi';
import { BackingService } from './backing';
import { readVault } from './vault';

const vault = readVault(process.env);

const config = new pulumi.Config();
const profile = config.require('profile');
if (profile !== 'hardened' && profile !== 'naive') {
  throw new Error(`profile must be hardened or naive, got "${profile}"`);
}
const hardened = profile === 'hardened';
const image = config.require('image');
const replicas = config.requireNumber('replicas');
const maxReplicas = config.requireNumber('maxReplicas');
const minAvailable = config.requireNumber('minAvailable');
const nodePort = config.requireNumber('nodePort');
const rev = config.require('rev');

const APP = 'marketplace-api';
const PORT = 3000;
const WARMUP_MS = 4000;
const DRAIN_MS = 5000;
const GRACE_SECONDS = 30;
const DB_USER = 'marketplace';
const DB_NAME = 'marketplace';
const BUCKET = 'marketplace-files';
const SECRET_DIR = '/var/run/marketplace';

const provider = new k8s.Provider('cluster', {
  context: config.require('kubeContext'),
  enableSecretMutable: true,
});
const opts = { provider };

const ns = new k8s.core.v1.Namespace(
  'marketplace',
  { metadata: { name: 'marketplace' } },
  opts,
);
const namespace = ns.metadata.name;

const base64 = (value: pulumi.Input<string>) =>
  pulumi.output(value).apply((text) => Buffer.from(text).toString('base64'));

const secret = new k8s.core.v1.Secret(
  'marketplace-secrets',
  {
    metadata: { name: 'marketplace-secrets', namespace },
    type: 'Opaque',
    data: {
      db_password: base64(pulumi.interpolate`${DB_USER}:${vault.DB_PASSWORD}`),
      DB_PASSWORD: base64(vault.DB_PASSWORD),
      BROKER_PASSWORD: base64(vault.brokerPassword),
      BROKER_URL: base64(
        pulumi.interpolate`amqp://${encodeURIComponent(vault.brokerUser)}:${vault.brokerPassword.apply(encodeURIComponent)}@rabbitmq:5672`,
      ),
      JWT_PRIVATE_KEY: base64(vault.JWT_PRIVATE_KEY),
      REFRESH_TOKEN_PEPPER: base64(vault.REFRESH_TOKEN_PEPPER),
      STORAGE_SECRET_KEY: base64(vault.STORAGE_SECRET_KEY),
    },
  },
  opts,
);
const fromSecret = (name: string, key = name) => ({
  name,
  valueFrom: { secretKeyRef: { name: secret.metadata.name, key } },
});

const postgres = new BackingService(
  'postgres',
  {
    namespace,
    image: 'postgres:17-alpine',
    port: 5432,
    env: [
      { name: 'POSTGRES_USER', value: DB_USER },
      { name: 'POSTGRES_DB', value: DB_NAME },
      fromSecret('POSTGRES_PASSWORD', 'DB_PASSWORD'),
      { name: 'PGDATA', value: '/var/lib/postgresql/data/pgdata' },
    ],
    readinessProbe: {
      exec: { command: ['pg_isready', '-U', DB_USER, '-d', DB_NAME] },
      periodSeconds: 2,
    },
    dataPath: '/var/lib/postgresql/data',
  },
  opts,
);
const redis = new BackingService(
  'redis',
  {
    namespace,
    image: 'redis:8-alpine',
    port: 6379,
    readinessProbe: { tcpSocket: { port: 6379 }, periodSeconds: 2 },
    dataPath: '/data',
  },
  opts,
);
const rabbitmq = new BackingService(
  'rabbitmq',
  {
    namespace,
    image: 'rabbitmq:4.2-alpine',
    port: 5672,
    env: [
      { name: 'RABBITMQ_DEFAULT_USER', value: vault.brokerUser },
      fromSecret('RABBITMQ_DEFAULT_PASS', 'BROKER_PASSWORD'),
    ],
    readinessProbe: { tcpSocket: { port: 5672 }, periodSeconds: 3 },
    dataPath: '/var/lib/rabbitmq',
  },
  opts,
);
const minio = new BackingService(
  'minio',
  {
    namespace,
    image: 'bitnamilegacy/minio:2025.7.23-debian-12-r5',
    port: 9000,
    env: [
      { name: 'MINIO_ROOT_USER', value: vault.STORAGE_ACCESS_KEY },
      fromSecret('MINIO_ROOT_PASSWORD', 'STORAGE_SECRET_KEY'),
    ],
    readinessProbe: {
      httpGet: { path: '/minio/health/live', port: 9000 },
      periodSeconds: 2,
    },
    dataPath: '/bitnami/minio/data',
  },
  opts,
);

const appEnv: k8s.types.input.core.v1.EnvVar[] = [
  { name: 'PORT', value: String(PORT) },
  {
    name: 'DB_URL',
    value: pulumi.interpolate`postgres://${postgres.host}:5432/${DB_NAME}`,
  },
  { name: 'DB_PASSWORD_FILE', value: `${SECRET_DIR}/db_password` },
  { name: 'DB_HOST', value: postgres.host },
  { name: 'DB_PORT', value: '5432' },
  { name: 'DB_USER', value: DB_USER },
  { name: 'DB_NAME', value: DB_NAME },
  fromSecret('DB_PASSWORD'),
  fromSecret('BROKER_URL'),
  { name: 'REDIS_URL', value: pulumi.interpolate`redis://${redis.host}:6379` },
  {
    name: 'REDIS_QUEUE_URL',
    value: pulumi.interpolate`redis://${redis.host}:6379`,
  },
  { name: 'JWT_KID', value: vault.JWT_KID },
  { name: 'JWT_PUBLIC_KEYS', value: vault.JWT_PUBLIC_KEYS },
  fromSecret('JWT_PRIVATE_KEY'),
  fromSecret('REFRESH_TOKEN_PEPPER'),
  {
    name: 'STORAGE_ENDPOINT',
    value: pulumi.interpolate`http://${minio.host}:9000`,
  },
  { name: 'STORAGE_ACCESS_KEY', value: vault.STORAGE_ACCESS_KEY },
  fromSecret('STORAGE_SECRET_KEY'),
  { name: 'STORAGE_BUCKET', value: BUCKET },
];
const secretVolume = {
  name: 'db-credentials',
  secret: {
    secretName: secret.metadata.name,
    items: [{ key: 'db_password', path: 'db_password' }],
  },
};
const secretMount = {
  name: 'db-credentials',
  mountPath: SECRET_DIR,
  readOnly: true,
};
const podSecurity = {
  runAsNonRoot: true,
  runAsUser: 65532,
  runAsGroup: 65532,
  fsGroup: 65532,
};
const containerSecurity = {
  allowPrivilegeEscalation: false,
  readOnlyRootFilesystem: true,
  capabilities: { drop: ['ALL'] },
};

const step = (
  name: string,
  args: string[],
): k8s.types.input.core.v1.Container => ({
  name,
  image,
  imagePullPolicy: 'IfNotPresent',
  args,
  env: appEnv,
  volumeMounts: [secretMount],
  securityContext: containerSecurity,
});
const bootstrap = new k8s.batch.v1.Job(
  'bootstrap',
  {
    metadata: { name: 'marketplace-bootstrap', namespace },
    spec: {
      backoffLimit: 6,
      template: {
        spec: {
          restartPolicy: 'OnFailure',
          securityContext: podSecurity,
          initContainers: [
            step('migrate', [
              'node_modules/typeorm/cli.js',
              'migration:run',
              '-d',
              'dist/data-source.js',
            ]),
            step('broker-topology', ['dist/events-topology.js']),
          ],
          containers: [step('storage-bucket', ['dist/storage-init.js'])],
          volumes: [secretVolume],
        },
      },
    },
  },
  { ...opts, dependsOn: [postgres, rabbitmq, minio] },
);

const labels = { app: APP };
const probe = (path: string): k8s.types.input.core.v1.Probe => ({
  httpGet: { path, port: PORT },
});

const deployment = new k8s.apps.v1.Deployment(
  APP,
  {
    metadata: { name: APP, namespace, labels },
    spec: {
      replicas,
      selector: { matchLabels: labels },
      strategy: {
        type: 'RollingUpdate',
        rollingUpdate: hardened
          ? { maxUnavailable: 0, maxSurge: 1 }
          : { maxUnavailable: 1, maxSurge: 1 },
      },
      template: {
        metadata: { labels },
        spec: {
          terminationGracePeriodSeconds: GRACE_SECONDS,
          securityContext: podSecurity,
          containers: [
            {
              name: 'api',
              image,
              imagePullPolicy: 'IfNotPresent',
              ports: [{ containerPort: PORT }],
              env: [
                ...appEnv,
                { name: 'REV', value: rev },
                { name: 'STARTUP_DELAY_MS', value: String(WARMUP_MS) },
                {
                  name: 'SHUTDOWN_DRAIN_MS',
                  value: String(hardened ? DRAIN_MS : 0),
                },
              ],
              startupProbe: hardened
                ? {
                    ...probe('/healthz'),
                    periodSeconds: 1,
                    failureThreshold: 60,
                  }
                : undefined,
              readinessProbe: hardened
                ? {
                    ...probe('/readyz'),
                    periodSeconds: 1,
                    timeoutSeconds: 1,
                    failureThreshold: 1,
                  }
                : undefined,
              livenessProbe: hardened
                ? {
                    ...probe('/healthz'),
                    periodSeconds: 10,
                    timeoutSeconds: 2,
                    failureThreshold: 3,
                  }
                : undefined,
              resources: {
                requests: { cpu: '100m', memory: '192Mi' },
                limits: { memory: '512Mi' },
              },
              volumeMounts: [secretMount],
              securityContext: containerSecurity,
            },
          ],
          volumes: [secretVolume],
        },
      },
    },
  },
  { ...opts, dependsOn: [bootstrap, redis] },
);

const service = new k8s.core.v1.Service(
  APP,
  {
    metadata: { name: APP, namespace, labels },
    spec: {
      type: 'NodePort',
      selector: labels,
      ports: [{ port: 80, targetPort: PORT, nodePort }],
    },
  },
  opts,
);

const pdb = new k8s.policy.v1.PodDisruptionBudget(
  APP,
  {
    metadata: { name: APP, namespace },
    spec: { minAvailable, selector: { matchLabels: labels } },
  },
  opts,
);

const hpa = new k8s.autoscaling.v2.HorizontalPodAutoscaler(
  APP,
  {
    metadata: { name: APP, namespace },
    spec: {
      scaleTargetRef: {
        apiVersion: 'apps/v1',
        kind: 'Deployment',
        name: deployment.metadata.name,
      },
      minReplicas: replicas,
      maxReplicas,
      metrics: [
        {
          type: 'Resource',
          resource: {
            name: 'cpu',
            target: { type: 'Utilization', averageUtilization: 70 },
          },
        },
      ],
    },
  },
  opts,
);

export const namespaceName = namespace;
export const deploymentName = deployment.metadata.name;
export const serviceName = service.metadata.name;
export const pdbName = pdb.metadata.name;
export const hpaName = hpa.metadata.name;
export const url = `http://127.0.0.1:${nodePort}`;
export const rolloutProfile = profile;

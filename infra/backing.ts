import * as k8s from '@pulumi/kubernetes';
import * as pulumi from '@pulumi/pulumi';

export interface BackingServiceArgs {
  namespace: pulumi.Input<string>;
  image: string;
  port: number;
  env?: k8s.types.input.core.v1.EnvVar[];
  readinessProbe: k8s.types.input.core.v1.Probe;
  dataPath: string;
}

export class BackingService extends pulumi.ComponentResource {
  readonly host: pulumi.Output<string>;

  constructor(
    name: string,
    args: BackingServiceArgs,
    opts: pulumi.ComponentResourceOptions,
  ) {
    super('marketplace:index:BackingService', name, {}, opts);
    const labels = { app: name };
    const metadata = { name, namespace: args.namespace, labels };

    new k8s.apps.v1.Deployment(
      name,
      {
        metadata,
        spec: {
          replicas: 1,
          strategy: { type: 'Recreate' },
          selector: { matchLabels: labels },
          template: {
            metadata: { labels },
            spec: {
              containers: [
                {
                  name,
                  image: args.image,
                  ports: [{ containerPort: args.port }],
                  env: args.env,
                  readinessProbe: args.readinessProbe,
                  volumeMounts: [{ name: 'data', mountPath: args.dataPath }],
                },
              ],
              volumes: [{ name: 'data', emptyDir: {} }],
            },
          },
        },
      },
      { parent: this },
    );
    const service = new k8s.core.v1.Service(
      name,
      {
        metadata,
        spec: {
          selector: labels,
          ports: [{ port: args.port, targetPort: args.port }],
        },
      },
      { parent: this },
    );
    this.host = service.metadata.name;
    this.registerOutputs({ host: this.host });
  }
}

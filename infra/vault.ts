import * as pulumi from '@pulumi/pulumi';

const SECRETS = [
  'DB_PASSWORD',
  'BROKER_URL',
  'JWT_PRIVATE_KEY',
  'REFRESH_TOKEN_PEPPER',
  'STORAGE_SECRET_KEY',
] as const;
const SETTINGS = ['JWT_KID', 'JWT_PUBLIC_KEYS', 'STORAGE_ACCESS_KEY'] as const;

type Secrets = Record<(typeof SECRETS)[number], pulumi.Output<string>>;
type Settings = Record<(typeof SETTINGS)[number], string>;

export interface Vault extends Secrets, Settings {
  brokerUser: string;
  brokerPassword: pulumi.Output<string>;
}

export function readVault(env: NodeJS.ProcessEnv): Vault {
  const missing = [...SECRETS, ...SETTINGS].filter((name) => !env[name]);
  if (missing.length > 0) {
    throw new Error(
      `missing environment variables: ${missing.join(', ')} — they come from the vault, run through scripts/with-secrets.sh`,
    );
  }
  const value = (name: string) => env[name] as string;
  let broker: URL;
  try {
    broker = new URL(value('BROKER_URL'));
  } catch {
    throw new Error('BROKER_URL is not a valid amqp:// URL');
  }
  if (!broker.username || !broker.password) {
    throw new Error('BROKER_URL must carry the broker user and password');
  }
  return {
    DB_PASSWORD: pulumi.secret(value('DB_PASSWORD')),
    BROKER_URL: pulumi.secret(value('BROKER_URL')),
    JWT_PRIVATE_KEY: pulumi.secret(value('JWT_PRIVATE_KEY')),
    REFRESH_TOKEN_PEPPER: pulumi.secret(value('REFRESH_TOKEN_PEPPER')),
    STORAGE_SECRET_KEY: pulumi.secret(value('STORAGE_SECRET_KEY')),
    JWT_KID: value('JWT_KID'),
    JWT_PUBLIC_KEYS: value('JWT_PUBLIC_KEYS'),
    STORAGE_ACCESS_KEY: value('STORAGE_ACCESS_KEY'),
    brokerUser: decodeURIComponent(broker.username),
    brokerPassword: pulumi.secret(decodeURIComponent(broker.password)),
  };
}

import { createPrivateKey, createPublicKey } from 'node:crypto';
import { z } from 'zod';

export const brokerUrlSchema = z.url({ protocol: /^amqps?$/ });
export const redisUrlSchema = z.url({ protocol: /^rediss?$/ });

const parsesPem = (parse: (pem: string) => unknown, value: string) => {
  try {
    parse(Buffer.from(value, 'base64').toString('utf8'));
    return true;
  } catch {
    return false;
  }
};

const pemBase64 = (parse: (pem: string) => unknown, what: string) =>
  z
    .string()
    .min(1)
    .refine((value) => parsesPem(parse, value), {
      message: `must be a base64-encoded PEM ${what}`,
    });

const kidPattern = /^[\w.-]+$/;

export const publicKeyringSchema = z
  .string()
  .min(1)
  .transform((value, ctx) => {
    const keyring: Record<string, string> = {};
    for (const entry of value.split(',')) {
      const [kid, key, ...rest] = entry.trim().split(':');
      if (!kid || !key || rest.length > 0 || !kidPattern.test(kid)) {
        ctx.addIssue({
          code: 'custom',
          message: `entry "${entry}" must look like kid:base64pem`,
        });
      } else if (!parsesPem(createPublicKey, key)) {
        ctx.addIssue({
          code: 'custom',
          message: `kid "${kid}" is not a base64-encoded PEM public key`,
        });
      } else {
        keyring[kid] = key;
      }
    }
    return keyring;
  });

export const envSchema = z
  .object({
    NODE_ENV: z
      .enum(['development', 'test', 'production'])
      .default('development'),
    PORT: z.coerce.number().int().min(1).max(65535).default(3000),
    DB_URL: z
      .string()
      .url()
      .refine((url) => !new URL(url).username && !new URL(url).password, {
        message: 'must not contain credentials, use DB_PASSWORD_FILE instead',
      }),
    DB_PASSWORD_FILE: z.string().min(1),
    BROKER_URL: brokerUrlSchema,
    REDIS_URL: redisUrlSchema,
    REDIS_QUEUE_URL: redisUrlSchema,
    RATE_LIMIT: z.coerce.number().int().min(1).default(100),
    RATE_LIMIT_WINDOW_MS: z.coerce.number().int().min(1000).default(10_000),
    JWT_KID: z.string().regex(kidPattern),
    JWT_PRIVATE_KEY: pemBase64(createPrivateKey, 'private key'),
    JWT_PUBLIC_KEYS: publicKeyringSchema,
    REFRESH_TOKEN_PEPPER: z.string().min(16),
    PACT_BROKER_URL: z.string().url().optional(),
    PACT_BROKER_TOKEN: z.string().optional(),
  })
  .superRefine((env, ctx) => {
    if (env.JWT_PUBLIC_KEYS && !(env.JWT_KID in env.JWT_PUBLIC_KEYS)) {
      ctx.addIssue({
        code: 'custom',
        path: ['JWT_PUBLIC_KEYS'],
        message: `must list the signing key JWT_KID=${env.JWT_KID}`,
      });
    }
  });

export type Env = z.infer<typeof envSchema>;

export function validate(config: Record<string, unknown>): Env {
  const result = envSchema.safeParse(config);
  if (!result.success) {
    const lines = result.error.issues.map(
      (issue) => `  - ${issue.path.join('.')}: ${issue.message}`,
    );
    throw new Error(`Invalid environment variables:\n${lines.join('\n')}`);
  }
  return result.data;
}

export function parseBrokerUrl(env: NodeJS.ProcessEnv): string {
  const result = brokerUrlSchema.safeParse(env.BROKER_URL);
  if (!result.success) {
    throw new Error(
      `Invalid BROKER_URL: ${result.error.issues.map((issue) => issue.message).join(', ')}`,
    );
  }
  return result.data;
}

export function parseRedisUrls(env: NodeJS.ProcessEnv): {
  cache: string;
  queue: string;
} {
  const result = z
    .object({ REDIS_URL: redisUrlSchema, REDIS_QUEUE_URL: redisUrlSchema })
    .safeParse(env);
  if (!result.success) {
    throw new Error(
      `Invalid Redis environment:\n${result.error.issues.map((issue) => `  - ${issue.path.join('.')}: ${issue.message}`).join('\n')}`,
    );
  }
  return { cache: result.data.REDIS_URL, queue: result.data.REDIS_QUEUE_URL };
}

import { z } from 'zod';

export const brokerUrlSchema = z.url({ protocol: /^amqps?$/ });

export const envSchema = z.object({
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
  PACT_BROKER_URL: z.string().url().optional(),
  PACT_BROKER_TOKEN: z.string().optional(),
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

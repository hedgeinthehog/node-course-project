import { z } from 'zod';

export const dbEnvSchema = z.object({
  DB_HOST: z.string().min(1),
  DB_PORT: z.coerce.number().int().min(1).max(65535),
  DB_USER: z.string().min(1),
  DB_PASSWORD: z.string().min(1),
  DB_NAME: z.string().min(1),
});

export function parseDbEnv(env: NodeJS.ProcessEnv) {
  const result = dbEnvSchema.safeParse(env);
  if (!result.success) {
    const lines = result.error.issues.map(
      (issue) => `  - ${issue.path.join('.')}: ${issue.message}`,
    );
    throw new Error(`Invalid database environment:\n${lines.join('\n')}`);
  }
  return result.data;
}

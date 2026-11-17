import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
export const IMAGE = process.env.IMAGE ?? 'marketplace-api:local';
export const CONTEXT = process.env.KUBE_CONTEXT ?? 'kind-marketplace';
export const NAMESPACE = 'marketplace';
export const APP = 'marketplace-api';
export const URL = process.env.APP_URL ?? 'http://127.0.0.1:30080';

export function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: ROOT,
    encoding: 'utf8',
    maxBuffer: 256 * 1024 * 1024,
    ...options,
  });
  return {
    status: result.status ?? 1,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
  };
}

export function must(command, args, options) {
  const result = run(command, args, options);
  if (result.status !== 0) {
    throw new Error(
      `${command} ${args.join(' ')} exited with ${result.status}\n${result.stderr || result.stdout}`,
    );
  }
  return result.stdout;
}

export function kubectl(...args) {
  return must('kubectl', ['--context', CONTEXT, '-n', NAMESPACE, ...args]);
}

export function waitForRollout(timeout = '300s') {
  kubectl('rollout', 'status', `deployment/${APP}`, `--timeout=${timeout}`);
}

export function summary(values) {
  for (const [key, value] of Object.entries(values)) {
    console.log(`${key}=${value}`);
  }
}

export function finish(ok, verdict) {
  console.log(ok ? verdict : 'DEMO CHECK FAILED');
  process.exit(ok ? 0 : 1);
}

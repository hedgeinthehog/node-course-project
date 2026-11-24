import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { must, ROOT } from './cluster.mjs';

const EVIDENCE = join(ROOT, 'evidence', 'demos.txt');

export function aws(...args) {
  return JSON.parse(must('aws', [...args, '--output', 'json']) || 'null');
}

export function stack(program, ...args) {
  return must('bash', ['scripts/aws-stack.sh', program, ...args]).trim();
}

export const demoUrn = (type, name) =>
  `urn:pulumi:${process.env.HW31_STACK ?? 'localstack'}::hw31-demo::${type}::${name}`;

export function record(values) {
  mkdirSync(join(ROOT, 'evidence'), { recursive: true });
  const kept = existsSync(EVIDENCE)
    ? readFileSync(EVIDENCE, 'utf8')
        .split('\n')
        .filter((line) => line && !(line.split('=')[0] in values))
    : [];
  const added = Object.entries(values).map(([key, value]) => `${key}=${value}`);
  writeFileSync(EVIDENCE, [...kept, ...added].join('\n') + '\n');
}

if (process.argv[1] === import.meta.filename) {
  const lines = readFileSync(0, 'utf8').split('\n');
  const wanted = new Set(process.argv.slice(2));
  record(
    Object.fromEntries(
      lines
        .map((line) => line.split('='))
        .filter(([key, value]) => wanted.has(key) && value !== undefined),
    ),
  );
}

import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { finish, ROOT, summary } from './cluster.mjs';

const OASDIFF = 'tufin/oasdiff:v1.11.7';
const FIXTURES = join(ROOT, 'demo', 'fixtures');

const exit = (command, args, options = {}) =>
  spawnSync(command, args, { cwd: ROOT, stdio: 'ignore', ...options }).status ??
  1;

const work = mkdtempSync(join(tmpdir(), 'gates-'));
const spec = readFileSync(join(ROOT, 'openapi', 'openapi.yaml'), 'utf8');
const requiredNow = 'required: [user_id, items]\n      properties:';
if (!spec.includes(requiredNow)) {
  throw new Error(
    'the CreateOrder schema changed, update the broken contract input',
  );
}
writeFileSync(join(work, 'base.yaml'), spec);
writeFileSync(join(work, 'same.yaml'), spec);
writeFileSync(
  join(work, 'breaking.yaml'),
  spec.replace(
    requiredNow,
    'required: [user_id, items, coupon]\n      properties:\n        coupon:\n          type: string',
  ),
);
const oasdiff = (revision) =>
  exit('docker', [
    'run',
    '--rm',
    '-v',
    `${work}:/specs:ro`,
    OASDIFF,
    'breaking',
    '/specs/base.yaml',
    `/specs/${revision}`,
    '--fail-on',
    'ERR',
  ]);
const depcruise = (cwd) =>
  exit(
    'npx',
    ['depcruise', 'src', '--config', join(ROOT, '.dependency-cruiser.cjs')],
    { cwd },
  );
const scan = (max) =>
  exit('npm', ['run', 'scan'], {
    env: { ...process.env, SCAN_MAX: String(max) },
  });

const result = {
  'types-ok': exit('npx', ['tsc', '--noEmit']) || exit('npm', ['run', 'lint']),
  'types-broken': exit('npx', ['tsc', '-p', join(FIXTURES, 'types-broken')]),
  'contract-ok': oasdiff('same.yaml'),
  'contract-broken': oasdiff('breaking.yaml'),
  'arch-ok': depcruise(ROOT),
  'arch-broken': depcruise(join(FIXTURES, 'arch-broken')),
  'scan-ok': scan(99999),
  'scan-broken': scan(-1),
};
rmSync(work, { recursive: true, force: true });

summary(result);
const steps = ['types', 'contract', 'arch', 'scan'];
finish(
  steps.every(
    (step) => result[`${step}-ok`] === 0 && result[`${step}-broken`] !== 0,
  ),
  'every gate passes on the correct input and fails on the broken one',
);

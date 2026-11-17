import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import {
  finish,
  must,
  ROOT,
  summary,
  URL,
  waitForRollout,
} from './cluster.mjs';

const PROFILE = process.env.PROFILE ?? 'hardened';
const MIN_REQUESTS = 5000;
const TAIL_MS = 10_000;

if (PROFILE !== 'hardened' && PROFILE !== 'naive') {
  throw new Error(`PROFILE must be hardened or naive, got "${PROFILE}"`);
}

const pulumi = (...args) =>
  must('bash', ['scripts/pulumi.sh', ...args], {
    stdio: ['ignore', 'pipe', 'pipe'],
  });

function deploy(profile, rev) {
  pulumi('config', 'set', 'profile', profile);
  if (rev) pulumi('config', 'set', 'rev', rev);
  pulumi('up');
  waitForRollout();
}

async function waitUntilSteady(needed = 40) {
  for (let streak = 0, tries = 0; streak < needed; tries++) {
    if (tries > 1200) throw new Error('the service never became steady');
    const status = await fetch(`${URL}/health`, {
      headers: { connection: 'close' },
    })
      .then((response) => response.status)
      .catch(() => 0);
    streak = status === 200 ? streak + 1 : 0;
    await sleep(100);
  }
}

const codes = (file) =>
  existsSync(file)
    ? readFileSync(file, 'utf8').split('\n').filter(Boolean)
    : [];

const work = mkdtempSync(join(tmpdir(), 'rollout-'));
const file = join(work, 'codes.txt');
let load;
let measured;
try {
  deploy(PROFILE);
  await waitUntilSteady();

  load = spawn(process.execPath, ['scripts/load.mjs', `${URL}/health`, file], {
    cwd: ROOT,
    stdio: 'inherit',
  });
  await sleep(3000);
  const before = codes(file);
  if (before.length === 0 || before.some((code) => code !== '200')) {
    throw new Error(
      `the service is not healthy before the rollout: ${before.length} responses, ${before.filter((code) => code !== '200').length} not 200`,
    );
  }

  const started = Date.now();
  deploy(PROFILE, String(started));
  const rolloutSeconds = Math.round((Date.now() - started) / 1000);

  await sleep(TAIL_MS);
  while (codes(file).length < MIN_REQUESTS + 200) await sleep(500);
  load.kill('SIGTERM');
  await new Promise((resolve) => load.once('exit', resolve));
  load = undefined;

  const all = codes(file);
  const ok = all.filter((code) => code === '200').length;
  measured = {
    requests: all.length,
    ok,
    failed: all.length - ok,
    'rollout-seconds': rolloutSeconds,
  };
} finally {
  load?.kill('SIGKILL');
  rmSync(work, { recursive: true, force: true });
  if (PROFILE !== 'hardened') deploy('hardened', String(Date.now()));
}

console.log(`profile=${PROFILE}`);
summary(measured);
if (PROFILE === 'hardened') {
  finish(
    measured.failed === 0 && measured.requests >= MIN_REQUESTS,
    'every response during the rolling update was 200',
  );
} else {
  finish(
    measured.failed > 0,
    'the naive profile dropped requests during the rolling update; the cluster is back on the hardened profile',
  );
}

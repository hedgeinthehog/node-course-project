import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import {
  APP,
  finish,
  kubectl,
  must,
  ROOT,
  summary,
  URL,
  waitForRollout,
} from './cluster.mjs';

const PROFILE = process.env.PROFILE ?? 'hardened';
const MIN_REQUESTS = 5000;
const TAIL_MS = 5000;

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

const samples = (file) =>
  existsSync(file)
    ? readFileSync(file, 'utf8')
        .split('\n')
        .filter(Boolean)
        .map((line) => {
          const [at, code] = line.split(' ');
          return { at: Number(at), code };
        })
    : [];

const failed = (list) => list.filter(({ code }) => code !== '200').length;

async function waitForOldPodsToLeave() {
  const count = (json) => JSON.parse(json).items.length;
  const { spec } = JSON.parse(kubectl('get', 'deployment', APP, '-o', 'json'));
  for (let i = 0; i < 120; i++) {
    const pods = kubectl('get', 'pods', '-l', `app=${APP}`, '-o', 'json');
    if (count(pods) === spec.replicas) return;
    await sleep(500);
  }
  throw new Error('old pods are still terminating');
}

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
  const before = samples(file);
  if (before.length === 0 || failed(before) > 0) {
    throw new Error(
      `the service is not healthy before the rollout: ${before.length} responses, ${failed(before)} not 200`,
    );
  }

  const started = Date.now();
  deploy(PROFILE, String(started));
  await waitForOldPodsToLeave();
  const finished = Date.now();

  await sleep(TAIL_MS);
  load.kill('SIGTERM');
  await new Promise((resolve) => load.once('exit', resolve));
  load = undefined;

  const all = samples(file);
  const during = all.filter(({ at }) => at >= started && at <= finished);
  const outside = all.length - during.length;
  measured = {
    requests: during.length,
    ok: during.length - failed(during),
    failed: failed(during),
    'rollout-seconds': Math.round((finished - started) / 1000),
    'outside-requests': outside,
    'outside-failed': failed(all) - failed(during),
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
    measured.failed === 0 &&
      measured['outside-failed'] === 0 &&
      measured.requests >= MIN_REQUESTS,
    `every response was 200, and at least ${MIN_REQUESTS} of them arrived while pods were being replaced`,
  );
} else {
  finish(
    measured.failed + measured['outside-failed'] > 0,
    'the naive profile dropped requests during the rolling update; the cluster is back on the hardened profile',
  );
}

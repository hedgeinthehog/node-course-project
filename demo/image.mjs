import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { finish, IMAGE, must, ROOT, run, summary } from './cluster.mjs';

const occurrences = (text, needle) => text.split(needle).length - 1;

function walk(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return walk(path);
    return entry.isFile() ? [path] : [];
  });
}

function filesWithToken(dir, token) {
  const needle = Buffer.from(token);
  return walk(dir).filter((path) => readFileSync(path).includes(needle)).length;
}

const token = readFileSync(join(ROOT, '.npm_token'), 'utf8').trim();
if (!token) throw new Error('.npm_token is empty, nothing to look for');
must('docker', ['image', 'inspect', IMAGE]);

const stages = readFileSync(join(ROOT, 'docker', 'Dockerfile'), 'utf8')
  .split('\n')
  .filter((line) => /^FROM\s/i.test(line)).length;

const shells = ['sh', '/bin/sh', 'bash', '/busybox/sh'];
const shellInside = shells.some(
  (shell) =>
    run('docker', ['run', '--rm', '--entrypoint', shell, IMAGE, '-c', 'true'])
      .status === 0,
)
  ? 1
  : 0;

const uid = run('docker', [
  'run',
  '--rm',
  IMAGE,
  '-e',
  'console.log(process.getuid())',
]).stdout.trim();

const history = must('docker', [
  'history',
  '--no-trunc',
  '--format',
  '{{json .}}',
  IMAGE,
]);
const config = must('docker', ['image', 'inspect', IMAGE]);

const work = mkdtempSync(join(tmpdir(), 'image-layers-'));
let tokenInLayers;
try {
  const archive = join(work, 'image.tar');
  must('docker', ['save', '-o', archive, IMAGE]);
  const unpacked = join(work, 'image');
  must('mkdir', ['-p', unpacked]);
  must('tar', ['-xf', archive, '-C', unpacked]);
  rmSync(archive);
  const [manifest] = JSON.parse(
    readFileSync(join(unpacked, 'manifest.json'), 'utf8'),
  );
  const layers = join(work, 'layers');
  manifest.Layers.forEach((layer, index) => {
    const target = join(layers, String(index));
    must('mkdir', ['-p', target]);
    must('tar', ['-xf', join(unpacked, layer), '-C', target]);
  });
  console.log(`unpacked ${manifest.Layers.length} layers of ${IMAGE}`);
  must('chmod', ['-R', 'u+rwX', layers]);
  tokenInLayers = filesWithToken(layers, token);
} finally {
  run('chmod', ['-R', 'u+rwX', work]);
  rmSync(work, { recursive: true, force: true });
}

const result = {
  stages,
  'shell-inside': shellInside,
  'runtime-uid': uid,
  'token-in-history': occurrences(history, token),
  'token-in-config': occurrences(config, token),
  'token-in-layers': tokenInLayers,
};
summary(result);
finish(
  stages >= 2 &&
    shellInside === 0 &&
    uid !== '' &&
    uid !== '0' &&
    result['token-in-history'] === 0 &&
    result['token-in-config'] === 0 &&
    tokenInLayers === 0,
  'multi-stage image without a shell, running as a non-root uid; the build secret is in neither history, config nor layers',
);

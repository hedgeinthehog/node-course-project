import { spawnSync } from 'node:child_process';

const image = process.env.SCAN_IMAGE ?? 'marketplace-api:local';
const severity = process.env.SCAN_SEVERITY ?? 'CRITICAL,HIGH';
const maxAllowed = Number(process.env.SCAN_MAX ?? 20);
const TRIVY_IMAGE = 'aquasec/trivy:0.67.2';

if (!Number.isFinite(maxAllowed)) {
  console.error(
    `scan: SCAN_MAX must be a number, got "${process.env.SCAN_MAX}"`,
  );
  process.exit(2);
}

const args = [
  'image',
  '--quiet',
  '--format',
  'json',
  '--scanners',
  'vuln',
  '--ignore-unfixed',
  '--severity',
  severity,
  image,
];
const local =
  spawnSync('trivy', ['--version'], { stdio: 'ignore' }).status === 0;
const run = local
  ? spawnSync('trivy', args, { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 })
  : spawnSync(
      'docker',
      [
        'run',
        '--rm',
        '-v',
        '/var/run/docker.sock:/var/run/docker.sock',
        '-v',
        'trivy-cache:/root/.cache/',
        TRIVY_IMAGE,
        ...args,
      ],
      { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 },
    );

let report;
try {
  report = JSON.parse(run.stdout);
} catch {
  console.error(run.stderr || run.stdout);
  console.error(`scan: the scanner produced no report (exit ${run.status})`);
  process.exit(2);
}

const findings = (report.Results ?? []).flatMap(
  (result) => result.Vulnerabilities ?? [],
);
for (const level of severity.split(',')) {
  console.log(
    `${level.toLowerCase()}=${findings.filter((f) => f.Severity === level).length}`,
  );
}
const found = findings.length;
const pass = found <= maxAllowed;
console.log(`image=${image}`);
console.log(`severity=${severity}`);
console.log(`found=${found}`);
console.log(`max-allowed=${maxAllowed}`);
console.log(`gate=${pass ? 'pass' : 'fail'}`);
process.exit(pass ? 0 : 1);

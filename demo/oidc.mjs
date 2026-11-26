import { execFile } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { exportJWK, generateKeyPair, SignJWT } from 'jose';
import { finish, ROOT } from './cluster.mjs';

const realPolicy = JSON.parse(
  readFileSync(join(ROOT, 'oidc', 'policy.json'), 'utf8'),
);
const { publicKey, privateKey } = await generateKeyPair('RS256');
const kid = 'demo-key';
const jwks = {
  keys: [{ ...(await exportJWK(publicKey)), kid, alg: 'RS256', use: 'sig' }],
};

const server = createServer((request, response) => {
  const issuer = `http://127.0.0.1:${server.address().port}`;
  const body =
    request.url === '/.well-known/openid-configuration'
      ? { issuer, jwks_uri: `${issuer}/jwks` }
      : jwks;
  response.setHeader('content-type', 'application/json');
  response.end(JSON.stringify(body));
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const issuer = `http://127.0.0.1:${server.address().port}`;

const work = mkdtempSync(join(tmpdir(), 'oidc-demo-'));
const policyFile = join(work, 'policy.json');
writeFileSync(policyFile, JSON.stringify({ ...realPolicy, iss: issuer }));

const sign = (sub) =>
  new SignJWT({ sub })
    .setProtectedHeader({ alg: 'RS256', kid })
    .setIssuer(issuer)
    .setAudience(realPolicy.aud)
    .setIssuedAt()
    .setExpirationTime('5m')
    .sign(privateKey);

const green = await sign(realPolicy.sub[0]);
const [header, payload, signature] = green.split('.');
const flipped = signature.startsWith('A') ? 'B' : 'A';
const cases = {
  green,
  'foreign-sub': await sign('repo:someone-else/their-repo:pull_request'),
  'bad-signature': `${header}.${payload}.${flipped}${signature.slice(1)}`,
};

const seen = {};
for (const [name, token] of Object.entries(cases)) {
  const gate = await new Promise((resolve) =>
    execFile(
      process.execPath,
      ['scripts/oidc-gate.mjs'],
      {
        cwd: ROOT,
        env: { ...process.env, OIDC_TOKEN: token, OIDC_POLICY: policyFile },
      },
      (error, stdout) => resolve({ stdout, status: error ? error.code : 0 }),
    ),
  );
  console.log(`case=${name}`);
  process.stdout.write(gate.stdout);
  console.log(`gate-exit=${gate.status}`);
  const read = (key) =>
    new RegExp(`^${key}=(\\d)$`, 'm').exec(gate.stdout)?.[1];
  seen[name] = `${read('sig-verified')}${read('policy-allow')}`;
}
server.close();
rmSync(work, { recursive: true, force: true });

console.log('case=summary');
finish(
  seen.green === '11' &&
    seen['foreign-sub'] === '10' &&
    seen['bad-signature'] === '00',
  'the gate admits its own repository, refuses a foreign sub with a valid signature, and refuses a broken signature',
);

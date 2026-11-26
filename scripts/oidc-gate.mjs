import { readFileSync } from 'node:fs';
import { createRemoteJWKSet, decodeJwt, jwtVerify } from 'jose';

const token = process.env.OIDC_TOKEN;
const policyFile = process.env.OIDC_POLICY ?? 'oidc/policy.json';
if (!token) {
  console.error('oidc-gate: OIDC_TOKEN is not set');
  process.exit(2);
}
const policy = JSON.parse(readFileSync(policyFile, 'utf8'));
const discoveryUrl =
  process.env.OIDC_DISCOVERY_URL ??
  `${policy.iss}/.well-known/openid-configuration`;

const discovery = await fetch(discoveryUrl).then((response) => {
  if (!response.ok)
    throw new Error(`${discoveryUrl} answered ${response.status}`);
  return response.json();
});
const keys = createRemoteJWKSet(new URL(discovery.jwks_uri));

let claims;
let signatureVerified = 0;
try {
  ({ payload: claims } = await jwtVerify(token, keys));
  signatureVerified = 1;
} catch (err) {
  console.log(`rejected=${err.code ?? err.message}`);
  try {
    claims = decodeJwt(token);
  } catch {
    claims = {};
  }
}

const audiences = [claims.aud].flat();
const allowed =
  signatureVerified === 1 &&
  claims.iss === policy.iss &&
  audiences.includes(policy.aud) &&
  policy.sub.includes(claims.sub);

console.log(`iss=${claims.iss ?? ''}`);
console.log(`aud=${audiences.join(',')}`);
console.log(`sub=${claims.sub ?? ''}`);
console.log(`sig-verified=${signatureVerified}`);
console.log(`policy-allow=${allowed ? 1 : 0}`);
process.exit(allowed ? 0 : 1);

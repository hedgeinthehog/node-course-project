import { generateKeyPairSync, randomBytes } from 'node:crypto';

const kid = process.argv[2] ?? 'dev';
const { privateKey, publicKey } = generateKeyPairSync('ec', {
  namedCurve: 'P-256',
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  publicKeyEncoding: { type: 'spki', format: 'pem' },
});
console.log(`JWT_KID=${kid}`);
console.log(`JWT_PRIVATE_KEY=${Buffer.from(privateKey).toString('base64')}`);
console.log(`JWT_PUBLIC_KEYS=${kid}:${Buffer.from(publicKey).toString('base64')}`);
console.log(`REFRESH_TOKEN_PEPPER=${randomBytes(32).toString('base64url')}`);

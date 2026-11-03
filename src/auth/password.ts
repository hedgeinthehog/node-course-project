import { randomBytes, scrypt, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';

const scryptAsync = promisify(scrypt);
const KEY_LENGTH = 64;

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const hash = (await scryptAsync(password, salt, KEY_LENGTH)) as Buffer;
  return `scrypt:${salt.toString('base64url')}:${hash.toString('base64url')}`;
}

export async function verifyPassword(
  password: string,
  stored: string | null,
): Promise<boolean> {
  if (!stored) return false;
  const [scheme, salt, expected] = stored.split(':');
  if (scheme !== 'scrypt' || !salt || !expected) return false;
  const hash = (await scryptAsync(
    password,
    Buffer.from(salt, 'base64url'),
    KEY_LENGTH,
  )) as Buffer;
  const known = Buffer.from(expected, 'base64url');
  return known.length === hash.length && timingSafeEqual(known, hash);
}

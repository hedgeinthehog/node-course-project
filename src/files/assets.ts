import { createHash } from 'node:crypto';
import { Storage } from './storage';

export const ASSETS_PREFIX = 'assets/';
export const IMMUTABLE_CACHE_CONTROL = 'public, max-age=31536000, immutable';

export function assetKey(name: string, content: Buffer): string {
  const dot = name.lastIndexOf('.');
  const base = dot > 0 ? name.slice(0, dot) : name;
  const extension = dot > 0 ? name.slice(dot) : '';
  const hash = createHash('sha256').update(content).digest('hex').slice(0, 8);
  return `${ASSETS_PREFIX}${base}.${hash}${extension}`;
}

export async function publishAsset(
  storage: Storage,
  name: string,
  content: Buffer,
  contentType: string,
): Promise<string> {
  const key = assetKey(name, content);
  await storage.put(key, content, contentType, IMMUTABLE_CACHE_CONTROL);
  return key;
}

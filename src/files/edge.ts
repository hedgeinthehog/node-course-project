import { createServer, Server, ServerResponse } from 'node:http';
import { Storage } from './storage';

export const EDGE_CACHE_MAX_BYTES = 64 * 1024 * 1024;

interface CachedObject {
  body: Buffer;
  contentType?: string;
  cacheControl: string;
  etag: string;
  expiresAt: number;
}

class ByteLru {
  private readonly entries = new Map<string, CachedObject>();
  private bytes = 0;

  constructor(private readonly maxBytes: number) {}

  get(key: string): CachedObject | undefined {
    const entry = this.entries.get(key);
    if (!entry) return undefined;
    this.remove(key, entry);
    if (entry.expiresAt <= Date.now()) return undefined;
    this.add(key, entry);
    return entry;
  }

  set(key: string, entry: CachedObject) {
    const previous = this.entries.get(key);
    if (previous) this.remove(key, previous);
    if (entry.body.length > this.maxBytes) return;
    this.add(key, entry);
    for (const [oldest, victim] of this.entries) {
      if (this.bytes <= this.maxBytes) break;
      this.remove(oldest, victim);
    }
  }

  private add(key: string, entry: CachedObject) {
    this.entries.set(key, entry);
    this.bytes += entry.body.length;
  }

  private remove(key: string, entry: CachedObject) {
    this.entries.delete(key);
    this.bytes -= entry.body.length;
  }
}

function send(
  res: ServerResponse,
  object: CachedObject,
  verdict: 'HIT' | 'MISS',
  withBody: boolean,
) {
  res.writeHead(200, {
    'Content-Type': object.contentType ?? 'application/octet-stream',
    'Content-Length': object.body.length,
    'Cache-Control': object.cacheControl,
    ETag: object.etag,
    'X-Cache': verdict,
  });
  res.end(withBody ? object.body : undefined);
}

function objectKey(url: string | undefined): string | null {
  try {
    return decodeURIComponent(
      new URL(url ?? '/', 'http://edge').pathname.slice(1),
    );
  } catch {
    return null;
  }
}

export function createEdge(
  storage: Storage,
  options: { maxBytes?: number } = {},
): Server {
  const cache = new ByteLru(options.maxBytes ?? EDGE_CACHE_MAX_BYTES);
  return createServer(async (req, res) => {
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.writeHead(405, { Allow: 'GET, HEAD' }).end();
      return;
    }
    const withBody = req.method === 'GET';
    const key = objectKey(req.url);
    if (!key) {
      res.writeHead(key === null ? 400 : 404).end();
      return;
    }
    const cached = cache.get(key);
    if (cached) {
      send(res, cached, 'HIT', withBody);
      return;
    }
    const object = await storage.get(key).catch(() => undefined);
    if (object === undefined) {
      res.writeHead(502, { 'X-Cache': 'MISS' }).end();
      return;
    }
    if (object === null) {
      res.writeHead(404, { 'X-Cache': 'MISS' }).end();
      return;
    }
    const maxAge = Number(
      /max-age=(\d+)/.exec(object.cacheControl ?? '')?.[1] ?? 0,
    );
    const entry: CachedObject = {
      body: object.body,
      contentType: object.contentType,
      cacheControl: object.cacheControl ?? 'no-store',
      etag: object.etag,
      expiresAt: Date.now() + maxAge * 1000,
    };
    if (maxAge > 0) cache.set(key, entry);
    send(res, entry, 'MISS', withBody);
  });
}

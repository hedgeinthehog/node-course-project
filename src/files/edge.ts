import { createServer, Server, ServerResponse } from 'node:http';
import { Storage } from './storage';

interface CachedObject {
  body: Buffer;
  contentType?: string;
  cacheControl: string;
  etag: string;
  expiresAt: number;
}

function send(
  res: ServerResponse,
  object: CachedObject,
  verdict: 'HIT' | 'MISS',
) {
  res.writeHead(200, {
    'Content-Type': object.contentType ?? 'application/octet-stream',
    'Content-Length': object.body.length,
    'Cache-Control': object.cacheControl,
    ETag: object.etag,
    'X-Cache': verdict,
  });
  res.end(object.body);
}

export function createEdge(storage: Storage): Server {
  const cache = new Map<string, CachedObject>();
  return createServer(async (req, res) => {
    const key = decodeURIComponent(
      new URL(req.url ?? '/', 'http://edge').pathname.slice(1),
    );
    if (req.method !== 'GET' || !key) {
      res.writeHead(req.method === 'GET' ? 404 : 405).end();
      return;
    }
    const cached = cache.get(key);
    if (cached && cached.expiresAt > Date.now()) {
      send(res, cached, 'HIT');
      return;
    }
    cache.delete(key);
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
    send(res, entry, 'MISS');
  });
}

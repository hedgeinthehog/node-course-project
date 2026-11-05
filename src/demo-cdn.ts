import type { AddressInfo } from 'node:net';
import { finish, summary } from './events/demo-harness';
import { ASSETS_PREFIX, publishAsset } from './files/assets';
import { createEdge } from './files/edge';
import { Storage } from './files/storage';

const NAME = 'demo.css';

async function main() {
  const storage = Storage.fromEnv();
  await storage.ensureBucket();
  await storage.deleteAll(await storage.list(`${ASSETS_PREFIX}demo.`));

  const v1 = Buffer.from('body { color: #111; }\n');
  const v2 = Buffer.from('body { color: #eee; }\n');
  const first = await publishAsset(storage, NAME, v1, 'text/css');

  const edge = createEdge(storage);
  await new Promise<void>((resolve) => edge.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${(edge.address() as AddressInfo).port}`;

  const direct = await fetch(storage.objectUrl(first));
  await direct.text();
  const miss = await fetch(`${base}/${first}`);
  const missBody = await miss.text();
  const hit = await fetch(`${base}/${first}`);
  await hit.text();

  const second = await publishAsset(storage, NAME, v2, 'text/css');
  const fresh = await fetch(`${base}/${second}`);
  const freshBody = await fresh.text();
  const oldAgain = await fetch(`${base}/${first}`);
  const oldBody = await oldAgain.text();

  await new Promise<void>((resolve) => edge.close(() => resolve()));
  await storage.deleteAll([first, second]);

  console.log(`published ${first} then ${second}`);
  summary({
    direct: direct.status,
    'edge-miss': miss.status,
    'edge-hit': hit.status,
    'cache-hit': hit.headers.get('x-cache') === 'HIT' ? 1 : 0,
    'immutable-cache-control': miss.headers
      .get('cache-control')
      ?.includes('immutable')
      ? 1
      : 0,
    'new-name': second !== first ? 1 : 0,
    'new-url': fresh.status,
    'content-changed':
      freshBody !== missBody && freshBody === v2.toString() ? 1 : 0,
    'old-url-still-hit':
      oldAgain.headers.get('x-cache') === 'HIT' && oldBody === v1.toString()
        ? 1
        : 0,
    invalidations: 0,
  });
  finish(
    direct.status === 403 &&
      miss.status === 200 &&
      miss.headers.get('x-cache') === 'MISS' &&
      hit.status === 200 &&
      hit.headers.get('x-cache') === 'HIT' &&
      second !== first &&
      fresh.status === 200 &&
      freshBody === v2.toString(),
    'the bucket is closed, the edge served the second read from cache, the new version came under a new name without any invalidation',
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

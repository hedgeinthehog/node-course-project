import Redis from 'ioredis';
import { parseRedisUrls } from './config/env.schema';
import { DataSource } from 'typeorm';
import { dataSourceOptions } from './data-source';
import { login, newAccount } from './auth/demo-accounts';
import { finish, sleep, summary } from './events/demo-harness';
import { bootApi } from './redis/demo-api';
import { SessionStore } from './redis/session.store';

const PAUSE_MS = 2000;

interface SessionBody {
  session_id: string;
  user_id: number;
  expires_in: number;
}

async function main() {
  const dataSource = await new DataSource(dataSourceOptions).initialize();
  const buyer = await newAccount(dataSource, 'buyer');
  await dataSource.destroy();
  const redis = new Redis(parseRedisUrls(process.env).queue);
  const [, policy] = (await redis.config(
    'GET',
    'maxmemory-policy',
  )) as string[];

  let api = await bootApi();
  const token = (await login(api.url, buyer)).body.access_token as string;
  const seen = new Set<string>();
  let requests = 0;
  const call = async (path: string, init: RequestInit) => {
    requests++;
    const response = await fetch(`${api.url}${path}`, init);
    const body = (await response.json()) as SessionBody;
    if (body.session_id) seen.add(body.session_id);
    return { status: response.status, body };
  };

  const created = await call('/sessions', {
    method: 'POST',
    headers: { authorization: `Bearer ${token}` },
  });
  const sessionId = created.body.session_id;
  const key = SessionStore.key(sessionId);
  const inRedis = await redis.exists(key);

  await sleep(PAUSE_MS);
  const ttlBefore = await redis.ttl(key);
  const me = () =>
    call('/sessions/me', { headers: { 'x-session-id': sessionId } });
  const first = await me();
  const ttlAfter = await redis.ttl(key);
  await sleep(PAUSE_MS);
  const second = await me();

  await api.close();
  api = await bootApi();
  const afterRestart = await me();
  await api.close();

  await redis.quit();

  summary({
    requests,
    sessions: seen.size,
    'in-redis': inRedis,
    'state-noeviction': policy === 'noeviction' ? 1 : 0,
    'ttl-before': ttlBefore,
    'ttl-after': ttlAfter,
    'ttl-renewed': ttlAfter > ttlBefore ? 1 : 0,
    'survives-restart': afterRestart.status === 200 ? 1 : 0,
  });
  finish(
    requests >= 3 &&
      seen.size === 1 &&
      inRedis === 1 &&
      ttlAfter > ttlBefore &&
      [created, first, second, afterRestart].every((r) =>
        [200, 201].includes(r.status),
      ),
    'one session lived in Redis, renewed its TTL on activity and survived an API restart',
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

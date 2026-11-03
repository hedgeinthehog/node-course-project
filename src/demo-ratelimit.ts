import Redis from 'ioredis';
import { parseRedisUrls } from './config/env.schema';
import { finish, summary } from './events/demo-harness';
import { bootApi } from './redis/demo-api';
import { RateLimiter } from './redis/rate-limiter';

const LIMIT = 5;
const WINDOW_MS = 10_000;
const INSTANCES = 2;
const CLIENT = 'demo-ratelimit';

async function main() {
  const redis = new Redis(parseRedisUrls(process.env).queue);
  await redis.del(RateLimiter.key(`user:${CLIENT}`));

  const apis = [];
  for (let i = 0; i < INSTANCES; i++) {
    apis.push(
      await bootApi({
        RATE_LIMIT: String(LIMIT),
        RATE_LIMIT_WINDOW_MS: String(WINDOW_MS),
      }),
    );
  }

  const total = LIMIT + 3;
  let allowed = 0;
  let blocked = 0;
  let lastBlocked: Response | null = null;
  for (let i = 0; i < total; i++) {
    const response = await fetch(
      `${apis[i % INSTANCES].url}/products?limit=1`,
      {
        headers: { 'x-user-id': CLIENT },
      },
    );
    if (response.status === 429) {
      blocked++;
      lastBlocked = response;
    } else {
      allowed++;
    }
  }
  const retryAfter = lastBlocked?.headers.get('retry-after') ?? null;
  const problem = lastBlocked ? await lastBlocked.json() : null;
  console.log(`last blocked response: ${JSON.stringify(problem)}`);

  for (const api of apis) await api.close();
  await redis.quit();

  summary({
    instances: INSTANCES,
    limit: LIMIT,
    'window-ms': WINDOW_MS,
    requests: total,
    allowed,
    blocked,
    status: lastBlocked?.status ?? 0,
    'retry-after': retryAfter !== null && Number(retryAfter) >= 1 ? 1 : 0,
    'retry-after-seconds': Number(retryAfter ?? 0),
  });
  finish(
    allowed === LIMIT &&
      blocked === total - LIMIT &&
      lastBlocked?.status === 429 &&
      retryAfter !== null &&
      Number(retryAfter) >= 1,
    'two API instances shared one sliding-window limit and answered 429 with Retry-After',
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

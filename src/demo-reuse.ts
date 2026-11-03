import { DataSource } from 'typeorm';
import { call, login, newAccount } from './auth/demo-accounts';
import { dataSourceOptions } from './data-source';
import { finish, summary } from './events/demo-harness';
import { bootApi } from './redis/demo-api';

async function main() {
  const dataSource = await new DataSource(dataSourceOptions).initialize();
  const buyer = await newAccount(dataSource, 'buyer');
  const api = await bootApi();

  const logged = await login(api.url, buyer);
  const r0 = logged.body;
  const r1 = await call(api.url, 'POST', '/auth/refresh', {
    body: { refresh_token: r0.refresh_token },
  });
  const r1Reuse = await call(api.url, 'POST', '/auth/refresh', {
    body: { refresh_token: r0.refresh_token },
  });
  const r2AfterReuse = await call(api.url, 'POST', '/auth/refresh', {
    body: { refresh_token: r1.body.refresh_token },
  });
  const accessAfterReuse = await call(api.url, 'GET', '/orders', {
    token: r1.body.access_token,
  });
  const [{ revoked, total }]: { revoked: number; total: number }[] =
    await dataSource.query(
      `SELECT count(revoked_at)::int AS revoked, count(*)::int AS total
       FROM refresh_tokens WHERE user_id = $1`,
      [buyer.id],
    );
  await api.close();
  await dataSource.destroy();

  summary({
    login: logged.status,
    'r1-refresh': r1.status,
    'r1-reuse': r1Reuse.status,
    'r2-after-reuse': r2AfterReuse.status,
    'access-after-reuse': accessAfterReuse.status,
    'family-tokens': total,
    'family-revoked': revoked,
  });
  finish(
    logged.status === 200 &&
      r1.status === 200 &&
      r1Reuse.status === 401 &&
      r2AfterReuse.status === 401 &&
      accessAfterReuse.status === 401 &&
      total === 2 &&
      revoked === total,
    'reusing a rotated refresh token revoked the whole family, including the honest client',
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

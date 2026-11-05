import { DataSource } from 'typeorm';
import { call, login, newAccount } from './auth/demo-accounts';
import { dataSourceOptions } from './data-source';
import { finish, summary } from './events/demo-harness';
import { bootApi } from './redis/demo-api';

async function main() {
  const dataSource = await new DataSource(dataSourceOptions).initialize();
  const buyer = await newAccount(dataSource, 'buyer');
  await dataSource.destroy();
  const api = await bootApi();

  const logged = await login(api.url, buyer);
  const first = logged.body;
  const noToken = await call(api.url, 'GET', '/orders');
  const withToken = await call(api.url, 'GET', '/orders', {
    token: first.access_token,
  });
  const refreshed = await call(api.url, 'POST', '/auth/refresh', {
    body: { refresh_token: first.refresh_token },
  });
  const second = refreshed.body;
  const rotatedAccess = await call(api.url, 'GET', '/orders', {
    token: second.access_token,
  });
  const logout = await call(api.url, 'POST', '/auth/logout', {
    token: second.access_token,
  });
  const afterLogout = await call(api.url, 'GET', '/orders', {
    token: second.access_token,
  });
  const oldAccessAfterLogout = await call(api.url, 'GET', '/orders', {
    token: first.access_token,
  });
  const refreshAfterLogout = await call(api.url, 'POST', '/auth/refresh', {
    body: { refresh_token: second.refresh_token },
  });
  const relogin = await login(api.url, buyer);
  await api.close();

  summary({
    login: logged.status,
    'no-token': noToken.status,
    'with-token': withToken.status,
    refresh: refreshed.status,
    'rotated-access': rotatedAccess.status,
    logout: logout.status,
    'after-logout': afterLogout.status,
    'old-access-after-logout': oldAccessAfterLogout.status,
    'refresh-after-logout': refreshAfterLogout.status,
    relogin: relogin.status,
  });
  finish(
    logged.status === 200 &&
      noToken.status === 401 &&
      withToken.status === 200 &&
      refreshed.status === 200 &&
      rotatedAccess.status === 200 &&
      logout.status === 204 &&
      afterLogout.status === 401 &&
      oldAccessAfterLogout.status === 401 &&
      refreshAfterLogout.status === 401 &&
      relogin.status === 200,
    'logout killed both the refresh family and the access token; a fresh login still works',
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

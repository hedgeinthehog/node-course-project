import { randomUUID } from 'node:crypto';
import { DataSource } from 'typeorm';
import { call, login, newAccount } from './auth/demo-accounts';
import { dataSourceOptions } from './data-source';
import { finish, sleep, summary } from './events/demo-harness';
import {
  cleanupOwner,
  portAlive,
  putWithoutCredentials,
} from './files/demo-files';
import { Storage } from './files/storage';
import { bootApi } from './redis/demo-api';

const SIZE = 64 * 1024;
const CONTENT_TYPE = 'image/png';

async function main() {
  const storage = Storage.fromEnv();
  await storage.ensureBucket();
  const dataSource = await new DataSource(dataSourceOptions).initialize();
  const buyer = await newAccount(dataSource, 'buyer');
  const bytes = Buffer.alloc(SIZE, 0x42);

  let api = await bootApi();
  const token: string = (await login(api.url, buyer)).body.access_token;
  const intentKey = randomUUID();
  const body = {
    filename: '../../etc/passwd',
    content_type: CONTENT_TYPE,
    size: SIZE,
  };
  const intent = await call(api.url, 'POST', '/uploads/intent', {
    token,
    body,
    headers: { 'idempotency-key': intentKey },
  });
  const replay = await call(api.url, 'POST', '/uploads/intent', {
    token,
    body,
    headers: { 'idempotency-key': intentKey },
  });
  const plan = intent.body;
  const key: string = plan.key ?? '';
  const keyFromServer =
    new RegExp(`^uploads/${buyer.id}/[0-9a-f-]{36}\\.png$`).test(key) &&
    !key.includes('passwd') &&
    !key.includes('..')
      ? 1
      : 0;
  console.log(`object key: ${key}`);
  const empty = await call(api.url, 'POST', '/uploads/intent', {
    token,
    body: {
      filename: 'never-uploaded.png',
      content_type: CONTENT_TYPE,
      size: SIZE,
    },
    headers: { 'idempotency-key': randomUUID() },
  });

  const url: string = plan.upload.url;
  const tampered = await fetch(url.replace(/[0-9a-f-]{36}\.png/, 'evil.png'), {
    method: 'PUT',
    headers: { 'content-type': CONTENT_TYPE },
    body: bytes,
  });
  await tampered.text();
  const shortLived = await storage.presignPut(
    `uploads/${buyer.id}/expired-check.png`,
    CONTENT_TYPE,
    1,
  );
  await sleep(2500);
  const expired = await fetch(shortLived, {
    method: 'PUT',
    headers: { 'content-type': CONTENT_TYPE },
    body: bytes,
  });
  await expired.text();

  const port = Number(new URL(api.url).port);
  await api.close();
  const apiAlive = (await portAlive(port)) ? 1 : 0;
  const putOffline = await putWithoutCredentials(url, CONTENT_TYPE, bytes);

  api = await bootApi();
  const commit = await call(
    api.url,
    'POST',
    `/uploads/${plan.file_id}/commit`,
    { token },
  );
  const commitWithoutBytes = await call(
    api.url,
    'POST',
    `/uploads/${empty.body.file_id}/commit`,
    { token },
  );
  const download = await fetch(`${api.url}/files/${plan.file_id}`, {
    headers: { authorization: `Bearer ${token}` },
    redirect: 'manual',
  });
  await download.text();
  let downloadedBytesMatch = 0;
  if (download.status === 302) {
    const fetched = await fetch(download.headers.get('location')!);
    downloadedBytesMatch = Buffer.from(await fetched.arrayBuffer()).equals(
      bytes,
    )
      ? 1
      : 0;
  }
  await api.close();
  await cleanupOwner(storage, dataSource, buyer.id);
  await dataSource.destroy();

  summary({
    intent: intent.status,
    'intent-replay':
      replay.headers.get('idempotency-replay') === 'true' &&
      replay.body?.file_id === plan.file_id
        ? 1
        : 0,
    'key-from-server': keyFromServer,
    'api-alive': apiAlive,
    'put-offline': putOffline,
    commit: commit.status,
    'size-match': commit.body?.size === SIZE ? 1 : 0,
    'commit-without-bytes': commitWithoutBytes.status,
    tampered: tampered.status,
    expired: expired.status,
    download: download.status,
    'download-bytes-match': downloadedBytesMatch,
  });
  finish(
    intent.status === 200 &&
      keyFromServer === 1 &&
      apiAlive === 0 &&
      putOffline === 200 &&
      commit.status === 200 &&
      commitWithoutBytes.status >= 400 &&
      commitWithoutBytes.status < 500 &&
      tampered.status === 403 &&
      expired.status === 403,
    'bytes reached the bucket while the API was down; commit checked the object; tampered and expired URLs were refused',
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { DataSource } from 'typeorm';
import { call, login, newAccount } from './auth/demo-accounts';
import { dataSourceOptions } from './data-source';
import { finish, summary } from './events/demo-harness';
import { cleanupOwner, UPLOADS_PREFIX } from './files/demo-files';
import { Storage } from './files/storage';
import { MiB, MIN_PART_SIZE } from './files/upload-policy';
import { bootApi } from './redis/demo-api';

const SIZE = 2 * MIN_PART_SIZE + MiB;

const partBytes = (partNumber: number, length: number) =>
  Buffer.alloc(length, partNumber);

async function client(
  api: string,
  token: string,
  fileId: string,
  crashAfter: number,
) {
  const plan = await call(api, 'GET', `/uploads/${fileId}/parts`, { token });
  if (plan.status !== 200) throw new Error(`parts: ${plan.status}`);
  const { part_size, size, parts } = plan.body;
  const uploaded: number[] = [];
  for (const part of parts as { part_number: number; url: string }[]) {
    const length = Math.min(
      part_size,
      size - (part.part_number - 1) * part_size,
    );
    const response = await fetch(part.url, {
      method: 'PUT',
      body: partBytes(part.part_number, length),
    });
    await response.text();
    if (response.status !== 200)
      throw new Error(`part ${part.part_number}: ${response.status}`);
    uploaded.push(part.part_number);
    if (uploaded.length === crashAfter) process.kill(process.pid, 'SIGKILL');
  }
  console.log(JSON.stringify({ uploaded }));
}

function runClient(
  api: string,
  token: string,
  fileId: string,
  crashAfter: number,
) {
  return new Promise<{ uploaded: number[]; signal: string | null }>(
    (resolve, reject) => {
      const child = spawn(
        process.execPath,
        [process.argv[1], 'client', api, token, fileId, String(crashAfter)],
        { stdio: ['ignore', 'pipe', 'inherit'] },
      );
      let out = '';
      child.stdout.on('data', (chunk) => (out += chunk));
      child.on('error', reject);
      child.on('exit', (code, signal) => {
        if (signal) return resolve({ uploaded: [], signal });
        if (code !== 0) return reject(new Error(`client exited with ${code}`));
        resolve({ uploaded: JSON.parse(out).uploaded, signal: null });
      });
    },
  );
}

async function main() {
  const storage = Storage.fromEnv();
  await storage.ensureBucket();
  const stale = await storage.listMultipartUploads(UPLOADS_PREFIX);
  for (const upload of stale)
    await storage.abortMultipart(upload.key, upload.uploadId);
  const dataSource = await new DataSource(dataSourceOptions).initialize();
  const buyer = await newAccount(dataSource, 'buyer');
  const api = await bootApi();
  const token: string = (await login(api.url, buyer)).body.access_token;

  const intent = await call(api.url, 'POST', '/uploads/intent', {
    token,
    body: {
      filename: 'marketplace.dump',
      content_type: 'application/octet-stream',
      size: SIZE,
    },
    headers: { 'idempotency-key': randomUUID() },
  });
  const plan = intent.body;
  const upload = plan.upload ?? {};
  console.log(
    `object key: ${plan.key}, upload ${upload.type}, part_size=${upload.part_size}`,
  );

  const crashed = await runClient(api.url, token, plan.file_id, 2);
  const afterCrash = await storage.listParts(plan.key, upload.upload_id);
  const headBefore = await storage.head(plan.key);
  const resumed = await runClient(api.url, token, plan.file_id, 0);
  const complete = await call(
    api.url,
    'POST',
    `/uploads/${plan.file_id}/commit`,
    { token },
  );
  const headAfter = await storage.head(plan.key);
  await api.close();

  const etag: string = (complete.body?.etag ?? '').replace(/"/g, '');
  const whole = Buffer.concat(
    [1, 2, 3].map((n) =>
      partBytes(
        n,
        Math.min(upload.part_size, SIZE - (n - 1) * upload.part_size),
      ),
    ),
  );
  const md5 = createHash('md5').update(whole).digest('hex');
  await cleanupOwner(storage, dataSource, buyer.id);
  await dataSource.destroy();

  summary({
    'stale-uploads-aborted': stale.length,
    intent: intent.status,
    'part-size': upload.part_size ?? 0,
    'parts-planned': upload.parts?.length ?? 0,
    'crash-signal': crashed.signal === 'SIGKILL' ? 1 : 0,
    'parts-after-crash': afterCrash.length,
    'head-before-complete': headBefore ? 200 : 404,
    'resumed-parts': resumed.uploaded.length,
    complete: complete.status,
    'size-match':
      headAfter?.size === SIZE && complete.body?.size === SIZE ? 1 : 0,
    'etag-multipart': /-\d+$/.test(etag) ? 1 : 0,
    'etag-is-md5': etag === md5 ? 1 : 0,
  });
  finish(
    intent.status === 200 &&
      upload.parts?.length === 3 &&
      afterCrash.length === 2 &&
      headBefore === null &&
      resumed.uploaded.length === 1 &&
      complete.status === 200 &&
      headAfter?.size === SIZE &&
      etag.endsWith('-3'),
    'the second process uploaded only the missing part; the object appeared at complete with a multipart ETag',
  );
}

if (process.argv[2] === 'client') {
  const [api, token, fileId, crashAfter] = process.argv.slice(3);
  client(api, token, fileId, Number(crashAfter)).catch((err) => {
    console.error(err);
    process.exit(1);
  });
} else {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}

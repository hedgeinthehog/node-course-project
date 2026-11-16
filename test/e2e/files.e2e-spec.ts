import { randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { NestExpressApplication } from '@nestjs/platform-express';
import request from 'supertest';
import { DataSource } from 'typeorm';
import { StoredFile } from '../../src/entities/stored-file.entity';
import { publishAsset } from '../../src/files/assets';
import { createEdge } from '../../src/files/edge';
import { Storage } from '../../src/files/storage';
import { MiB, MIN_PART_SIZE } from '../../src/files/upload-policy';
import { given } from '../integration/testkit/builders';
import { resetDatabase } from '../integration/testkit/database';
import { bearer } from './auth-helpers';
import { createApp } from './create-app';

const PNG_SIGNATURE = Buffer.from('\x89PNG\r\n\x1a\n', 'latin1');

async function put(url: string, body: Buffer, contentType?: string) {
  const response = await fetch(url, {
    method: 'PUT',
    body: new Uint8Array(body),
    headers: contentType ? { 'content-type': contentType } : {},
  });
  await response.text();
  return response.status;
}

describe('files (e2e)', () => {
  let app: NestExpressApplication;
  let dataSource: DataSource;
  let storage: Storage;
  const api = () => request(app.getHttpServer());

  beforeAll(async () => {
    app = await createApp();
    dataSource = app.get(DataSource);
    storage = app.get(Storage);
  });
  afterAll(() => app.close());
  beforeEach(() => resetDatabase(dataSource));

  it('reserves a server-made key, takes the bytes straight into the bucket and commits only what exists', async () => {
    const { user } = given(dataSource);
    const buyer = await user();
    const stranger = await user();
    const asBuyer = await bearer(app, buyer);
    const asStranger = await bearer(app, stranger);
    const bytes = Buffer.concat([PNG_SIGNATURE, Buffer.alloc(2040, 7)]);
    const body = {
      filename: '../../etc/passwd',
      content_type: 'image/png',
      size: bytes.length,
    };

    const intent = await api()
      .post('/uploads/intent')
      .set(asBuyer)
      .set('Idempotency-Key', 'up-1')
      .send(body)
      .expect(200);
    expect(intent.body.key).toMatch(
      new RegExp(`^uploads/${buyer.id}/[0-9a-f-]{36}\\.png$`),
    );
    expect(intent.body).toMatchObject({
      expires_in: 300,
      upload: { type: 'single' },
    });
    const replay = await api()
      .post('/uploads/intent')
      .set(asBuyer)
      .set('Idempotency-Key', 'up-1')
      .send(body)
      .expect(200);
    expect(replay.headers['idempotency-replay']).toBe('true');
    expect(replay.body.file_id).toBe(intent.body.file_id);
    const files = dataSource.getRepository(StoredFile);
    expect(await files.count()).toBe(1);
    expect(
      (await files.findOneByOrFail({ id: intent.body.file_id })).status,
    ).toBe('pending');

    await api()
      .post(`/uploads/${intent.body.file_id}/commit`)
      .set(asBuyer)
      .expect(409);
    const tampered = intent.body.upload.url.replace(
      /[0-9a-f-]{36}\.png/,
      'evil.png',
    );
    expect(await put(tampered, bytes, 'image/png')).toBe(403);
    expect(await put(intent.body.upload.url, bytes, 'image/png')).toBe(200);

    const committed = await api()
      .post(`/uploads/${intent.body.file_id}/commit`)
      .set(asBuyer)
      .expect(200);
    expect(committed.body).toMatchObject({
      status: 'completed',
      size: bytes.length,
      key: intent.body.key,
      etag: expect.any(String),
    });
    await api()
      .post(`/uploads/${intent.body.file_id}/commit`)
      .set(asBuyer)
      .expect(200);

    const download = await api()
      .get(`/files/${intent.body.file_id}`)
      .set(asBuyer)
      .expect(302);
    const fetched = await fetch(download.headers.location);
    expect(Buffer.from(await fetched.arrayBuffer()).equals(bytes)).toBe(true);
    await api()
      .get(`/files/${intent.body.file_id}`)
      .set(asStranger)
      .expect(403);
    await api().get(`/files/${intent.body.file_id}`).expect(401);
    await api().get(`/files/${randomUUID()}`).set(asBuyer).expect(404);
    await api()
      .post('/uploads/intent')
      .set(asBuyer)
      .set('Idempotency-Key', 'up-2')
      .send({ ...body, content_type: 'text/html' })
      .expect(400);
  });

  it('commit refuses an object whose size differs from the declared one', async () => {
    const buyer = await given(dataSource).user();
    const asBuyer = await bearer(app, buyer);
    const intent = await api()
      .post('/uploads/intent')
      .set(asBuyer)
      .set('Idempotency-Key', 'up-3')
      .send({ filename: 'a.png', content_type: 'image/png', size: 2048 })
      .expect(200);
    expect(
      await put(intent.body.upload.url, Buffer.alloc(1024), 'image/png'),
    ).toBe(200);
    const refused = await api()
      .post(`/uploads/${intent.body.file_id}/commit`)
      .set(asBuyer)
      .expect(409);
    expect(refused.body.detail).toContain('1024');
    await api().get(`/files/${intent.body.file_id}`).set(asBuyer).expect(409);
  });

  it('commit sniffs the magic bytes and refuses content that is not the declared type', async () => {
    const buyer = await given(dataSource).user();
    const asBuyer = await bearer(app, buyer);
    const html = Buffer.alloc(2048, ' ');
    html.write('<html><script>alert(1)</script></html>');
    const intentFor = async (key: string, contentType: string) =>
      (
        await api()
          .post('/uploads/intent')
          .set(asBuyer)
          .set('Idempotency-Key', key)
          .send({ filename: 'x', content_type: contentType, size: html.length })
          .expect(200)
      ).body;

    const disguised = await intentFor('sniff-1', 'image/png');
    expect(await put(disguised.upload.url, html, 'image/png')).toBe(200);
    const refused = await api()
      .post(`/uploads/${disguised.file_id}/commit`)
      .set(asBuyer)
      .expect(409);
    expect(refused.body.detail).toContain('not image/png');
    const files = dataSource.getRepository(StoredFile);
    expect(
      (await files.findOneByOrFail({ id: disguised.file_id })).status,
    ).toBe('pending');
    await api().get(`/files/${disguised.file_id}`).set(asBuyer).expect(409);

    const pdf = await intentFor('sniff-2', 'application/pdf');
    const document = Buffer.alloc(2048, ' ');
    document.write('%PDF-1.7');
    expect(await put(pdf.upload.url, document, 'application/pdf')).toBe(200);
    await api().post(`/uploads/${pdf.file_id}/commit`).set(asBuyer).expect(200);

    const opaque = await intentFor('sniff-3', 'application/octet-stream');
    expect(await put(opaque.upload.url, html, 'application/octet-stream')).toBe(
      200,
    );
    await api()
      .post(`/uploads/${opaque.file_id}/commit`)
      .set(asBuyer)
      .expect(200);
  });

  it('multipart: parts reports what the storage holds, commit completes with a multipart ETag', async () => {
    const buyer = await given(dataSource).user();
    const asBuyer = await bearer(app, buyer);
    const size = 2 * MIN_PART_SIZE + MiB;
    const intent = await api()
      .post('/uploads/intent')
      .set(asBuyer)
      .set('Idempotency-Key', 'mp-1')
      .send({
        filename: 'dump.bin',
        content_type: 'application/octet-stream',
        size,
      })
      .expect(200);
    const { upload, file_id, key } = intent.body;
    expect(upload).toMatchObject({
      type: 'multipart',
      part_size: MIN_PART_SIZE,
      size,
    });
    expect(upload.parts).toHaveLength(3);
    const chunk = (n: number) =>
      Buffer.alloc(
        Math.min(upload.part_size, size - (n - 1) * upload.part_size),
        n,
      );

    for (const part of upload.parts.slice(0, 2)) {
      expect(await put(part.url, chunk(part.part_number))).toBe(200);
    }
    const parts = await api()
      .get(`/uploads/${file_id}/parts`)
      .set(asBuyer)
      .expect(200);
    expect(
      parts.body.uploaded.map((p: { part_number: number }) => p.part_number),
    ).toEqual([1, 2]);
    expect(
      parts.body.parts.map((p: { part_number: number }) => p.part_number),
    ).toEqual([3]);
    expect(await storage.head(key)).toBeNull();
    await api().post(`/uploads/${file_id}/commit`).set(asBuyer).expect(409);

    expect(await put(parts.body.parts[0].url, chunk(3))).toBe(200);
    const committed = await api()
      .post(`/uploads/${file_id}/commit`)
      .set(asBuyer)
      .expect(200);
    expect(committed.body.size).toBe(size);
    expect(committed.body.etag).toMatch(/-3"?$/);
    expect((await storage.head(key))?.size).toBe(size);
    await api().get(`/uploads/${file_id}/parts`).set(asBuyer).expect(409);
  });

  it('public assets: the bucket refuses anonymous reads, the edge caches immutable objects, new content gets a new name', async () => {
    const first = await publishAsset(
      storage,
      'app.css',
      Buffer.from('a{}'),
      'text/css',
    );
    const published = [first];
    const direct = await fetch(storage.objectUrl(first));
    await direct.text();
    expect(direct.status).toBe(403);

    const edge = createEdge(storage);
    await new Promise<void>((resolve) => edge.listen(0, '127.0.0.1', resolve));
    const base = `http://127.0.0.1:${(edge.address() as AddressInfo).port}`;
    try {
      const miss = await fetch(`${base}/${first}`);
      expect(miss.status).toBe(200);
      expect(miss.headers.get('x-cache')).toBe('MISS');
      expect(miss.headers.get('cache-control')).toBe(
        'public, max-age=31536000, immutable',
      );
      expect(await miss.text()).toBe('a{}');
      const hit = await fetch(`${base}/${first}`);
      expect(hit.headers.get('x-cache')).toBe('HIT');
      expect(await hit.text()).toBe('a{}');
      const head = await fetch(`${base}/${first}`, { method: 'HEAD' });
      expect(head.status).toBe(200);
      expect(head.headers.get('x-cache')).toBe('HIT');
      expect(head.headers.get('content-length')).toBe('3');
      expect(await head.text()).toBe('');
      const post = await fetch(`${base}/${first}`, { method: 'POST' });
      expect(post.status).toBe(405);
      expect(post.headers.get('allow')).toBe('GET, HEAD');
      await post.text();

      const second = await publishAsset(
        storage,
        'app.css',
        Buffer.from('b{}'),
        'text/css',
      );
      published.push(second);
      expect(second).not.toBe(first);
      const fresh = await fetch(`${base}/${second}`);
      expect(fresh.status).toBe(200);
      expect(await fresh.text()).toBe('b{}');
      const missing = await fetch(`${base}/assets/nothing.css`);
      expect(missing.status).toBe(404);
      await missing.text();
    } finally {
      await new Promise<void>((resolve) => edge.close(() => resolve()));
      await storage.deleteAll(published);
    }
  });

  it('the edge cache is bounded: least recently used objects are evicted by volume, oversized ones are not cached', async () => {
    const body = (letter: string, size = 1000) => Buffer.alloc(size, letter);
    const keys = [
      await publishAsset(storage, 'lru-a.css', body('a'), 'text/css'),
      await publishAsset(storage, 'lru-b.css', body('b'), 'text/css'),
      await publishAsset(storage, 'lru-c.css', body('c'), 'text/css'),
      await publishAsset(storage, 'lru-big.css', body('x', 4000), 'text/css'),
    ];
    const [a, b, c, big] = keys;
    const edge = createEdge(storage, { maxBytes: 2500 });
    await new Promise<void>((resolve) => edge.listen(0, '127.0.0.1', resolve));
    const base = `http://127.0.0.1:${(edge.address() as AddressInfo).port}`;
    const verdict = async (key: string, method = 'GET') => {
      const response = await fetch(`${base}/${key}`, { method });
      await response.text();
      return response.headers.get('x-cache');
    };
    try {
      expect(await verdict(a, 'HEAD')).toBe('MISS');
      expect(await verdict(b)).toBe('MISS');
      expect(await verdict(a)).toBe('HIT');
      expect(await verdict(c)).toBe('MISS');
      expect(await verdict(a)).toBe('HIT');
      expect(await verdict(c)).toBe('HIT');
      expect(await verdict(b)).toBe('MISS');
      expect(await verdict(big)).toBe('MISS');
      expect(await verdict(big)).toBe('MISS');
      expect(await verdict(b)).toBe('HIT');
    } finally {
      await new Promise<void>((resolve) => edge.close(() => resolve()));
      await storage.deleteAll(keys);
    }
  });
});

import type { AddressInfo } from 'node:net';
import { NestExpressApplication } from '@nestjs/platform-express';
import { io, Socket } from 'socket.io-client';
import request from 'supertest';
import { DataSource } from 'typeorm';
import { given } from '../integration/testkit/builders';
import { resetDatabase } from '../integration/testkit/database';
import { createApp } from './create-app';

describe('order status realtime (e2e)', () => {
  let app: NestExpressApplication;
  let dataSource: DataSource;
  let base: string;
  const api = () => request(app.getHttpServer());
  const sockets: Socket[] = [];

  const connect = (auth?: { userId: number }) => {
    const socket = io(base, { auth, transports: ['websocket'] });
    sockets.push(socket);
    return socket;
  };
  const join = (socket: Socket, orderId: string) =>
    new Promise<{ ok: boolean; error?: string }>((resolve) =>
      socket.emit('join', { orderId }, resolve),
    );
  const nextEvent = (socket: Socket, ms = 1500) =>
    new Promise<Record<string, unknown> | null>((resolve) => {
      const timer = setTimeout(() => resolve(null), ms);
      socket.once('order.status', (event) => {
        clearTimeout(timer);
        resolve(event);
      });
    });
  const readSse = async (
    path: string,
    headers: Record<string, string>,
    until: RegExp,
  ) => {
    const controller = new AbortController();
    const response = await fetch(`${base}${path}`, {
      headers,
      signal: controller.signal,
    });
    const reader = response.body!.getReader();
    let text = '';
    const deadline = Date.now() + 3000;
    while (!until.test(text) && Date.now() < deadline) {
      const { value, done } = await reader.read();
      if (done) break;
      text += Buffer.from(value).toString();
    }
    controller.abort();
    return { response, text };
  };
  const idsIn = (text: string) =>
    [...text.matchAll(/^id: (\d+)$/gm)].map((match) => Number(match[1]));

  beforeAll(async () => {
    app = await createApp();
    await app.listen(0, '127.0.0.1');
    const { port } = app.getHttpServer().address() as AddressInfo;
    base = `http://127.0.0.1:${port}`;
    dataSource = app.get(DataSource);
  });
  afterAll(() => app.close());
  beforeEach(() => resetDatabase(dataSource));
  afterEach(() => {
    sockets.splice(0).forEach((socket) => socket.close());
  });

  it('walks an order through its lifecycle and refuses illegal transitions', async () => {
    const order = await given(dataSource).order();

    const processing = await api()
      .patch(`/orders/${order.id}/status`)
      .send({ status: 'processing' })
      .expect(200);
    expect(processing.body.status).toBe('processing');

    const skipped = await api()
      .patch(`/orders/${order.id}/status`)
      .send({ status: 'delivered' })
      .expect(409);
    expect(skipped.body.detail).toContain('processing to delivered');

    await api()
      .patch(`/orders/${order.id}/status`)
      .send({ status: 'teleported' })
      .expect(400);
    await api()
      .patch('/orders/424242/status')
      .send({ status: 'shipped' })
      .expect(404);

    const stored = await api().get(`/orders/${order.id}`).expect(200);
    expect(stored.body.status).toBe('processing');
  });

  it('streams status changes over SSE and replays the ones missed after Last-Event-ID', async () => {
    const order = await given(dataSource).order();
    for (const status of [
      'processing',
      'shipped',
      'out_for_delivery',
      'delivered',
    ]) {
      await api()
        .patch(`/orders/${order.id}/status`)
        .send({ status })
        .expect(200);
    }

    const full = await readSse(
      `/orders/${order.id}/events`,
      {},
      /"status":"delivered"/,
    );
    const ids = idsIn(full.text);
    expect(full.response.headers.get('content-type')).toContain(
      'text/event-stream',
    );
    expect(full.text).toMatch(/^retry: 1000$/m);
    expect(ids.length).toBeGreaterThanOrEqual(4);
    expect(ids).toEqual([...ids].sort((a, b) => a - b));

    const last = ids[ids.length - 1];
    const replay = await readSse(
      `/orders/${order.id}/events`,
      { 'Last-Event-ID': String(last - 1) },
      new RegExp(`^id: ${last}$`, 'm'),
    );
    expect(idsIn(replay.text)).toEqual([last]);
    expect(replay.text).toMatch(/^event: order\.status$/m);
    expect(replay.text).toMatch(
      /^data: .*"status":"delivered".*"previous":"out_for_delivery"/m,
    );
    await expect(fetch(`${base}/orders/424242/events`)).resolves.toMatchObject({
      status: 404,
    });
  });

  it('emits order.status only into the room of that order, after an ownership check', async () => {
    const { user, order } = given(dataSource);
    const alice = await user();
    const bob = await user();
    const orderA = await order(undefined, { userId: alice.id });
    const orderB = await order(undefined, { userId: bob.id });

    const aliceSocket = connect({ userId: Number(alice.id) });
    const bobSocket = connect({ userId: Number(bob.id) });
    await expect(join(aliceSocket, orderA.id)).resolves.toEqual({
      ok: true,
      room: `orders:${orderA.id}`,
    });
    await expect(join(bobSocket, orderB.id)).resolves.toMatchObject({
      ok: true,
    });
    await expect(join(bobSocket, orderA.id)).resolves.toMatchObject({
      ok: false,
      error: 'forbidden',
    });
    await expect(join(connect(), orderA.id)).resolves.toMatchObject({
      ok: false,
      error: 'unauthenticated',
    });

    const [aliceEvent, bobEvent] = await Promise.all([
      nextEvent(aliceSocket),
      nextEvent(bobSocket),
      api()
        .patch(`/orders/${orderA.id}/status`)
        .send({ status: 'processing' })
        .expect(200),
    ]);

    expect(aliceEvent).toMatchObject({
      id: expect.any(Number),
      orderId: Number(orderA.id),
      status: 'processing',
      previous: 'paid',
    });
    expect(bobEvent).toBeNull();
  });
});

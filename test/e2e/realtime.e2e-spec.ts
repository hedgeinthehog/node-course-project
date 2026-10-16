import type { AddressInfo } from 'node:net';
import { NestExpressApplication } from '@nestjs/platform-express';
import { io, Socket } from 'socket.io-client';
import request from 'supertest';
import { DataSource } from 'typeorm';
import { given } from '../integration/testkit/builders';
import { resetDatabase } from '../integration/testkit/database';
import { createApp } from './create-app';

type JoinResult = { ok: boolean; room?: string; error?: string };

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
    new Promise<JoinResult>((resolve) => {
      const finish = (result: JoinResult) => {
        socket.off('exception', finish);
        resolve(result);
      };
      socket.once('exception', finish);
      socket.emit('join', { orderId }, finish);
    });
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
  const changeStatus = (orderId: string, status: string) =>
    api().patch(`/orders/${orderId}/status`).send({ status }).expect(200);

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

    const processing = await changeStatus(order.id, 'processing');
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

  it('streams status changes over SSE to the owner and replays the ones missed after Last-Event-ID', async () => {
    const order = await given(dataSource).order();
    const owner = { 'X-User-Id': order.userId };
    for (const status of [
      'processing',
      'shipped',
      'out_for_delivery',
      'delivered',
    ]) {
      await changeStatus(order.id, status);
    }

    const full = await readSse(
      `/orders/${order.id}/events`,
      owner,
      /"status":"delivered"/,
    );
    expect(full.response.headers.get('content-type')).toContain(
      'text/event-stream',
    );
    expect(full.text).toMatch(/^retry: 1000$/m);
    expect(idsIn(full.text)).toEqual([1, 2, 3, 4]);

    const replay = await readSse(
      `/orders/${order.id}/events`,
      { ...owner, 'Last-Event-ID': '3' },
      /^id: 4$/m,
    );
    expect(idsIn(replay.text)).toEqual([4]);
    expect(replay.text).toMatch(/^event: order\.status$/m);
    expect(replay.text).toMatch(
      /^data: .*"status":"delivered".*"previous":"out_for_delivery"/m,
    );
  });

  it('serves the SSE stream only to the owner of the order', async () => {
    const { user, order } = given(dataSource);
    const stranger = await user();
    const placed = await order();

    const anonymous = await fetch(`${base}/orders/${placed.id}/events`);
    expect(anonymous.status).toBe(400);
    expect(anonymous.headers.get('content-type')).toContain(
      'application/problem+json',
    );
    expect((await anonymous.json()).detail).toContain('x-user-id');

    const foreign = await fetch(`${base}/orders/${placed.id}/events`, {
      headers: { 'X-User-Id': stranger.id },
    });
    expect(foreign.status).toBe(403);
    expect(await foreign.json()).toMatchObject({
      status: 403,
      detail: 'forbidden',
    });

    const missing = await fetch(`${base}/orders/424242/events`, {
      headers: { 'X-User-Id': stranger.id },
    });
    expect(missing.status).toBe(404);
  });

  it('keeps the event numbering across an application restart', async () => {
    const order = await given(dataSource).order();
    const owner = { 'X-User-Id': order.userId };
    await changeStatus(order.id, 'processing');
    await changeStatus(order.id, 'shipped');

    await app.close();
    app = await createApp();
    await app.listen(0, '127.0.0.1');
    base = `http://127.0.0.1:${(app.getHttpServer().address() as AddressInfo).port}`;
    dataSource = app.get(DataSource);

    await changeStatus(order.id, 'out_for_delivery');
    await changeStatus(order.id, 'delivered');

    const replay = await readSse(
      `/orders/${order.id}/events`,
      { ...owner, 'Last-Event-ID': '2' },
      /^id: 4$/m,
    );
    expect(idsIn(replay.text)).toEqual([3, 4]);
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
    await expect(join(bobSocket, orderA.id)).resolves.toEqual({
      ok: false,
      error: 'forbidden',
    });
    await expect(join(connect(), orderA.id)).resolves.toEqual({
      ok: false,
      error: 'unauthenticated',
    });

    const [aliceEvent, bobEvent] = await Promise.all([
      nextEvent(aliceSocket),
      nextEvent(bobSocket),
      changeStatus(orderA.id, 'processing'),
    ]);

    expect(aliceEvent).toMatchObject({
      id: 1,
      orderId: Number(orderA.id),
      status: 'processing',
      previous: 'paid',
    });
    expect(bobEvent).toBeNull();
  });
});

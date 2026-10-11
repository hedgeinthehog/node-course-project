import { randomUUID } from 'node:crypto';
import { io } from 'socket.io-client';

const base = process.env.API_URL ?? 'http://localhost:3000';
const sameRoom = process.argv.includes('--same-room');
const buyerA = Number(process.env.USER_A ?? 1);
const buyerB = Number(process.env.USER_B ?? 2);
const graceMs = 1500;

async function api(method, path, body, headers = {}) {
  const response = await fetch(`${base}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const payload = await response.json();
  if (!response.ok) {
    throw new Error(
      `${method} ${path} -> ${response.status}: ${payload.detail ?? JSON.stringify(payload)}`,
    );
  }
  return payload;
}

async function productInStock() {
  const page = await api('GET', '/products?limit=100');
  const product = page.items.find((item) => item.stock > 0);
  if (!product) throw new Error('no product in stock, run "npm run seed"');
  return product.id;
}

async function placeOrder(userId, productId) {
  return api(
    'POST',
    '/orders',
    { user_id: userId, items: [{ product_id: productId, quantity: 1 }] },
    { 'Idempotency-Key': randomUUID() },
  );
}

function connect(userId) {
  return io(base, { auth: { userId }, transports: ['websocket'] });
}

function join(client, orderId) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`join ${orderId}: no ack`)),
      3000,
    );
    client.emit('join', { orderId }, (ack) => {
      clearTimeout(timer);
      resolve(ack);
    });
  });
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const productId = await productInStock();
const orderA = await placeOrder(buyerA, productId);
const orderB = await placeOrder(buyerB, productId);
const roomB = sameRoom ? orderA.id : orderB.id;
const userB = sameRoom ? buyerA : buyerB;

const clientA = connect(buyerA);
const clientB = connect(userB);
const received = { A: [], B: [] };
clientA.on('order.status', (event) => received.A.push(event));
clientB.on('order.status', (event) => received.B.push(event));

const ackA = await join(clientA, orderA.id);
const ackB = await join(clientB, roomB);
if (!ackA.ok || !ackB.ok) {
  throw new Error(
    `join refused: A=${JSON.stringify(ackA)} B=${JSON.stringify(ackB)}`,
  );
}
if (!sameRoom) {
  const foreign = await join(clientB, orderA.id);
  console.log(`FOREIGN_JOIN=${foreign.ok ? 'allowed' : 'refused'}`);
}
const anonymous = io(base, { transports: ['websocket'] });
const anonymousAck = await join(anonymous, orderA.id);
console.log(`ANONYMOUS_JOIN=${anonymousAck.ok ? 'allowed' : 'refused'}`);
anonymous.close();

await api('PATCH', `/orders/${orderA.id}/status`, { status: 'processing' });
const deadline = Date.now() + 3000;
while (received.A.length === 0 && Date.now() < deadline) await sleep(50);
await sleep(graceMs);

clientA.close();
clientB.close();

const a = received.A.length > 0 ? 1 : 0;
const b = received.B.length > 0 ? 1 : 0;
const expectedB = sameRoom ? 1 : 0;
console.log(
  `MODE=${sameRoom ? 'same-room' : 'separate-rooms'} ORDER_A=${orderA.id} ROOM_B=orders:${roomB}`,
);
console.log(`A_RECEIVED=${a}`);
console.log(`B_RECEIVED=${b}`);
const ok =
  a === 1 &&
  b === expectedB &&
  (!sameRoom || received.B[0]?.orderId === orderA.id);
console.log(ok ? 'ROOM_ISOLATION=ok' : 'ROOM_ISOLATION=violated');
process.exit(ok ? 0 : 1);

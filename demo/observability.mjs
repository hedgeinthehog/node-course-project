import { spawn } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { ROOT } from './cluster.mjs';

const require = createRequire(import.meta.url);
const { DataSource } = require('typeorm');
const { dataSourceOptions } = require('../dist/data-source.js');
const { call, login, newAccount } = require('../dist/auth/demo-accounts.js');
const { Product } = require('../dist/entities/product.entity.js');

export { call };
export const API_PORT = 22950;
export const API_URL = `http://127.0.0.1:${API_PORT}`;

const hex = (bytes) => randomBytes(bytes).toString('hex');

export function traceparent() {
  const traceId = hex(16);
  const parentId = hex(8);
  return { traceId, parentId, header: `00-${traceId}-${parentId}-01` };
}

function databaseEnv() {
  if (process.env.DB_URL && process.env.DB_PASSWORD_FILE) return {};
  const { host, port, database, username, password } = dataSourceOptions;
  const file = join(mkdtempSync(join(tmpdir(), 'demo-api-')), 'db_password');
  writeFileSync(file, `${username}:${password}`, { mode: 0o600 });
  return {
    DB_URL: `postgres://${host}:${port}/${database}`,
    DB_PASSWORD_FILE: file,
  };
}

export async function startApi(env = {}) {
  const child = spawn(process.execPath, ['dist/main.js'], {
    cwd: ROOT,
    env: {
      ...process.env,
      ...databaseEnv(),
      PORT: String(API_PORT),
      RATE_LIMIT: '1000000',
      LOG_LEVEL: 'info',
      NODE_NO_WARNINGS: '1',
      OTEL_BSP_SCHEDULE_DELAY: '200',
      ...env,
    },
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  let stdout = '';
  child.stdout.on('data', (chunk) => (stdout += chunk));
  const exited = new Promise((resolve) => child.once('close', resolve));
  let gone = false;
  void exited.then(() => (gone = true));

  for (let i = 0; ; i++) {
    if (gone) throw new Error(`the API exited before it was ready\n${stdout}`);
    if (i > 300) throw new Error('the API did not become ready in 30 s');
    const ready = await fetch(`${API_URL}/healthz`).then(
      (response) => response.ok,
      () => false,
    );
    if (ready) break;
    await sleep(100);
  }

  return {
    async stop() {
      child.kill('SIGTERM');
      await exited;
      const raw = stdout.split('\n').filter(Boolean);
      const lines = [];
      let nonJson = 0;
      for (const line of raw) {
        try {
          lines.push(JSON.parse(line));
        } catch {
          nonJson += 1;
        }
      }
      return { raw, lines, nonJson };
    },
  };
}

const FAULT = 'observability_demo_fault';

async function dropFault(dataSource) {
  await dataSource.query(`DROP TRIGGER IF EXISTS ${FAULT} ON orders`);
  await dataSource.query(`DROP FUNCTION IF EXISTS ${FAULT}()`);
}

export async function prepare() {
  const dataSource = await new DataSource(dataSourceOptions).initialize();
  await dropFault(dataSource);
  const seller = await newAccount(dataSource, 'buyer');
  const buyer = await newAccount(dataSource, 'buyer');
  const unlucky = await newAccount(dataSource, 'buyer');
  const products = dataSource.getRepository(Product);
  const product = await products.save(
    products.create({
      sellerId: String(seller.id),
      name: `Observability demo ${randomUUID()}`,
      description: 'created by an observability demo',
      priceCents: 1,
      stock: 100_000,
    }),
  );
  return {
    dataSource,
    buyer,
    unlucky,
    productId: Number(product.id),
    async breakOrdersOf(account) {
      await dataSource.query(
        `CREATE FUNCTION ${FAULT}() RETURNS trigger LANGUAGE plpgsql AS
         $$ BEGIN RAISE EXCEPTION 'observability demo: the orders table refuses this insert'; END $$`,
      );
      await dataSource.query(
        `CREATE TRIGGER ${FAULT} BEFORE INSERT ON orders FOR EACH ROW
         WHEN (NEW.user_id = ${Number(account.id)}) EXECUTE FUNCTION ${FAULT}()`,
      );
    },
    async holdProduct(ms) {
      const runner = dataSource.createQueryRunner();
      await runner.startTransaction();
      await runner.query('SELECT id FROM products WHERE id = $1 FOR UPDATE', [
        product.id,
      ]);
      void sleep(ms)
        .then(() => runner.commitTransaction())
        .finally(() => runner.release());
    },
    async close() {
      await dropFault(dataSource);
      await dataSource.destroy();
    },
  };
}

export async function tokenOf(account) {
  const { status, body } = await login(API_URL, account);
  if (status !== 200) throw new Error(`login answered ${status}`);
  return body.access_token;
}

export function placeOrder(token, account, productId, options = {}) {
  const trace = options.trace ?? traceparent();
  const key = options.key ?? randomUUID();
  return call(API_URL, 'POST', '/orders', {
    token,
    body: {
      user_id: account.id,
      items: [{ product_id: productId, quantity: 1 }],
    },
    headers: {
      'idempotency-key': key,
      'x-tenant-id': 'demo',
      traceparent: trace.header,
    },
  }).then((response) => ({ ...response, trace, key }));
}

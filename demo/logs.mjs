import { randomBytes, randomUUID } from 'node:crypto';
import { finish, summary } from './cluster.mjs';
import {
  API_URL,
  call,
  placeOrder,
  prepare,
  startApi,
  tokenOf,
  traceparent,
} from './observability.mjs';

const BURST = 8;

const stage = await prepare();
const api = await startApi();
let single;
let burst;
let secrets;
let token;
try {
  token = await tokenOf(stage.buyer);
  single = await placeOrder(token, stage.buyer, stage.productId);
  burst = await Promise.all(
    Array.from({ length: BURST }, () =>
      placeOrder(token, stage.buyer, stage.productId),
    ),
  );

  const bearer = { marker: `tok-${randomBytes(12).toString('hex')}` };
  const password = { marker: `pw-${randomBytes(12).toString('hex')}` };
  bearer.trace = traceparent();
  password.trace = traceparent();
  await call(API_URL, 'GET', '/orders', {
    token: bearer.marker,
    headers: { traceparent: bearer.trace.header },
  });
  await call(API_URL, 'POST', '/auth/login', {
    body: { email: stage.buyer.email, password: password.marker },
    headers: { traceparent: password.trace.header },
  });
  const nested = { marker: `meta-${randomBytes(12).toString('hex')}` };
  nested.trace = traceparent();
  await call(API_URL, 'POST', '/orders', {
    token,
    body: {
      user_id: stage.buyer.id,
      items: [{ product_id: stage.productId, quantity: 1 }],
      meta: { password: nested.marker },
    },
    headers: {
      'idempotency-key': randomUUID(),
      traceparent: nested.trace.header,
    },
  });
  secrets = [bearer, password, nested];
} finally {
  await stage.close();
}
const { raw, lines, nonJson } = await api.stop();

const ofSingle = lines.filter((line) => line.idempotency_key === single.key);
const layers = new Set(ofSingle.map((line) => line.layer));
const singleTraceIds = new Set(ofSingle.map((line) => line.trace_id));

const sentTrace = new Map(burst.map(({ key, trace }) => [key, trace.traceId]));
const ofBurst = lines.filter((line) => sentTrace.has(line.idempotency_key));
const groups = new Map();
for (const line of ofBurst) {
  groups.set(line.trace_id, (groups.get(line.trace_id) ?? 0) + 1);
}
const sizes = [...groups.values()];
const mixed = ofBurst.filter(
  (line) => line.trace_id !== sentTrace.get(line.idempotency_key),
).length;

const requestLogged = (trace) =>
  lines.some(
    (line) =>
      line.trace_id === trace.traceId && line.msg === 'request completed',
  );
const forbidden = [
  ...secrets.map(({ marker }) => marker),
  token,
  stage.buyer.password,
];

const result = {
  'non-json-lines': nonJson,
  'log-lines': lines.length,
  layers: layers.size,
  'distinct-trace-ids': singleTraceIds.size,
  'trace-id-matches-header': Number(
    singleTraceIds.size === 1 && singleTraceIds.has(single.trace.traceId),
  ),
  burst: burst.length,
  'burst-ok': burst.filter(({ status }) => status === 201).length,
  'burst-trace-ids': [...groups.keys()].filter((id) =>
    [...sentTrace.values()].includes(id),
  ).length,
  'burst-lines-per-request': sizes[0] ?? 0,
  'burst-uneven': sizes.length ? Math.max(...sizes) - Math.min(...sizes) : 0,
  'burst-mixed': mixed,
  'secret-req-logged': Number(
    secrets.every(({ trace }) => requestLogged(trace)),
  ),
  'secret-in-logs': raw.filter((line) =>
    forbidden.some((secret) => line.includes(secret)),
  ).length,
};
console.log(`layers of one request: ${[...layers].join(', ')}`);
summary(result);
finish(
  single.status === 201 &&
    result['non-json-lines'] === 0 &&
    result.layers >= 3 &&
    result['distinct-trace-ids'] === 1 &&
    result['trace-id-matches-header'] === 1 &&
    result['burst-ok'] === BURST &&
    result['burst-trace-ids'] === BURST &&
    result['burst-uneven'] === 0 &&
    result['burst-mixed'] === 0 &&
    result['secret-req-logged'] === 1 &&
    result['secret-in-logs'] === 0,
  'every log line is JSON, one request keeps one trace_id through all layers, parallel requests do not mix, secrets stay out',
);

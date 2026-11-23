import { setTimeout as sleep } from 'node:timers/promises';
import { finish, summary } from './cluster.mjs';
import { placeOrder, prepare, startApi, tokenOf } from './observability.mjs';

const { OTEL_EXPORTER_OTLP_ENDPOINT, TRACE_API_URL } = process.env;
if (!OTEL_EXPORTER_OTLP_ENDPOINT || !TRACE_API_URL) {
  throw new Error(
    'OTEL_EXPORTER_OTLP_ENDPOINT and TRACE_API_URL must point at the observability stack',
  );
}

const tagOf = (span, key) => span.tags.find((tag) => tag.key === key)?.value;
const parentOf = (span) =>
  span.references.find((reference) => reference.refType === 'CHILD_OF')?.spanID;

async function spansOf(traceId) {
  for (let i = 0; i < 100; i++) {
    const spans = await fetch(`${TRACE_API_URL}/api/traces/${traceId}`)
      .then((response) => (response.ok ? response.json() : { data: [] }))
      .then((json) => json.data.flatMap((trace) => trace.spans))
      .catch(() => []);
    const hasServer = spans.some(
      (span) => tagOf(span, 'span.kind') === 'server',
    );
    if (hasServer && spans.length >= 2) return spans;
    await sleep(200);
  }
  return [];
}

const stage = await prepare();
const api = await startApi();
let failed;
try {
  const token = await tokenOf(stage.unlucky);
  await stage.breakOrdersOf(stage.unlucky);
  failed = await placeOrder(token, stage.unlucky, stage.productId);
} finally {
  await stage.close();
}
const { lines } = await api.stop();
const spans = await spansOf(failed.trace.traceId);

const ids = new Set(spans.map((span) => span.spanID));
const server = spans.find((span) => tagOf(span, 'span.kind') === 'server');
const logged = lines.find(
  (line) => line.idempotency_key === failed.key && line.level >= 50,
);

const result = {
  status: failed.status,
  spans: spans.length,
  'database-spans': spans.filter(
    (span) => tagOf(span, 'db.system.name') ?? tagOf(span, 'db.system'),
  ).length,
  'orphan-spans': spans.filter((span) => {
    const parent = parentOf(span);
    return (
      parent !== undefined &&
      !ids.has(parent) &&
      parent !== failed.trace.parentId
    );
  }).length,
  'trace-matches-header': Number(
    server !== undefined &&
      server.traceID === failed.trace.traceId &&
      parentOf(server) === failed.trace.parentId,
  ),
  'trace-matches-log': Number(
    logged !== undefined &&
      spans.length > 0 &&
      spans.every((span) => span.traceID === logged.trace_id) &&
      ids.has(logged.span_id),
  ),
  'span-status-error': Number(
    server !== undefined && tagOf(server, 'otel.status_code') === 'ERROR',
  ),
};
console.log(`trace_id=${failed.trace.traceId}`);
summary(result);
finish(
  result.status >= 500 &&
    result.spans >= 2 &&
    result['orphan-spans'] === 0 &&
    result['trace-matches-header'] === 1 &&
    result['trace-matches-log'] === 1 &&
    result['span-status-error'] === 1,
  'the failed request is one trace: it continues the incoming traceparent, the error log line carries its trace_id, the server span is ERROR',
);

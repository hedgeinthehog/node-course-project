import { setTimeout as sleep } from 'node:timers/promises';
import { finish, summary } from './cluster.mjs';
import {
  API_PORT,
  API_URL,
  call,
  placeOrder,
  prepare,
  startApi,
  tokenOf,
} from './observability.mjs';

const OK = 100;
const FAIL = 10;
const HOLD_MS = 1200;
const PARALLEL = 10;
const ROUTE = { method: 'POST', route: '/orders' };

async function scrape() {
  const text = await fetch(`${API_URL}/metrics`).then((r) => r.text());
  return text
    .split('\n')
    .filter((line) => line && !line.startsWith('#'))
    .map((line) => {
      const [, name, labels = '', value] =
        /^([a-z_]+)(?:\{(.*)})?\s+(\S+)$/.exec(line) ?? [];
      return {
        name,
        value: Number(value),
        labels: Object.fromEntries(
          [...labels.matchAll(/([a-z]+)="([^"]*)"/g)].map(([, k, v]) => [k, v]),
        ),
      };
    });
}

const sum = (samples, name, filter = () => true) =>
  samples
    .filter(
      (sample) =>
        sample.name === name &&
        sample.labels.method === ROUTE.method &&
        sample.labels.route === ROUTE.route &&
        filter(sample.labels),
    )
    .reduce((total, sample) => total + sample.value, 0);

const isServerError = ({ status }) => /^5\d\d$/.test(status);
const seriesOf = (samples) =>
  samples.filter(({ name }) => name === 'http_requests_total').length;

async function inBatches(count, send) {
  const responses = [];
  for (let done = 0; done < count; done += PARALLEL) {
    const batch = Math.min(PARALLEL, count - done);
    responses.push(...(await Promise.all(Array.from({ length: batch }, send))));
  }
  return responses;
}

async function seenByPrometheus(expected) {
  const base = process.env.PROMETHEUS_URL;
  if (!base) return undefined;
  const query = `sum(http_requests_total{method="${ROUTE.method}",route="${ROUTE.route}",instance=~".*:${API_PORT}"})`;
  for (let i = 0; i < 50; i++) {
    const value = await fetch(
      `${base}/api/v1/query?query=${encodeURIComponent(query)}`,
    )
      .then((r) => r.json())
      .then((json) => Number(json.data.result[0]?.value[1]))
      .catch(() => NaN);
    if (value === expected) return 1;
    await sleep(200);
  }
  return 0;
}

const stage = await prepare();
const api = await startApi();
let result;
try {
  const token = await tokenOf(stage.buyer);
  const unluckyToken = await tokenOf(stage.unlucky);
  await stage.breakOrdersOf(stage.unlucky);

  const before = await scrape();
  const ok = await inBatches(OK, () =>
    placeOrder(token, stage.buyer, stage.productId),
  );
  await stage.holdProduct(HOLD_MS);
  const slowStarted = Date.now();
  const slow = await placeOrder(token, stage.buyer, stage.productId);
  const slowMs = Date.now() - slowStarted;
  const failed = await inBatches(FAIL, () =>
    placeOrder(unluckyToken, stage.unlucky, stage.productId),
  );
  const after = await scrape();

  const responses = [...ok, slow, ...failed];
  const sentOk = responses.filter(({ status }) => status === 201).length;
  const sentFail = responses.filter(({ status }) => status >= 500).length;
  const finite = after
    .filter(({ name }) => name === 'http_request_duration_seconds_bucket')
    .map(({ labels }) => Number(labels.le))
    .filter(Number.isFinite);
  const top = Math.max(...finite);

  const ids = ok.map(({ body }) => body.id);
  const lookup = (id) => call(API_URL, 'GET', `/orders/${id}`, { token });
  await lookup(ids[0]);
  const seriesBefore = seriesOf(await scrape());
  const lookups = await Promise.all(ids.map(lookup));
  const seriesAfter = seriesOf(await scrape());

  const total = sum(after, 'http_requests_total');
  result = {
    'sent-ok': sentOk,
    'sent-fail': sentFail,
    'sent-other': responses.length - sentOk - sentFail,
    'counter-delta': total - sum(before, 'http_requests_total'),
    'errors-delta':
      sum(after, 'http_requests_total', isServerError) -
      sum(before, 'http_requests_total', isServerError),
    'top-bucket-seconds': top,
    'slowest-request-ms': slowMs,
    'above-top-bucket':
      sum(after, 'http_request_duration_seconds_count') -
      sum(
        after,
        'http_request_duration_seconds_bucket',
        ({ le }) => Number(le) === top,
      ),
    'distinct-ids': new Set(ids).size,
    'lookups-ok': lookups.filter(({ status }) => status === 200).length,
    'series-before': seriesBefore,
    'series-after': seriesAfter,
  };
  const prometheus = await seenByPrometheus(total);
  if (prometheus !== undefined) result['prometheus-agrees'] = prometheus;
} finally {
  await stage.close();
  await api.stop();
}

summary(result);
finish(
  result['sent-ok'] === OK + 1 &&
    result['sent-fail'] === FAIL &&
    result['counter-delta'] === result['sent-ok'] + result['sent-fail'] &&
    result['errors-delta'] === result['sent-fail'] &&
    result['slowest-request-ms'] >= HOLD_MS - 200 &&
    result['above-top-bucket'] === 0 &&
    result['distinct-ids'] === OK &&
    result['lookups-ok'] === OK &&
    result['series-after'] === result['series-before'],
  'the counter saw every request, 5xx are counted as errors, the slow request fits the buckets, a hundred ids added no series',
);

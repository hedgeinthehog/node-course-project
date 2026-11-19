import { Counter, Histogram, Registry } from 'prom-client';

export const DURATION_BUCKETS_S = [
  0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30,
];

export const registry = new Registry();

export const httpRequests = new Counter({
  name: 'http_requests_total',
  help: 'HTTP requests by method, route template and status code',
  labelNames: ['method', 'route', 'status'],
  registers: [registry],
});

export const httpDuration = new Histogram({
  name: 'http_request_duration_seconds',
  help: 'HTTP request duration by method, route template and status code',
  labelNames: ['method', 'route', 'status'],
  buckets: DURATION_BUCKETS_S,
  registers: [registry],
});

import { AsyncLocalStorage } from 'node:async_hooks';
import type { NextFunction, Request, Response } from 'express';
import { layerLogger } from './logger';
import { httpDuration, httpRequests, registry } from './metrics';
import { runInRequestContext } from './request-context';

const log = layerLogger('http');
const QUIET = new Set(['/metrics', '/health', '/healthz', '/readyz']);
const UNMATCHED = 'unmatched';

type RoutedRequest = Request & { openapi?: { expressRoute?: string } };

const routeOf = (request: RoutedRequest): string =>
  (request.route?.path as string | undefined) ??
  request.openapi?.expressRoute ??
  UNMATCHED;

const LOGGED_BODY_FIELDS = ['user_id', 'status', 'name', 'price_cents'];

function loggedBody(request: Request) {
  const body: unknown = request.body;
  if (request.path.startsWith('/auth/') || !body || typeof body !== 'object') {
    return undefined;
  }
  const source = body as Record<string, unknown>;
  const picked: Record<string, unknown> = {};
  for (const field of LOGGED_BODY_FIELDS) {
    if (['string', 'number'].includes(typeof source[field])) {
      picked[field] = source[field];
    }
  }
  if (Array.isArray(source.items)) picked.items = source.items.length;
  return picked;
}

export function observeHttp(
  request: Request,
  response: Response,
  next: NextFunction,
) {
  if (QUIET.has(request.path)) return next();
  const started = process.hrtime.bigint();
  const context = {
    idempotencyKey: request.header('idempotency-key'),
    tenant: request.header('x-tenant-id')?.slice(0, 64),
  };
  runInRequestContext(context, () => {
    response.on(
      'finish',
      AsyncLocalStorage.bind(() => {
        const seconds = Number(process.hrtime.bigint() - started) / 1e9;
        const labels = {
          method: request.method,
          route: routeOf(request),
          status: String(response.statusCode),
        };
        httpRequests.inc(labels);
        httpDuration.observe(labels, seconds);
        log.info(
          {
            req: {
              method: request.method,
              url: request.originalUrl,
              headers: request.headers,
              body: loggedBody(request),
            },
            route: labels.route,
            status: response.statusCode,
            duration_ms: Math.round(seconds * 1000),
          },
          'request completed',
        );
      }),
    );
    next();
  });
}

export async function serveMetrics(_request: Request, response: Response) {
  response.type(registry.contentType).send(await registry.metrics());
}

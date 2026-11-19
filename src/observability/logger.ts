import type { LoggerService } from '@nestjs/common';
import { isSpanContextValid, trace } from '@opentelemetry/api';
import pino from 'pino';
import { requestContext } from './request-context';

export const REDACTED_PATHS = [
  'req.headers.authorization',
  'req.headers.cookie',
  'req.headers["x-session-id"]',
  'req.body.password',
  'req.body.refresh_token',
];

export const logger = pino({
  level:
    process.env.LOG_LEVEL ??
    (process.env.NODE_ENV === 'test' ? 'silent' : 'info'),
  redact: { paths: REDACTED_PATHS, censor: '[REDACTED]' },
  mixin() {
    const span = trace.getActiveSpan()?.spanContext();
    const context = requestContext();
    return {
      ...(span &&
        isSpanContextValid(span) && {
          trace_id: span.traceId,
          span_id: span.spanId,
        }),
      ...(context?.userId && { user_id: context.userId }),
      ...(context?.tenant && { tenant: context.tenant }),
      ...(context?.idempotencyKey && {
        idempotency_key: context.idempotencyKey,
      }),
    };
  },
});

export const layerLogger = (layer: string) => logger.child({ layer });

export class PinoNestLogger implements LoggerService {
  private write(
    level: 'info' | 'warn' | 'error' | 'debug' | 'trace' | 'fatal',
    message: unknown,
    params: unknown[],
  ) {
    const context = params.at(-1);
    const layer = typeof context === 'string' ? context : 'nest';
    const text = message instanceof Error ? message.message : String(message);
    logger[level]({ layer }, text);
  }

  log(message: unknown, ...params: unknown[]) {
    this.write('info', message, params);
  }
  warn(message: unknown, ...params: unknown[]) {
    this.write('warn', message, params);
  }
  error(message: unknown, ...params: unknown[]) {
    this.write('error', message, params);
  }
  debug(message: unknown, ...params: unknown[]) {
    this.write('debug', message, params);
  }
  verbose(message: unknown, ...params: unknown[]) {
    this.write('trace', message, params);
  }
  fatal(message: unknown, ...params: unknown[]) {
    this.write('fatal', message, params);
  }
}

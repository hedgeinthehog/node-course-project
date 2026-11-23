import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import { HttpInstrumentation } from '@opentelemetry/instrumentation-http';
import { PgInstrumentation } from '@opentelemetry/instrumentation-pg';
import { NodeSDK } from '@opentelemetry/sdk-node';
import {
  BatchSpanProcessor,
  NoopSpanProcessor,
} from '@opentelemetry/sdk-trace-base';

const UNTRACED = new Set(['/metrics', '/health', '/healthz', '/readyz']);

const sdk = new NodeSDK({
  serviceName: process.env.OTEL_SERVICE_NAME ?? 'marketplace-api',
  spanProcessors: [
    process.env.OTEL_EXPORTER_OTLP_ENDPOINT
      ? new BatchSpanProcessor(new OTLPTraceExporter())
      : new NoopSpanProcessor(),
  ],
  instrumentations: [
    new HttpInstrumentation({
      ignoreIncomingRequestHook: (request) =>
        UNTRACED.has((request.url ?? '').split('?')[0]),
    }),
    new PgInstrumentation(),
  ],
});
sdk.start();

export const shutdownTelemetry = () => sdk.shutdown();

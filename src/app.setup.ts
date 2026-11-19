import { join } from 'node:path';
import { NestExpressApplication } from '@nestjs/platform-express';
import express from 'express';
import * as OpenApiValidator from 'express-openapi-validator';
import { observeHttp, serveMetrics } from './observability/http.middleware';
import { PinoNestLogger } from './observability/logger';

const projectRoot =
  typeof __dirname === 'undefined' ? process.cwd() : join(__dirname, '..');

export const appOptions = { bodyParser: false, logger: new PinoNestLogger() };

export function configureApp(app: NestExpressApplication) {
  app.use(observeHttp);
  app.use('/metrics', serveMetrics);
  app.use(express.json());
  app.use(
    OpenApiValidator.middleware({
      apiSpec: join(projectRoot, 'openapi', 'openapi.yaml'),
      validateRequests: true,
      validateResponses: true,
      validateSecurity: false,
    }),
  );
}

import { join } from 'node:path';
import { NestExpressApplication } from '@nestjs/platform-express';
import express from 'express';
import * as OpenApiValidator from 'express-openapi-validator';

const projectRoot =
  typeof __dirname === 'undefined' ? process.cwd() : join(__dirname, '..');

export const appOptions = { bodyParser: false };

export function configureApp(app: NestExpressApplication) {
  app.use(express.json());
  app.use(
    OpenApiValidator.middleware({
      apiSpec: join(projectRoot, 'openapi', 'openapi.yaml'),
      validateRequests: true,
      validateResponses: true,
    }),
  );
}

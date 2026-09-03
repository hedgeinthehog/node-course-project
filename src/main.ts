import { join } from 'node:path';
import { NestFactory } from '@nestjs/core';
import { NestExpressApplication } from '@nestjs/platform-express';
import express from 'express';
import * as OpenApiValidator from 'express-openapi-validator';
import { AppModule } from './app.module';

async function bootstrap() {
  const app = await NestFactory.create<NestExpressApplication>(AppModule, {
    bodyParser: false,
  });
  app.use(express.json());
  app.use(
    OpenApiValidator.middleware({
      apiSpec: join(__dirname, '..', 'openapi', 'openapi.yaml'),
      validateRequests: true,
      validateResponses: true,
    }),
  );
  await app.listen(process.env.PORT ?? 3000);
}
bootstrap();

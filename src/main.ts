import { setTimeout as sleep } from 'node:timers/promises';
import { ConfigService } from '@nestjs/config';
import { NestFactory } from '@nestjs/core';
import { NestExpressApplication } from '@nestjs/platform-express';
import { AppModule } from './app.module';
import { appOptions, configureApp } from './app.setup';
import { Env } from './config/env.schema';
import { Lifecycle } from './health/lifecycle';

async function bootstrap() {
  const app = await NestFactory.create<NestExpressApplication>(
    AppModule,
    appOptions,
  );
  configureApp(app);
  const config = app.get(ConfigService<Env, true>);
  const lifecycle = app.get(Lifecycle);
  const drainMs = config.get('SHUTDOWN_DRAIN_MS', { infer: true });

  process.once('SIGTERM', () => {
    lifecycle.beginDrain();
    void sleep(drainMs)
      .then(() => app.close())
      .then(() => process.exit(0));
  });

  await sleep(config.get('STARTUP_DELAY_MS', { infer: true }));
  await app.listen(config.get('PORT', { infer: true }));
}
bootstrap();

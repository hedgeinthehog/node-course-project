import { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import { AppModule } from '../../src/app.module';
import { appOptions, configureApp } from '../../src/app.setup';

export async function createApp(): Promise<NestExpressApplication> {
  const moduleRef = await Test.createTestingModule({
    imports: [AppModule],
  }).compile();
  const app =
    moduleRef.createNestApplication<NestExpressApplication>(appOptions);
  configureApp(app);
  return app.init();
}

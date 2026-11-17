import { NestExpressApplication } from '@nestjs/platform-express';
import request from 'supertest';
import { Lifecycle } from '../../src/health/lifecycle';
import { createApp } from './create-app';

describe('probes (e2e)', () => {
  let app: NestExpressApplication;
  const api = () => request(app.getHttpServer());

  beforeAll(async () => {
    app = await createApp();
  });
  afterAll(() => app.close());

  it('readiness turns red on drain while liveness stays green', async () => {
    await api().get('/healthz').expect(200, { status: 'ok' });
    await api().get('/readyz').expect(200, { status: 'ready' });

    app.get(Lifecycle).beginDrain();

    const draining = await api().get('/readyz').expect(503);
    expect(draining.body).toMatchObject({
      status: 503,
      detail: 'draining before shutdown',
    });
    await api().get('/healthz').expect(200);
  });
});

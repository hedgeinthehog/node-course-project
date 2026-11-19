import { NestExpressApplication } from '@nestjs/platform-express';
import pino from 'pino';
import request from 'supertest';
import { REDACTED_PATHS } from '../../src/observability/logger';
import { createApp } from './create-app';

describe('observability (e2e)', () => {
  let app: NestExpressApplication;
  const api = () => request(app.getHttpServer());

  beforeAll(async () => {
    app = await createApp();
  });
  afterAll(() => app.close());

  const counted = async (labels: string) => {
    const { text } = await api().get('/metrics').expect(200);
    const line = text
      .split('\n')
      .find((candidate) =>
        candidate.startsWith(`http_requests_total{${labels}}`),
      );
    return line ? Number(line.split(' ').at(-1)) : 0;
  };

  it('counts requests under the route template, whatever the id', async () => {
    const labels = 'method="GET",route="/orders/:id",status="401"';
    const before = await counted(labels);

    await api().get('/orders/101').expect(401);
    await api().get('/orders/202').expect(401);

    expect(await counted(labels)).toBe(before + 2);
    const { text } = await api().get('/metrics');
    expect(text).not.toMatch(/route="\/orders\/\d+"/);
    expect(text).toContain('http_request_duration_seconds_bucket{le="30"');
    expect(text).not.toContain('route="/metrics"');
  });

  it('redacts exactly the described paths and nothing it was not told about', () => {
    const lines: string[] = [];
    const log = pino(
      { redact: { paths: REDACTED_PATHS, censor: '[REDACTED]' } },
      { write: (line: string) => lines.push(line) },
    );

    log.info({
      req: {
        headers: { authorization: 'Bearer token-1', accept: '*/*' },
        body: { password: 'password-1', profile: { password: 'password-2' } },
      },
    });

    const [entry] = lines.map((line) => JSON.parse(line));
    expect(entry.req.headers).toEqual({
      authorization: '[REDACTED]',
      accept: '*/*',
    });
    expect(entry.req.body).toEqual({
      password: '[REDACTED]',
      profile: { password: 'password-2' },
    });
  });
});

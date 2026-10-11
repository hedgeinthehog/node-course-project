import { execSync } from 'node:child_process';
import type { AddressInfo } from 'node:net';
import { resolve } from 'node:path';
import { NestExpressApplication } from '@nestjs/platform-express';
import type * as Pact from '@pact-foundation/pact';
import { DataSource } from 'typeorm';
import { seedDatabase } from '../../src/seed-data';
import { resetDatabase } from '../integration/testkit/database';

declare const nativeRequire: NodeJS.Require;
const { Verifier } = nativeRequire('@pact-foundation/pact') as typeof Pact;

// Read before the app is loaded: importing AppModule makes ConfigModule load .env into process.env.
const brokerUrl = process.env.PACT_BROKER_URL;
const brokerToken = process.env.PACT_BROKER_TOKEN;

function providerVersion() {
  if (process.env.PACT_VERSION) return process.env.PACT_VERSION;
  try {
    return execSync('git rev-parse --short HEAD', {
      stdio: ['ignore', 'pipe', 'ignore'],
    })
      .toString()
      .trim();
  } catch {
    throw new Error(
      'PACT_VERSION is not set and there is no git checkout to derive the provider version from',
    );
  }
}

describe('marketplace-api provider verification', () => {
  let app: NestExpressApplication;
  let dataSource: DataSource;

  beforeAll(async () => {
    const { createApp } = await import('../e2e/create-app.js');
    app = await createApp();
    await app.listen(0, '127.0.0.1');
    dataSource = app.get(DataSource);
    await resetDatabase(dataSource);
  });
  afterAll(() => app.close());

  it('honours every interaction of its consumers', async () => {
    const { port } = app.getHttpServer().address() as AddressInfo;
    const pacts = brokerUrl
      ? {
          pactBrokerUrl: brokerUrl,
          ...(brokerToken && { pactBrokerToken: brokerToken }),
          consumerVersionSelectors: [{ latest: true }],
          publishVerificationResult: true,
          providerVersion: providerVersion(),
        }
      : {
          pactUrls: [resolve('pacts', 'marketplace-web-marketplace-api.json')],
        };

    await new Verifier({
      provider: 'marketplace-api',
      providerBaseUrl: `http://127.0.0.1:${port}`,
      ...pacts,
      stateHandlers: {
        'order 1 exists': () => seedDatabase(dataSource),
        'order 999 does not exist': async () => {
          await dataSource.query('DELETE FROM orders WHERE id = 999');
        },
        'user 1 has funds and product 2 is in stock': () =>
          seedDatabase(dataSource),
      },
    }).verifyProvider();
  });
});

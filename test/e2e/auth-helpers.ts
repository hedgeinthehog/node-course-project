import { NestExpressApplication } from '@nestjs/platform-express';
import request from 'supertest';
import { User } from '../../src/entities/user.entity';
import { TEST_PASSWORD } from '../integration/testkit/builders';

export interface Tokens {
  access_token: string;
  refresh_token: string;
  token_type: string;
  expires_in: number;
}

export async function tokensFor(
  app: NestExpressApplication,
  user: Pick<User, 'email'>,
): Promise<Tokens> {
  const response = await request(app.getHttpServer())
    .post('/auth/login')
    .send({ email: user.email, password: TEST_PASSWORD })
    .expect(200);
  return response.body as Tokens;
}

export async function bearer(
  app: NestExpressApplication,
  user: Pick<User, 'email'>,
): Promise<Record<string, string>> {
  const { access_token } = await tokensFor(app, user);
  return { Authorization: `Bearer ${access_token}` };
}

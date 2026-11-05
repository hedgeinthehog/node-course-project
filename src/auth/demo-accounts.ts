import { randomUUID } from 'node:crypto';
import { DataSource } from 'typeorm';
import { User, UserRole } from '../entities/user.entity';
import { hashPassword } from './password';

export interface Account {
  id: number;
  email: string;
  password: string;
  role: UserRole;
}

export interface ApiResponse {
  status: number;
  body: any;
  headers: Headers;
}

export async function newAccount(
  dataSource: DataSource,
  role: UserRole,
): Promise<Account> {
  const users = dataSource.getRepository(User);
  const password = randomUUID();
  const user = await users.save(
    users.create({
      email: `${role}-${randomUUID()}@demo.local`,
      name: `Demo ${role}`,
      balanceCents: '100000',
      role,
      passwordHash: await hashPassword(password),
    }),
  );
  return { id: Number(user.id), email: user.email, password, role };
}

export async function call(
  api: string,
  method: string,
  path: string,
  options: {
    token?: string;
    body?: unknown;
    headers?: Record<string, string>;
  } = {},
): Promise<ApiResponse> {
  const headers: Record<string, string> = { ...options.headers };
  if (options.token) headers.authorization = `Bearer ${options.token}`;
  if (options.body !== undefined) headers['content-type'] = 'application/json';
  const response = await fetch(`${api}${path}`, {
    method,
    headers,
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  });
  const text = await response.text();
  let body: unknown = text;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = text;
  }
  return { status: response.status, body, headers: response.headers };
}

export function login(api: string, account: Account) {
  return call(api, 'POST', '/auth/login', {
    body: { email: account.email, password: account.password },
  });
}

export function forgeRole(accessToken: string, role: string): string {
  const parts = accessToken.split('.');
  const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString());
  payload.role = role;
  parts[1] = Buffer.from(JSON.stringify(payload)).toString('base64url');
  return parts.join('.');
}

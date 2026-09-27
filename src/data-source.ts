import 'reflect-metadata';
import { join } from 'node:path';
import { DataSource } from 'typeorm';
import { parseDbEnv } from './config/db-env.schema';
import { entities } from './entities';

const env = parseDbEnv(process.env);

export const dataSourceOptions = {
  type: 'postgres' as const,
  host: env.DB_HOST,
  port: env.DB_PORT,
  username: env.DB_USER,
  password: env.DB_PASSWORD,
  database: env.DB_NAME,
  entities,
  migrations: [join(__dirname, 'migrations', '*.js')],
  synchronize: false,
};

export default new DataSource(dataSourceOptions);

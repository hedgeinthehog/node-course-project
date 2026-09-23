import 'reflect-metadata';
import { join } from 'node:path';
import { DataSource } from 'typeorm';
import { parseDbEnv } from './config/db-env.schema';
import { OrderItem } from './entities/order-item.entity';
import { Order } from './entities/order.entity';
import { Product } from './entities/product.entity';
import { User } from './entities/user.entity';

const env = parseDbEnv(process.env);

export const dataSourceOptions = {
  type: 'postgres' as const,
  host: env.DB_HOST,
  port: env.DB_PORT,
  username: env.DB_USER,
  password: env.DB_PASSWORD,
  database: env.DB_NAME,
  entities: [User, Product, Order, OrderItem],
  migrations: [join(__dirname, 'migrations', '*.js')],
  synchronize: false,
};

export default new DataSource(dataSourceOptions);

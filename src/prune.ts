import { DataSource } from 'typeorm';
import { dataSourceOptions } from './data-source';

const RETENTION = [
  ['outbox', `published_at < now() - interval '7 days'`],
  ['outbox', `failed_at < now() - interval '30 days'`],
  ['idempotency_keys', `created_at < now() - interval '24 hours'`],
  ['processed_messages', `processed_at < now() - interval '30 days'`],
] as const;

async function main() {
  const dataSource = await new DataSource(dataSourceOptions).initialize();
  const removed = new Map<string, number>();
  for (const [table, condition] of RETENTION) {
    const [, count]: [unknown[], number] = await dataSource.query(
      `DELETE FROM ${table} WHERE ${condition}`,
    );
    removed.set(table, (removed.get(table) ?? 0) + count);
  }
  await dataSource.destroy();
  for (const [table, count] of removed) console.log(`${table}=${count}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

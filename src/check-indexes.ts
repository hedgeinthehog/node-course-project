import dataSource from './data-source';

const expectedDefinitions: Record<string, string> = {
  idx_orders_user_id_created_at:
    'CREATE INDEX idx_orders_user_id_created_at ON orders USING btree (user_id, created_at DESC)',
  idx_orders_pending_created_at:
    "CREATE INDEX idx_orders_pending_created_at ON orders USING btree (created_at) INCLUDE (id, user_id, total_cents) WHERE (status = 'pending'::text)",
  idx_users_lower_email:
    'CREATE INDEX idx_users_lower_email ON users USING btree (lower(email))',
  idx_products_search_vector:
    'CREATE INDEX idx_products_search_vector ON products USING gin (search_vector)',
};

function normalize(definition: string) {
  return definition
    .replace(/\bON\s+\w+\.(\w+)/, 'ON $1')
    .replace(/\s+/g, ' ')
    .trim();
}

async function main() {
  await dataSource.initialize();
  const declared = dataSource.entityMetadatas.flatMap((meta) =>
    meta.indices
      .filter((index) => !index.synchronize)
      .map((index) => ({ table: meta.tableName, name: index.name })),
  );
  const rows: { indexname: string; indexdef: string }[] =
    await dataSource.query(
      'SELECT indexname, indexdef FROM pg_indexes WHERE schemaname = current_schema() AND indexname = ANY($1)',
      [declared.map((index) => index.name)],
    );
  await dataSource.destroy();

  const actual = new Map(rows.map((row) => [row.indexname, row.indexdef]));
  let failures = 0;
  for (const index of declared) {
    const expected = expectedDefinitions[index.name];
    const current = actual.get(index.name);
    if (!expected) {
      failures++;
      console.log(
        `NO SPEC ${index.table}.${index.name}: add its definition to check-indexes.ts`,
      );
    } else if (!current) {
      failures++;
      console.log(`MISSING ${index.table}.${index.name}`);
    } else if (normalize(current) !== normalize(expected)) {
      failures++;
      console.log(
        `DIFFERS ${index.table}.${index.name}\n  expected: ${expected}\n  actual:   ${normalize(current)}`,
      );
    } else {
      console.log(`ok      ${index.table}.${index.name}`);
    }
  }
  for (const name of Object.keys(expectedDefinitions)) {
    if (!declared.some((index) => index.name === name)) {
      failures++;
      console.log(
        `ORPHAN  ${name}: defined in check-indexes.ts but no entity declares it`,
      );
    }
  }
  if (failures > 0) {
    console.error(`${failures} index check(s) failed`);
    process.exit(1);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

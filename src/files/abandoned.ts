import { DataSource } from 'typeorm';
import { Storage } from './storage';

export async function abandonPendingUploads(
  dataSource: DataSource,
  storage: Storage,
  olderThan = '24 hours',
): Promise<number> {
  const rows: { id: string; key: string; upload_id: string | null }[] =
    await dataSource.query(
      `SELECT id, key, upload_id FROM files
       WHERE status = 'pending' AND created_at < now() - $1::interval`,
      [olderThan],
    );
  for (const row of rows) {
    if (row.upload_id) await storage.abortMultipart(row.key, row.upload_id);
    await storage.deleteAll([row.key]);
    await dataSource.query(`DELETE FROM files WHERE id = $1`, [row.id]);
  }
  return rows.length;
}

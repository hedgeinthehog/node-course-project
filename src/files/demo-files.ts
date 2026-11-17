import { spawn } from 'node:child_process';
import { connect } from 'node:net';
import { DataSource } from 'typeorm';
import { Storage } from './storage';

export const UPLOADS_PREFIX = 'uploads/';

export function portAlive(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = connect({ host: '127.0.0.1', port });
    socket.once('connect', () => {
      socket.destroy();
      resolve(true);
    });
    socket.once('error', () => resolve(false));
  });
}

export function putWithoutCredentials(
  url: string,
  contentType: string,
  bytes: Buffer,
): Promise<number> {
  const script = `
    const chunks = [];
    process.stdin.on('data', (c) => chunks.push(c)).on('end', async () => {
      const res = await fetch(process.argv[1], {
        method: 'PUT',
        headers: { 'content-type': process.argv[2] },
        body: Buffer.concat(chunks),
      });
      await res.text();
      console.log(res.status);
    });`;
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['-e', script, url, contentType], {
      env: {},
      stdio: ['pipe', 'pipe', 'inherit'],
    });
    let out = '';
    child.stdout.on('data', (chunk) => (out += chunk));
    child.on('error', reject);
    child.on('exit', (code) =>
      code === 0
        ? resolve(Number(out.trim()))
        : reject(new Error(`offline PUT exited with ${code}`)),
    );
    child.stdin.end(bytes);
  });
}

export async function cleanupOwner(
  storage: Storage,
  dataSource: DataSource,
  ownerId: number,
): Promise<void> {
  const prefix = `${UPLOADS_PREFIX}${ownerId}/`;
  for (const upload of await storage.listMultipartUploads(prefix)) {
    await storage.abortMultipart(upload.key, upload.uploadId);
  }
  await storage.deleteAll(await storage.list(prefix));
  await dataSource.query(`DELETE FROM files WHERE owner_id = $1`, [ownerId]);
}

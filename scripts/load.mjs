import { appendFileSync } from 'node:fs';
import http from 'node:http';
import { setTimeout as sleep } from 'node:timers/promises';

const [url, out] = process.argv.slice(2);
if (!url || !out) {
  console.error('usage: node scripts/load.mjs <url> <codes-file>');
  process.exit(2);
}
const workers = Number(process.env.LOAD_WORKERS ?? 4);
const pauseMs = Number(process.env.LOAD_PAUSE_MS ?? 15);
const timeoutMs = Number(process.env.LOAD_TIMEOUT_MS ?? 2000);

let running = true;
process.on('SIGTERM', () => (running = false));
process.on('SIGINT', () => (running = false));

function hit() {
  return new Promise((resolve) => {
    const request = http.get(
      url,
      { agent: false, timeout: timeoutMs },
      (response) => {
        response.resume();
        response.on('end', () => resolve(String(response.statusCode)));
        response.on('error', () => resolve('000'));
      },
    );
    request.on('timeout', () => request.destroy());
    request.on('error', () => resolve('000'));
  });
}

async function worker() {
  while (running) {
    appendFileSync(out, `${await hit()}\n`);
    await sleep(pauseMs);
  }
}

await Promise.all(Array.from({ length: workers }, worker));

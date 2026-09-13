import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { envSchema } = require('../dist/config/env.schema.js');

const schemaKeys = Object.keys(envSchema.shape);
const exampleKeys = readFileSync('.env.example', 'utf8')
  .split('\n')
  .map((line) => line.trim())
  .filter((line) => line && !line.startsWith('#'))
  .map((line) => line.split('=')[0]);

const missing = schemaKeys.filter((k) => !exampleKeys.includes(k));
const extra = exampleKeys.filter((k) => !schemaKeys.includes(k));

if (missing.length || extra.length) {
  if (missing.length)
    console.error('Missing in .env.example:', missing.join(', '));
  if (extra.length) console.error('Not in schema:', extra.join(', '));
  process.exit(1);
}
console.log(
  `.env.example is in sync with the schema (${schemaKeys.length} variables)`,
);

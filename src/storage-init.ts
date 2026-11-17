import { ABORT_INCOMPLETE_AFTER_DAYS, Storage } from './files/storage';

async function main() {
  const storage = Storage.fromEnv();
  const created = await storage.ensureBucket();
  console.log(
    `bucket ${storage.bucket} ${created ? 'created' : 'already exists'}, lifecycle: abort incomplete multipart uploads after ${ABORT_INCOMPLETE_AFTER_DAYS} days`,
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

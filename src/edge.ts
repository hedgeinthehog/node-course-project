import { createEdge, EDGE_CACHE_MAX_BYTES } from './files/edge';
import { Storage } from './files/storage';

const storage = Storage.fromEnv();
const port = Number(process.env.EDGE_PORT ?? 3200);
const maxBytes = Number(
  process.env.EDGE_CACHE_MAX_BYTES ?? EDGE_CACHE_MAX_BYTES,
);
createEdge(storage, { maxBytes }).listen(port, () => {
  console.log(
    `edge cache on :${port}, origin bucket ${storage.bucket}, cache limit ${maxBytes} bytes`,
  );
});

import { createEdge } from './files/edge';
import { Storage } from './files/storage';

const storage = Storage.fromEnv();
const port = Number(process.env.EDGE_PORT ?? 3200);
createEdge(storage).listen(port, () => {
  console.log(`edge cache on :${port}, origin bucket ${storage.bucket}`);
});

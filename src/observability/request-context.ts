import { AsyncLocalStorage } from 'node:async_hooks';

export interface RequestContext {
  userId?: string;
  tenant?: string;
  idempotencyKey?: string;
}

const storage = new AsyncLocalStorage<RequestContext>();

export const runInRequestContext = <T>(context: RequestContext, fn: () => T) =>
  storage.run(context, fn);

export const requestContext = () => storage.getStore();

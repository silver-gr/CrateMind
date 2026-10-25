import {afterEach, expect, test} from 'bun:test';
import {invalidateCollectionOptions, loadCollectionOptions, subscribeCollectionOptions} from '../src/lib/collectionOptions';
const originalFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = originalFetch; invalidateCollectionOptions(); });

test('pickers share the request and refresh after a collection mutation', async () => {
  let calls = 0;
  globalThis.fetch = (async () => { calls++; return Response.json([{id: String(calls), name:'A'}]); }) as typeof fetch;
  invalidateCollectionOptions();
  const first = loadCollectionOptions();
  expect(loadCollectionOptions()).toBe(first);
  await first;
  expect(loadCollectionOptions()).toBe(first);
  expect(calls).toBe(1);
  let changes = 0;
  const unsubscribe = subscribeCollectionOptions(() => { changes++; });
  invalidateCollectionOptions();
  expect(changes).toBe(1);
  expect((await loadCollectionOptions())[0].id).toBe('2');
  unsubscribe();
  invalidateCollectionOptions();
  expect(changes).toBe(1);
});

test('failed loads can retry and invalidated pending loads cannot replace newer results', async () => {
  let resolve!: (response:Response) => void;
  globalThis.fetch = (() => new Promise<Response>(r => { resolve = r; })) as typeof fetch;
  invalidateCollectionOptions();
  const stale = loadCollectionOptions();
  invalidateCollectionOptions();
  globalThis.fetch = (async () => Response.json([{id:'new'}])) as typeof fetch;
  const current = loadCollectionOptions();
  resolve(new Response(null, {status:500}));
  await expect(stale).rejects.toThrow('Αποτυχία');
  expect((await current)[0].id).toBe('new');
  expect(loadCollectionOptions()).toBe(current);
  invalidateCollectionOptions();
  globalThis.fetch = (async () => new Response(null, {status:500})) as typeof fetch;
  await expect(loadCollectionOptions()).rejects.toThrow('Αποτυχία');
  globalThis.fetch = (async () => Response.json([])) as typeof fetch;
  expect(await loadCollectionOptions()).toEqual([]);
});

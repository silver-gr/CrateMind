import { afterEach, expect, test } from "bun:test";
import { mayChangeIdentity, nativeAction } from "../src/lib/desktopRuntime";
import { canApplyExchange, type ExchangePreview } from "../src/lib/libraryExchange";
import { api } from "../src/lib/api";

const originalFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = originalFetch; });

test("desktop identity choices use resolved entity services and require both local sides", () => {
  expect(mayChangeIdentity(false, [{ service: "local" }, { service: "local" }])).toBe(true);
  for (const services of [["local", "soundcloud"], ["spotify", "local"], ["local"], []]) {
    expect(mayChangeIdentity(false, services.map(service => ({ service })))).toBe(false);
  }
  expect(mayChangeIdentity(true, [{ service: "spotify" }, { service: "local" }])).toBe(true);
});

test("native actions use the authenticated HTTP bridge and preserve canceled dialogs", async () => {
  const calls: [unknown, RequestInit | undefined][] = [];
  globalThis.fetch = (async (url, init) => {
    calls.push([url, init]); return Response.json({ canceled: true });
  }) as typeof fetch;
  expect(await nativeAction("pick_library_roots")).toEqual({ canceled: true });
  expect(calls[0][0]).toBe("/api/desktop/native-actions");
  expect(JSON.parse(calls[0][1]!.body as string)).toEqual({ action: "pick_library_roots", arguments: {} });
  await nativeAction("reveal_path", { track_id: 7 });
  expect(JSON.parse(calls[1][1]!.body as string).arguments).toEqual({ track_id: 7 });
});

test("exchange preview confirmation is specific to conflict, current digest and expiry", () => {
  const preview = { status: "ready", conflict: false, expires_at_unix: 100, local_digest: "digest" } as ExchangePreview;
  expect(canApplyExchange(preview, false, 99000)).toBe(true);
  expect(canApplyExchange(preview, false, 100000)).toBe(false);
  expect(canApplyExchange({ ...preview, status: "stale" }, true, 0)).toBe(false);
  expect(canApplyExchange({ ...preview, status: "conflict", conflict: true }, false, 0)).toBe(false);
  expect(canApplyExchange({ ...preview, status: "conflict", conflict: true }, true, 0)).toBe(true);
  expect(canApplyExchange({ ...preview, status: "conflict", local_digest: null }, true, 0)).toBe(false);
});

test("exchange upload leaves multipart boundary to fetch and commit binds preview plus local digest", async () => {
  const calls: RequestInit[] = [];
  globalThis.fetch = (async (_url, init) => { calls.push(init!); return Response.json({}); }) as typeof fetch;
  await api.inspectExchange(new File(["generated"], "fixture.cmexchange"));
  expect(calls[0].body).toBeInstanceOf(FormData);
  expect(calls[0].headers).toBeUndefined();
  await api.commitExchange({ preview_id: "specific-preview", local_digest: "specific-state" } as ExchangePreview, "replace");
  expect(JSON.parse(calls[1].body as string)).toEqual({ preview_id: "specific-preview", decision: "replace", local_digest: "specific-state" });
});

test("structured validation details render readable error text", async () => {
  globalThis.fetch = (async () => Response.json({ detail: [{ msg: "Μη έγκυρη επιλογή" }] }, { status: 422 })) as typeof fetch;
  await expect(api.patchDesktopConfig([])).rejects.toThrow("Μη έγκυρη επιλογή");
});

test("desktop bootstrap installs no PWA event or service-worker listeners", () => {
  const result = Bun.spawnSync(["bun", "--eval", `
    const events = [];
    globalThis.window = { matchMedia: () => ({matches:false}), addEventListener: name => events.push(name) };
    globalThis.document = { documentElement: { dataset: { desktop: 'true' } } };
    Object.defineProperty(globalThis, 'navigator', { value: {
      serviceWorker: { register: () => { throw new Error('desktop registered SW'); } },
      userAgent: '', platform: '', maxTouchPoints: 0
    }, configurable: true });
    await import('./src/lib/pwa.ts');
    if (events.length) throw new Error('desktop registered PWA handlers: ' + events.join(','));
  `], { cwd: import.meta.dir + "/.." });
  expect(result.exitCode).toBe(0);
});

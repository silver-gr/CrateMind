import { expect, test } from "bun:test";
import { PreferenceStorage } from "../src/lib/preferenceStorage";

function backend(initial: Record<string, string> = {}) {
  const saved = { ...initial };
  const patches: Record<string, string | null>[] = [];
  const fetcher = (async (_url: unknown, init?: RequestInit) => {
    if (init?.method === "PATCH") {
      const patch = JSON.parse(init.body as string);
      patches.push(patch);
      for (const [key, value] of Object.entries(patch)) {
        if (value === null) delete saved[key]; else saved[key] = value as string;
      }
    }
    return Response.json(saved);
  }) as typeof fetch;
  return { saved, patches, fetcher };
}

test("device preferences survive new origins without reading browser storage", async () => {
  const server = backend();
  const options = { desktop: () => true, fetcher: server.fetcher,
    webStorage: () => { throw new Error("must not read origin storage"); } };
  const first = new PreferenceStorage(options);
  await first.load();
  const values = {
    "cratemind:library-sort": '{"key":"bpm","dir":"desc"}',
    "cratemind:track-col-widths": '{"title":320}',
    "cm:sidebar-collections-expanded": "1", "cratemind-theme": "light",
    "cratemind:prefs:v1": '{"showWaveform":false,"density":"compact"}',
    "cm:player-height": "220", "cm:window-geometry": '{"width":1200}',
  };
  for (const [key, value] of Object.entries(values)) first.setItem(key, value);
  expect(first.getItem("cratemind-theme")).toBe("light");
  await first.flush();
  const relaunched = new PreferenceStorage(options);
  await relaunched.load();
  for (const [key, value] of Object.entries(values)) expect(relaunched.getItem(key)).toBe(value);
  expect(server.saved).toEqual(values);
  relaunched.removeItem("cratemind-theme");
  await relaunched.flush();
  expect(server.saved["cratemind-theme"]).toBeUndefined();
  expect(server.saved["cm:window-geometry"]).toBe(values["cm:window-geometry"]);
});

test("writes during an active request serialize and preserve the newest value", async () => {
  const server = backend();
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  let firstPatch = true;
  const fetcher = (async (url, init) => {
    if (init?.method === "PATCH" && firstPatch) { firstPatch = false; await gate; }
    return server.fetcher(url, init);
  }) as typeof fetch;
  const store = new PreferenceStorage({ desktop: () => true, fetcher });
  await store.load();
  store.setItem("cratemind-theme", "light");
  const writing = store.flush();
  store.setItem("cratemind-theme", "dark");
  store.setItem("cm:panel-width", "380");
  release(); await writing;
  expect(server.patches).toEqual([
    { "cratemind-theme": "light" }, { "cratemind-theme": "dark", "cm:panel-width": "380" },
  ]);
  expect(server.saved["cratemind-theme"]).toBe("dark");
});

test("failed writes remain queued and retry does not overwrite a newer edit", async () => {
  const server = backend();
  let fail = true;
  const fetcher = (async (url, init) => {
    if (init?.method === "PATCH" && fail) return new Response("offline", { status: 503 });
    return server.fetcher(url, init);
  }) as typeof fetch;
  const store = new PreferenceStorage({ desktop: () => true, fetcher });
  await store.load();
  store.setItem("cratemind-theme", "light");
  await expect(store.flush()).rejects.toThrow();
  expect(store.getError()).toContain("δεν αποθηκεύτηκαν");
  expect(store.getItem("cratemind-theme")).toBe("light");
  store.setItem("cratemind-theme", "dark");
  fail = false;
  await store.flush();
  expect(store.getError()).toBe("");
  expect(server.saved["cratemind-theme"]).toBe("dark");
});

test("malformed or failed hydration cannot silently reset durable preferences", async () => {
  for (const response of [Response.json({ "cratemind-theme": false }), new Response("error", { status: 500 })]) {
    let writes = 0;
    const store = new PreferenceStorage({ desktop: () => true, fetcher: (async (_url, init) => {
      if (init?.method === "PATCH") writes++;
      return response;
    }) as typeof fetch });
    await expect(store.load()).rejects.toThrow();
    expect(() => store.setItem("cratemind-theme", "dark")).toThrow();
    expect(writes).toBe(0);
  }
});

test("web preferences keep the existing synchronous localStorage behavior", async () => {
  const values = new Map<string, string>();
  const storage = { getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => { values.set(key, value); },
    removeItem: (key: string) => { values.delete(key); } } as Storage;
  const store = new PreferenceStorage({ desktop: () => false, webStorage: () => storage,
    fetcher: (() => { throw new Error("no desktop network on web"); }) as typeof fetch });
  await store.load(); store.setItem("cratemind-theme", "light");
  expect(store.getItem("cratemind-theme")).toBe("light");
  store.removeItem("cratemind-theme");
  expect(store.getItem("cratemind-theme")).toBeNull();
  await store.flush();
});

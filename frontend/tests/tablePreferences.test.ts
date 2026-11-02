import { describe, expect, test } from "bun:test";
import { PreferenceStorage } from "../src/lib/preferenceStorage";
import { clampColumnWidth, createTablePreferenceStore, LEGACY_COLUMN_WIDTHS_KEY, LIBRARY_COLUMNS, readTablePreferences, TABLE_PREFERENCES_KEY } from "../src/lib/tablePreferences";

function memoryStorage(initial: Record<string, string> = {}) {
  const values = new Map(Object.entries(initial));
  let writes = 0;
  return {
    values,
    get writes() { return writes; },
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => { writes++; values.set(key, value); },
  };
}

describe("Library column preferences", () => {
  test("migrates valid user widths, clamps minimums, and keeps compact settings separate", () => {
    const legacy = JSON.stringify({ "compact-track": 226.609375, "compact-key": 48, "compact-bpm": 60,
      track: 380.84375, substyle: 95.625, energy: 53.390625, key: 51.59375,
      "soundcloud-likes": 48.1875, created: 80.59375, bpm: 90, status: 900, added: "400", unknown: 500 });
    const storage = memoryStorage({ [LEGACY_COLUMN_WIDTHS_KEY]: legacy });
    const store = createTablePreferenceStore(storage);
    expect(store.getSnapshot().widths).toMatchObject({ track: 381, substyle: 96, energy: 96, key: 52,
      "soundcloud-likes": 64, created: 81, bpm: 90, status: 640, added: 97 });
    expect(Object.keys(store.getSnapshot().widths)).toHaveLength(LIBRARY_COLUMNS.length);
    expect(storage.writes).toBe(0);
    store.migrate();
    store.migrate();
    expect(storage.writes).toBe(1);
    expect(storage.getItem(LEGACY_COLUMN_WIDTHS_KEY)).toBe(legacy);
    expect(createTablePreferenceStore(storage).getSnapshot()).toEqual(store.getSnapshot());
  });

  test("defaults hide only genre, created date, and last-played date", () => {
    const preferences = readTablePreferences(null);
    expect(Object.entries(preferences.visibility).filter(([, visible]) => !visible).map(([id]) => id))
      .toEqual(["genre", "last", "created"]);
    expect(preferences.visibility.melody).toBe(true);
    expect(preferences.visibility.weirdness).toBe(true);
  });

  test("ignores malformed, oversized, wrongly typed and unsupported persisted state", () => {
    const defaults = readTablePreferences(null);
    for (const raw of ["{", "null", "[]", '"text"', JSON.stringify({ version: 3, widths: { track: 600 } }), " ".repeat(8193)]) {
      expect(readTablePreferences(raw)).toEqual(defaults);
    }
    const invalid = JSON.stringify({ version: 2, widths: { track: -1, bpm: "100", melody: null, weirdness: 1e30 },
      visibility: { track: false, genre: true, energy: 0, created: "yes", invented: true } });
    const preferences = readTablePreferences(invalid);
    expect(preferences.widths).toMatchObject({ track: 261, bpm: 52, melody: 135, weirdness: 640 });
    expect(preferences.visibility).toMatchObject({ track: true, genre: true, energy: true, created: false });
    expect(Object.keys(preferences.visibility)).toHaveLength(LIBRARY_COLUMNS.length);
  });

  test("title and bar columns shrink below their defaults; reset restores the defaults", () => {
    expect([clampColumnWidth("track", 100), clampColumnWidth("energy", 10), clampColumnWidth("status", 10)]).toEqual([261, 96, 116]);
    expect(clampColumnWidth("track", Number.NaN)).toBe(381);
    expect(readTablePreferences(null).widths).toMatchObject({ track: 381, energy: 136, darkness: 138, melody: 135, weirdness: 139 });
  });

  test("size reset preserves visibility and supports resetting a single column", () => {
    const store = createTablePreferenceStore(memoryStorage());
    store.setVisible("created", true);
    store.setVisible("energy", false);
    store.setWidth("track", 500);
    store.setWidth("bpm", 120);
    store.resetWidths("track");
    expect(store.getSnapshot().widths.track).toBe(381);
    expect(store.getSnapshot().widths.bpm).toBe(120);
    store.resetWidths();
    expect(store.getSnapshot().widths).toEqual(readTablePreferences(null).widths);
    expect(store.getSnapshot().visibility).toMatchObject({ created: true, energy: false });
    store.setVisible("track", false);
    expect(store.getSnapshot().visibility.track).toBe(true);
  });

  test("interleaved mounts preserve each other's latest widths and visibility", () => {
    const storage = memoryStorage();
    const first = createTablePreferenceStore(storage);
    const second = createTablePreferenceStore(storage);
    const previous = first.getSnapshot();
    expect(first.getSnapshot()).toBe(previous);
    second.setVisible("genre", true);
    first.setWidth("bpm", 124);
    second.setWidth("track", 450);
    first.setVisible("darkness", false);
    const remounted = createTablePreferenceStore(storage).getSnapshot();
    expect(remounted.visibility).toMatchObject({ genre: true, darkness: false });
    expect(remounted.widths).toMatchObject({ bpm: 124, track: 450 });
    expect(first.getSnapshot()).not.toBe(previous);
    expect(previous.widths.bpm).toBe(52);
  });

  test("notifies table/menu subscribers immediately and cleans up browser-change listeners", () => {
    const storage = memoryStorage();
    const events = new EventTarget();
    const original = Object.getOwnPropertyDescriptor(globalThis, "window");
    Object.defineProperty(globalThis, "window", { configurable: true, value: events });
    try {
      const store = createTablePreferenceStore(storage);
      let notifications = 0;
      const unsubscribe = store.subscribe(() => { notifications++; });
      store.setWidth("track", 460);
      expect(notifications).toBe(1);
      storage.setItem(TABLE_PREFERENCES_KEY, JSON.stringify({ version: 2, widths: { track: 550 }, visibility: { last: true } }));
      const change = Object.assign(new Event("storage"), { key: TABLE_PREFERENCES_KEY });
      events.dispatchEvent(change);
      expect(notifications).toBe(2);
      expect(store.getSnapshot().widths.track).toBe(550);
      expect(store.getSnapshot().visibility.last).toBe(true);
      unsubscribe();
      events.dispatchEvent(change);
      store.setVisible("genre", true);
      expect(notifications).toBe(2);
    } finally {
      if (original) Object.defineProperty(globalThis, "window", original);
      else Reflect.deleteProperty(globalThis, "window");
    }
  });

  test("desktop writes survive a new PreferenceStorage and table store without browser storage", async () => {
    const legacy = '{"compact-track":226.609375,"track":480,"energy":120}';
    const saved: Record<string, string> = { [LEGACY_COLUMN_WIDTHS_KEY]: legacy, "cm:unrelated": "preserve" };
    const fetcher = (async (_url: unknown, init?: RequestInit) => {
      if (init?.method === "PATCH") Object.assign(saved, JSON.parse(init.body as string));
      return Response.json(saved);
    }) as typeof fetch;
    const options = { desktop: () => true, fetcher, webStorage: () => { throw new Error("desktop must not access localStorage"); } };
    const preferences = new PreferenceStorage(options);
    await preferences.load();
    const store = createTablePreferenceStore(preferences);
    store.migrate();
    store.setVisible("genre", true);
    store.setWidth("melody", 150);
    await preferences.flush();
    const relaunchedPreferences = new PreferenceStorage(options);
    await relaunchedPreferences.load();
    const restored = createTablePreferenceStore(relaunchedPreferences).getSnapshot();
    expect(restored.widths).toMatchObject({ track: 480, energy: 120, melody: 150 });
    expect(restored.visibility.genre).toBe(true);
    expect(saved[LEGACY_COLUMN_WIDTHS_KEY]).toBe(legacy);
    expect(saved["cm:unrelated"]).toBe("preserve");
  });
});

test("web table widths and visibility survive a new localStorage-backed preference adapter", async () => {
  const rawStorage = memoryStorage();
  const webStorage = { ...rawStorage, removeItem: (key: string) => rawStorage.values.delete(key) } as unknown as Storage;
  const options = { desktop: () => false, webStorage: () => webStorage };
  const store = createTablePreferenceStore(new PreferenceStorage(options));
  store.setWidth("track", 510);
  store.setVisible("created", true);
  store.setVisible("darkness", false);
  const restored = createTablePreferenceStore(new PreferenceStorage(options)).getSnapshot();
  expect(restored.widths.track).toBe(510);
  expect(restored.visibility).toMatchObject({ created: true, darkness: false });
});

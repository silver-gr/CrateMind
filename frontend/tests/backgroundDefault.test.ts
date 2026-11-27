import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { DEFAULT_PREFS, moveOldDefaultBackground } from "../src/lib/prefs";

const read = (rel: string) => readFileSync(new URL(rel, import.meta.url), "utf8");
const KEY = "cratemind:prefs:v1";

function storage(initial: Record<string, string> = {}) {
  const values = new Map(Object.entries(initial));
  return { values, getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => { values.set(key, value); } };
}
const background = (store: ReturnType<typeof storage>) => JSON.parse(store.getItem(KEY) ?? "{}").background;

describe("Balatro is the default background", () => {
  test("for anyone who has not chosen one, and the shell and the picker fall back to it", () => {
    expect(DEFAULT_PREFS.background).toBe("balatro");
    expect(read("../src/components/layout/SoftAuroraBackground.tsx")).toContain("isBackgroundId(selected) ? selected : DEFAULT_PREFS.background");
    expect(read("../src/components/backgrounds/BackgroundPicker.tsx")).toContain("isBackgroundId(background) ? background : DEFAULT_PREFS.background");
  });

  test("the default renderer ships in the main bundle; Soft Aurora is loaded only when chosen", () => {
    const shell = read("../src/components/layout/SoftAuroraBackground.tsx");
    expect(shell).toContain('import Balatro from "../backgrounds/Balatro";');
    expect(shell).toContain('const SoftAurora = lazy(() => import("../SoftAurora"));');
    expect(shell).toMatch(/default: return <Balatro /);
  });

  test("a stored Soft Aurora, the old default saved with every other preference, becomes Balatro once", () => {
    const store = storage({ [KEY]: JSON.stringify({ background: "soft-aurora", density: "compact" }) });
    moveOldDefaultBackground(store);
    expect(background(store)).toBe("balatro");
    expect(JSON.parse(store.getItem(KEY)!).density).toBe("compact");
    // Picked again afterwards, it stays.
    store.setItem(KEY, JSON.stringify({ background: "soft-aurora" }));
    moveOldDefaultBackground(store);
    expect(background(store)).toBe("soft-aurora");
  });

  test("any other stored background is kept, and nothing is written for a fresh install", () => {
    for (const id of ["threads", "iridescence-violet", "balatro"]) {
      const store = storage({ [KEY]: JSON.stringify({ background: id }) });
      moveOldDefaultBackground(store);
      expect(background(store)).toBe(id);
    }
    const fresh = storage();
    moveOldDefaultBackground(fresh);
    expect(fresh.getItem(KEY)).toBeNull();
    const broken = storage({ [KEY]: "{not json" });
    moveOldDefaultBackground(broken);
    expect(broken.getItem(KEY)).toBe("{not json");
  });

  test("main.tsx moves it right after the preferences load, before anything reads them", () => {
    const main = read("../src/main.tsx");
    const load = main.indexOf("await loadPreferences();");
    const move = main.indexOf("moveOldDefaultBackground(preferenceStorage);");
    expect(load).toBeGreaterThan(-1);
    expect(move).toBeGreaterThan(load);
    expect(move).toBeLessThan(main.indexOf("getPref(", load));
  });
});

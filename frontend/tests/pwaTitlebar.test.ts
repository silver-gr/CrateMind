import { describe, expect, test } from "bun:test";
import { resolvePwaTitlebarGeometry } from "../src/lib/pwaTitlebar";

const rect = { x: 80, y: 0, width: 1040, height: 32 };
const active = { native: false, overlayMode: true, visible: true, fullscreen: false, rect };

describe("installed PWA titlebar", () => {
  test("reserves only valid visible overlay geometry", () => {
    expect(resolvePwaTitlebarGeometry(active)).toEqual(rect);
    expect(resolvePwaTitlebarGeometry({ ...active, rect: { x: 0, y: 4, width: 580, height: 28 } }))
      .toEqual({ x: 0, y: 4, width: 580, height: 28 });
    for (const patch of [{ native: true }, { overlayMode: false }, { visible: false }, { fullscreen: true }, { rect: undefined }]) {
      expect(resolvePwaTitlebarGeometry({ ...active, ...patch })).toBeNull();
    }
    for (const patch of [{ x: -1 }, { y: -1 }, { width: 0 }, { height: 0 }, { width: NaN }, { height: Infinity }]) {
      expect(resolvePwaTitlebarGeometry({ ...active, rect: { ...rect, ...patch } })).toBeNull();
    }
    expect(rect).toEqual({ x: 80, y: 0, width: 1040, height: 32 });
  });

  test("reacts to geometry, toggle, resize and fullscreen events and removes every listener", () => {
    const result = Bun.spawnSync(["bun", "--eval", `
      import assert from 'node:assert/strict';
      class Query extends EventTarget { matches = false; }
      const mode = new Query(); mode.matches = true;
      const fullscreen = new Query();
      const overlay = Object.assign(new EventTarget(), {
        visible: true, rect: { x: 80, y: 0, width: 1000, height: 32 },
        getTitlebarAreaRect() { return this.rect; }
      });
      const browser = Object.assign(new EventTarget(), {
        matchMedia: query => query.includes('window-controls-overlay') ? mode : fullscreen
      });
      const page = Object.assign(new EventTarget(), { documentElement: { dataset: {} }, fullscreenElement: null });
      globalThis.window = browser; globalThis.document = page;
      Object.defineProperty(globalThis, 'navigator', { value: { windowControlsOverlay: overlay }, configurable: true });
      const { readPwaTitlebarGeometry, subscribePwaTitlebar } = await import('./src/lib/pwaTitlebar.ts');
      assert.equal(readPwaTitlebarGeometry().height, 32);
      let changes = 0; const cleanup = subscribePwaTitlebar(() => { changes++; });
      overlay.rect.width = 700; overlay.dispatchEvent(new Event('geometrychange'));
      assert.equal(readPwaTitlebarGeometry().width, 700);
      browser.dispatchEvent(new Event('resize'));
      overlay.visible = false; overlay.dispatchEvent(new Event('geometrychange'));
      assert.equal(readPwaTitlebarGeometry(), null);
      overlay.visible = true;
      mode.matches = false; mode.dispatchEvent(new Event('change'));
      assert.equal(readPwaTitlebarGeometry(), null);
      mode.matches = true;
      fullscreen.matches = true; fullscreen.dispatchEvent(new Event('change'));
      assert.equal(readPwaTitlebarGeometry(), null);
      fullscreen.matches = false;
      page.fullscreenElement = {}; page.dispatchEvent(new Event('fullscreenchange'));
      assert.equal(readPwaTitlebarGeometry(), null);
      page.fullscreenElement = null;
      assert.equal(changes, 6);
      cleanup();
      for (const [target, event] of [[overlay,'geometrychange'],[browser,'resize'],[page,'fullscreenchange'],[mode,'change'],[fullscreen,'change']]) target.dispatchEvent(new Event(event));
      assert.equal(changes, 6);
      page.documentElement.dataset.nativeTitlebar = 'overlay';
      assert.equal(readPwaTitlebarGeometry(), null);
      const cleanupNative = subscribePwaTitlebar(() => { throw Error('native installed PWA listeners'); });
      overlay.dispatchEvent(new Event('geometrychange')); cleanupNative();
      delete page.documentElement.dataset.nativeTitlebar;
      page.documentElement.dataset.desktop = 'true';
      assert.equal(readPwaTitlebarGeometry(), null);
      delete page.documentElement.dataset.desktop;
      delete navigator.windowControlsOverlay;
      assert.equal(readPwaTitlebarGeometry(), null);
      subscribePwaTitlebar(() => { throw Error('unsupported browser installed overlay listeners'); })();
    `], { cwd: import.meta.dir + "/.." });
    expect(result.stderr.toString()).toBe("");
    expect(result.exitCode).toBe(0);
  });

  test("light and dark synchronize one theme-color meta and the control-patch color", () => {
    const result = Bun.spawnSync(["bun", "--eval", `
      import assert from 'node:assert/strict';
      const classes = new Set(); const properties = new Map();
      const root = { dataset: {}, setAttribute(name, value) { this.dataset.theme = value; },
        classList: { add: name => classes.add(name), remove: name => classes.delete(name) },
        style: { setProperty: (name, value) => properties.set(name, value) } };
      let meta = null; let creations = 0;
      globalThis.document = { documentElement: root,
        querySelector: selector => { assert.equal(selector, 'meta[name="theme-color"]'); return meta; },
        createElement: tag => { assert.equal(tag, 'meta'); creations++; return {}; },
        head: { append: value => { meta = value; } } };
      const { applyTheme, BROWSER_THEME_COLORS } = await import('./src/lib/theme.ts');
      applyTheme('light');
      assert.equal(meta.name, 'theme-color');
      assert.equal(meta.content, '#f2f5fe');
      assert.equal(properties.get('--cm-browser-theme-color'), meta.content);
      assert.equal(root.dataset.theme, 'light'); assert.equal(classes.has('light'), true);
      const firstMeta = meta;
      applyTheme('dark');
      assert.equal(meta, firstMeta); assert.equal(creations, 1);
      assert.equal(meta.content, BROWSER_THEME_COLORS.dark);
      assert.equal(properties.get('--cm-browser-theme-color'), meta.content);
      assert.equal(classes.has('dark'), true); assert.equal(classes.has('light'), false);
    `], { cwd: import.meta.dir + "/.." });
    expect(result.stderr.toString()).toBe("");
    expect(result.exitCode).toBe(0);
  });
});

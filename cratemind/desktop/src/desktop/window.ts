// Native window sizing + macOS menu bar for the packaged Deno Desktop runtime.
//
// No-op under plain `deno run` (dev server, tests): `Deno.BrowserWindow` exists
// only in the desktop runtime. The desktop API types are declared locally so
// `deno check main.ts` passes against the stable lib without the ambient
// desktop typings.

/** The slice of the Deno Desktop menu union we build. */
type MenuItem =
  | { item: { label: string; id?: string; accelerator?: string; enabled: boolean } }
  | { submenu: { label: string; items: MenuItem[] } }
  | "separator"
  | { role: { role: string } };

interface BrowserWindow {
  getSize(): [number, number];
  getPosition(): [number, number];
  setSize(width: number, height: number): void;
  setPosition(x: number, y: number): void;
  setApplicationMenu(items: MenuItem[]): void;
  executeJs(code: string): Promise<unknown>;
  addEventListener(
    type: string,
    listener: (e: { detail: Record<string, unknown> }) => void,
  ): void;
}

interface BrowserWindowOptions {
  title?: string;
  width?: number;
  height?: number;
  x?: number;
  y?: number;
  resizable?: boolean;
}

type DesktopDeno = typeof Deno & {
  BrowserWindow: new (opts?: BrowserWindowOptions) => BrowserWindow;
};

function hasDesktopRuntime(d: typeof Deno): d is DesktopDeno {
  return "BrowserWindow" in d;
}

const DEFAULT_WIDTH = 2175;
const DEFAULT_HEIGHT = 1275;

/** Screens surfaced in the "Οθόνες" menu — mirrors the sidebar nav groups. */
const SCREENS: ReadonlyArray<
  { label: string; path: string; accelerator?: string } | "separator"
> = [
  { label: "Πίνακας", path: "/dashboard", accelerator: "CmdOrCtrl+1" },
  "separator",
  { label: "Βιβλιοθήκη", path: "/library" },
  { label: "Καλλιτέχνες", path: "/artists" },
  { label: "Crates", path: "/crates" },
  { label: "Sets / Playlists", path: "/playlists" },
  { label: "Έξυπνοι φάκελοι", path: "/smart-folders" },
  "separator",
  { label: "Ουρά tagging", path: "/tag" },
  { label: "Χτίσιμο set", path: "/sets" },
  { label: "Flow Finder", path: "/flow" },
  { label: "Energy Maps", path: "/energy-maps" },
  { label: "Key & Harmony", path: "/key-harmony" },
  { label: "Tag Cloud", path: "/tag-cloud" },
  { label: "Phrase Finder", path: "/phrase-finder" },
  "separator",
  { label: "Διπλότυπα", path: "/duplicates" },
  { label: "Ρυθμίσεις", path: "/settings", accelerator: "CmdOrCtrl+," },
];

function screensMenu(): MenuItem[] {
  return SCREENS.map((s): MenuItem =>
    s === "separator"
      ? "separator"
      : { item: { label: s.label, id: `nav:${s.path}`, accelerator: s.accelerator, enabled: true } }
  );
}

function buildMenu(): MenuItem[] {
  return [
    // macOS replaces the first submenu's label with the app name.
    {
      submenu: {
        label: "CrateMind",
        items: [
          { item: { label: "Σχετικά με το CrateMind", id: "about", enabled: true } },
          "separator",
          ...screensMenu(),
          "separator",
          { role: { role: "quit" } },
        ],
      },
    },
    {
      submenu: {
        label: "Επεξεργασία",
        items: [
          { role: { role: "undo" } },
          { role: { role: "redo" } },
          "separator",
          { role: { role: "cut" } },
          { role: { role: "copy" } },
          { role: { role: "paste" } },
          { role: { role: "selectAll" } },
        ],
      },
    },
  ];
}

interface Geometry {
  width?: number;
  height?: number;
  x?: number;
  y?: number;
}

/**
 * Center the window on its display's work area. Deno Desktop exposes no
 * `center()` or display API, so the work area is read from the webview via
 * `executeJs` (`screen.*`). Returns true once positioned; false if the webview
 * realm never became ready.
 */
async function centerWindow(
  win: BrowserWindow,
  width: number,
  height: number,
): Promise<boolean> {
  for (let attempt = 0; attempt < 10; attempt++) {
    try {
      const raw = await win.executeJs(
        "[screen.availWidth, screen.availHeight, screen.availLeft || 0, screen.availTop || 0]",
      );
      // executeJs resolves with an `{ ok, value }` envelope in Deno 2.9, not the
      // bare value — unwrap it (tolerating a bare value too).
      const dims = raw && typeof raw === "object" && "value" in raw
        ? (raw as { value: unknown }).value
        : raw;
      if (
        Array.isArray(dims) && dims.length === 4 &&
        dims.every((n) => typeof n === "number") && (dims[0] as number) > 0
      ) {
        const [aw, ah, al, at] = dims as number[];
        win.setPosition(
          Math.round(al + (aw - width) / 2),
          Math.round(at + (ah - height) / 2),
        );
        return true;
      }
    } catch {
      // Webview realm not ready yet — retry briefly below.
    }
    await new Promise<void>((resolve) => setTimeout(resolve, 100));
  }
  return false;
}

/**
 * Adopt the desktop startup window: apply a sensible (or persisted) size, wire
 * the macOS menu bar (app menu + screen switcher + Edit roles), and remember
 * the window geometry across launches. No-op outside the desktop runtime.
 */
export function setupDesktop(dataDir: string): void {
  const rt = Deno;
  if (!hasDesktopRuntime(rt)) return; // dev server / tests / non-desktop run

  const geometryFile = `${dataDir}/window.json`;
  let saved: Geometry = {};
  try {
    saved = JSON.parse(rt.readTextFileSync(geometryFile)) as Geometry;
  } catch {
    // First launch, or unreadable — fall back to defaults.
  }

  const width = saved.width ?? DEFAULT_WIDTH;
  const height = saved.height ?? DEFAULT_HEIGHT;

  // First construction adopts the implicit startup window (Deno 2.9).
  const win = new rt.BrowserWindow({
    title: "CrateMind",
    width,
    height,
    resizable: true,
  });

  // Force the size on the adopted window: constructor dimensions may be treated
  // as creation-only when adopting the pre-opened startup window.
  win.setSize(width, height);

  win.setApplicationMenu(buildMenu());

  win.addEventListener("menuclick", (e) => {
    const id = typeof e.detail.id === "string" ? e.detail.id : "";
    if (id === "about") {
      void win.executeJs(
        `alert(${JSON.stringify("CrateMind\nDJ intelligence layer\nv0.1.0")})`,
      );
    } else if (id.startsWith("nav:")) {
      const path = id.slice("nav:".length);
      void win.executeJs(`location.assign(${JSON.stringify(path)})`);
    }
  });

  const persist = () => {
    const [w, h] = win.getSize();
    const [x, y] = win.getPosition();
    try {
      rt.writeTextFileSync(geometryFile, JSON.stringify({ width: w, height: h, x, y }));
    } catch {
      // Non-fatal: geometry persistence is best-effort.
    }
  };

  // Persist only genuine user moves/resizes: attach listeners AFTER the initial
  // position is settled, so the startup window's top-left origin is never saved.
  const startPersisting = () => {
    win.addEventListener("resize", persist);
    win.addEventListener("move", persist);
  };

  if (saved.x !== undefined && saved.y !== undefined) {
    win.setPosition(saved.x, saved.y);
    startPersisting();
  } else {
    void centerWindow(win, width, height).then((centered) => {
      if (centered) persist(); // remember the centered spot; no flash next launch
      startPersisting();
    });
  }
}

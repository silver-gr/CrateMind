import type { SortKey } from "./trackSort";

export const TABLE_PREFERENCES_KEY = "cratemind:table:full:v2";
export const LEGACY_COLUMN_WIDTHS_KEY = "cratemind:colw:v1";
export const MAX_COLUMN_WIDTH = 640;

/** Defaults also form the minimums; saved user adjustments supplied the smaller columns. */
export const LIBRARY_COLUMNS = [
  { id: "track", label: "Κομμάτι", width: 381, sortKey: "title" },
  { id: "status", label: "Κατάσταση", width: 104, sortKey: "status" },
  { id: "energy", label: "Ενέργεια", width: 54, sortKey: "energy" },
  { id: "darkness", label: "Σκοτεινότητα", width: 86, sortKey: "darkness" },
  { id: "melody", label: "Μελωδία", width: 104, sortKey: "melody" },
  { id: "weirdness", label: "Ιδιορρυθμία", width: 128, sortKey: "weirdness" },
  { id: "role", label: "Ρόλος", width: 86, sortKey: "role" },
  { id: "bpm", label: "BPM", width: 52, sortKey: "bpm" },
  { id: "key", label: "Key", width: 52, sortKey: "key" },
  { id: "genre", label: "Είδος", width: 72, sortKey: "genre", hidden: true },
  { id: "substyle", label: "Substyle", width: 96, sortKey: "substyle" },
  { id: "soundcloud-plays", label: "SC Plays", width: 52, sortKey: "soundcloud_plays" },
  { id: "soundcloud-likes", label: "SC Likes", width: 49, sortKey: "soundcloud_likes" },
  { id: "last", label: "Τελευταίο", width: 74, sortKey: "last", hidden: true },
  { id: "added", label: "Προστέθηκε", width: 80, sortKey: "added" },
  { id: "created", label: "Δημιουργήθηκε", width: 81, sortKey: "created", hidden: true },
] as const satisfies ReadonlyArray<{ id: string; label: string; width: number; sortKey: SortKey; hidden?: boolean }>;

export type LibraryColumnId = typeof LIBRARY_COLUMNS[number]["id"];
export type TablePreferences = {
  version: 2;
  widths: Record<LibraryColumnId, number>;
  visibility: Record<LibraryColumnId, boolean>;
};
type PreferenceSource = {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  subscribe?: (listener: () => void) => () => void;
  flush?: () => Promise<void>;
};

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function parse(raw: string | null): Record<string, unknown> | null {
  if (!raw || raw.length > 8192) return null;
  try {
    const value: unknown = JSON.parse(raw);
    return record(value) ? value : null;
  } catch { return null; }
}
export function clampColumnWidth(id: LibraryColumnId, value: number): number {
  const minimum = LIBRARY_COLUMNS.find(column => column.id === id)!.width;
  return Number.isFinite(value) ? Math.round(Math.max(minimum, Math.min(MAX_COLUMN_WIDTH, value))) : minimum;
}

export function readTablePreferences(raw: string | null, legacyRaw: string | null = null): TablePreferences {
  const parsed = parse(raw);
  const current = parsed?.version === 2 ? parsed : null;
  const widths: Record<string, unknown> = current && record(current.widths) ? current.widths : current ? {} : parse(legacyRaw) ?? {};
  const visibility: Record<string, unknown> = current && record(current.visibility) ? current.visibility : {};
  return {
    version: 2,
    widths: Object.fromEntries(LIBRARY_COLUMNS.map(column => [
      column.id, typeof widths[column.id] === "number" ? clampColumnWidth(column.id, widths[column.id] as number) : column.width,
    ])) as TablePreferences["widths"],
    visibility: Object.fromEntries(LIBRARY_COLUMNS.map(column => [
      column.id, column.id === "track" ? true : typeof visibility[column.id] === "boolean" ? visibility[column.id] : !("hidden" in column && column.hidden),
    ])) as TablePreferences["visibility"],
  };
}

/** Reads before every edit so separate table instances cannot overwrite each other's preferences. */
export function createTablePreferenceStore(storage: PreferenceSource) {
  const listeners = new Set<() => void>();
  let lastRaw: string | null | undefined;
  let lastLegacy: string | null | undefined;
  let snapshot: TablePreferences | undefined;
  function getSnapshot() {
    const raw = storage.getItem(TABLE_PREFERENCES_KEY);
    const legacy = storage.getItem(LEGACY_COLUMN_WIDTHS_KEY);
    if (!snapshot || raw !== lastRaw || legacy !== lastLegacy) {
      lastRaw = raw;
      lastLegacy = legacy;
      snapshot = readTablePreferences(raw, legacy);
    }
    return snapshot;
  }
  function emit() { listeners.forEach(listener => listener()); }
  function save(next: TablePreferences) {
    storage.setItem(TABLE_PREFERENCES_KEY, JSON.stringify(next));
    emit();
    void storage.flush?.().catch(() => {});
  }
  return {
    getSnapshot,
    subscribe(listener: () => void) {
      listeners.add(listener);
      const unsubscribe = storage.subscribe?.(listener);
      const onStorage = (event: StorageEvent) => {
        if (event.key === null || event.key === TABLE_PREFERENCES_KEY || event.key === LEGACY_COLUMN_WIDTHS_KEY) listener();
      };
      if (typeof window !== "undefined") window.addEventListener("storage", onStorage);
      return () => {
        listeners.delete(listener);
        unsubscribe?.();
        if (typeof window !== "undefined") window.removeEventListener("storage", onStorage);
      };
    },
    migrate() {
      // Reading is side-effect free (including React's repeated snapshot reads).
      const current = getSnapshot();
      const serialized = JSON.stringify(current);
      if (storage.getItem(TABLE_PREFERENCES_KEY) !== serialized) save(current);
    },
    setWidth(id: LibraryColumnId, width: number) {
      const current = getSnapshot();
      save({ ...current, widths: { ...current.widths, [id]: clampColumnWidth(id, width) } });
    },
    setVisible(id: LibraryColumnId, visible: boolean) {
      if (id === "track") return;
      const current = getSnapshot();
      save({ ...current, visibility: { ...current.visibility, [id]: visible } });
    },
    resetWidths(id?: LibraryColumnId) {
      const current = getSnapshot();
      const defaults = readTablePreferences(null).widths;
      save({ ...current, widths: id ? { ...current.widths, [id]: defaults[id] } : defaults });
    },
  };
}

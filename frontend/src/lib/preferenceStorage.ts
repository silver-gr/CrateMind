import { isDesktopRuntime } from "./desktopRuntime";

type Patch = Record<string, string | null>;
type Options = { desktop?: () => boolean; fetcher?: typeof fetch; webStorage?: () => Storage | undefined };

export class PreferenceStorage {
  private values: Record<string, string> = {};
  private pending: Patch = {};
  private hydrated = false;
  private inFlight: Promise<void> | null = null;
  private listeners = new Set<() => void>();
  private message = "";
  private options: Options;

  constructor(options: Options = {}) { this.options = options; }
  private desktop() { return (this.options.desktop ?? isDesktopRuntime)(); }
  private fetcher(input: RequestInfo | URL, init?: RequestInit) {
    return (this.options.fetcher ?? fetch)(input, init);
  }
  private web() {
    return this.options.webStorage ? this.options.webStorage() :
      typeof localStorage !== "undefined" ? localStorage : undefined;
  }
  private fail(message: string) {
    this.message = message;
    this.listeners.forEach(listener => listener());
  }
  getError = () => this.message;
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  };

  async load(): Promise<void> {
    if (!this.desktop()) return;
    const response = await this.fetcher("/api/desktop/preferences", { cache: "no-store" });
    if (!response.ok) throw new Error("Δεν ήταν δυνατή η φόρτωση των προτιμήσεων.");
    const values: unknown = await response.json();
    if (!values || typeof values !== "object" || Array.isArray(values) || Object.keys(values).length > 128 ||
        Object.entries(values).some(([key, value]) => !/^(cratemind|cm:)/.test(key) || typeof value !== "string" || value.length > 32768)) {
      throw new Error("Το αρχείο προτιμήσεων χρειάζεται έλεγχο πριν ανοίξει η βιβλιοθήκη.");
    }
    this.values = values as Record<string, string>;
    this.hydrated = true;
  }

  getItem(key: string): string | null {
    if (!this.desktop()) {
      try { return this.web()?.getItem(key) ?? null; } catch { return null; }
    }
    if (!this.hydrated) throw new Error("Οι προτιμήσεις δεν έχουν φορτωθεί.");
    return this.values[key] ?? null;
  }
  setItem(key: string, value: string): void { this.write(key, value); }
  removeItem(key: string): void { this.write(key, null); }

  private write(key: string, value: string | null): void {
    if (!this.desktop()) {
      try {
        if (value === null) this.web()?.removeItem(key);
        else this.web()?.setItem(key, value);
      } catch { /* Web private mode/quota preserves the existing memory behavior. */ }
      return;
    }
    if (!this.hydrated) throw new Error("Οι προτιμήσεις δεν έχουν φορτωθεί.");
    if (value === null) delete this.values[key];
    else this.values[key] = value;
    this.pending[key] = value;
    // Synchronous readers see the latest value; durable patches are serialized.
    queueMicrotask(() => { void this.flush().catch(() => {}); });
  }

  flush(): Promise<void> {
    if (!this.desktop()) return Promise.resolve();
    if (this.inFlight) return this.inFlight;
    this.inFlight = this.flushPending().finally(() => { this.inFlight = null; });
    return this.inFlight;
  }
  private async flushPending(): Promise<void> {
    while (Object.keys(this.pending).length) {
      const patch = this.pending;
      this.pending = {};
      try {
        const response = await this.fetcher("/api/desktop/preferences", {
          method: "PATCH", headers: { "Content-Type": "application/json" },
          body: JSON.stringify(patch), keepalive: true,
        });
        if (!response.ok) throw new Error("Αποτυχία αποθήκευσης προτιμήσεων.");
        this.fail("");
      } catch (error) {
        // Newer edits win when a failed request is retried.
        this.pending = { ...patch, ...this.pending };
        this.fail("Οι τελευταίες προτιμήσεις δεν αποθηκεύτηκαν. Δοκίμασε ξανά.");
        throw error;
      }
    }
  }
}

export const preferenceStorage = new PreferenceStorage();
export const loadPreferences = () => preferenceStorage.load();

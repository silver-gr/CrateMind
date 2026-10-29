# CrateMind → Deno Desktop Self-Contained Experiment

> Historical experiment guide. The Deno application and its `desktop/` source
> were retired on 2026-10-29. These instructions are retained as design history;
> use [Tauri desktop operations](docs/TAURI_DESKTOP_OPERATIONS.md) for the current
> application. Existing Deno databases remain supported by the bounded Python
> adoption adapter, with schema evidence in `backend/tests/fixtures/deno_legacy/`.

## Complete coding-agent guide

## 0. Executive decision

Build the experiment as a **Deno-native desktop app**, not as a Deno shell around FastAPI.

Current CrateMind was built fast and is still small enough that a Deno-native port is realistic. For the experiment, the best architecture is:

```text
Deno Desktop app
  ├─ Deno.serve() same-origin local HTTP server
  ├─ Vite React build served as static SPA
  ├─ Deno/TypeScript REST API under /api/*
  ├─ SQLite local database via node:sqlite
  ├─ audio streaming endpoint with Range support
  ├─ ffprobe/fpcalc as optional bundled local sidecar binaries
  └─ no Python server, no external API base URL, no cloud, no CORS
```

Use Deno Desktop as the actual app runtime, not just a wrapper.

The goal of this experiment:

> One desktop app bundle that opens CrateMind, serves its own UI/API locally, stores everything in local SQLite, streams local audio, and makes no external API calls.

---

# 1. What “self-contained” means here

For this experiment, “self-contained” means:

- The app launches as a desktop app.
- The UI is inside the app window.
- The API is served by the same Deno Desktop entrypoint.
- The frontend uses same-origin calls only:
  - `/api/tracks`
  - `/api/search`
  - `/api/sets`
  - `/tracks/:id/audio`
- No `VITE_API_URL`.
- No CORS.
- No separate FastAPI process.
- No Node dev server in production.
- No cloud/auth/analytics/telemetry.
- SQLite is local.
- Audio files stay in the user’s filesystem.
- App data lives in an app data directory, not in browser localStorage.

Important nuance:

Deno Desktop apps are still served over local HTTP internally. That is normal. “No external API calls” means no remote services and no separate backend server dependency, not “never use HTTP inside the app.”

---

# 2. Why not use the existing FastAPI backend?

FastAPI is currently working, but for a Deno Desktop experiment it creates the wrong kind of complexity.

## Option A — Deno shell + FastAPI sidecar

Pros:
- Least business-logic porting.
- Keeps Python Mutagen/SQLModel/FastAPI.
- Fastest if you only want a window.

Cons:
- Not truly Deno-native.
- You must package Python runtime/dependencies.
- You must manage backend process lifecycle.
- You still have a separate local API server.
- Cross-platform packaging becomes a yak farm.
- SQLite file contention/process shutdown bugs become more likely.
- Feels like Electron-style shell architecture, not the interesting Deno Desktop experiment.

## Option B — Full Deno-native app

Pros:
- One runtime.
- One app entrypoint.
- Same-origin UI/API.
- No Python sidecar.
- Easier mental model for desktop.
- Cleaner permission model.
- Good fit while app is young.
- Lets you test Deno Desktop properly.

Cons:
- Need to port backend logic.
- Need to replace SQLModel models with TS interfaces and SQL.
- Need to replace Mutagen with ffprobe-based metadata extraction.
- Need to reimplement tests in Deno.

## Decision

For this experiment, choose **Option B: Full Deno-native app**.

Keep the Python version alive as the stable reference implementation until the Deno version reaches feature parity.

---

# 3. Backend choice

## Use Deno.serve, not a big framework at first

Do not add Oak/Hono until needed.

The API surface is small enough to implement with:

```ts
Deno.serve(async (req) => {
  const url = new URL(req.url);
  const method = req.method;

  if (url.pathname.startsWith("/api/")) {
    return routeApi(req, url);
  }

  if (url.pathname.match(/^\/tracks\/\d+\/audio$/)) {
    return routeAudio(req, url);
  }

  return serveSpa(req);
});
```

This keeps the experiment simple and close to Deno Desktop’s native serving model.

If routing becomes ugly, add Hono later. Do not start there unless the current repo already uses strong route conventions that are easier to mirror with a router.

---

# 4. Rendering backend choice

Use **CEF first** for the experiment.

Reason:
- CrateMind is visually ambitious.
- The UI uses modern CSS, glassmorphism, gradients, audio player, possibly Motion animations.
- You want consistent rendering while testing the desktop concept.
- DevTools are useful during the port.
- Binary size is not the main priority for the experiment.

Later, test WebView for a smaller build.

Recommended config:

```json
{
  "name": "cratemind-desktop",
  "version": "0.1.0",
  "tasks": {
    "dev": "deno desktop --hmr --backend cef desktop/main.ts",
    "build:ui": "cd frontend && npm run build",
    "desktop": "deno desktop --backend cef --allow-read --allow-write --allow-run --allow-env --include ./frontend/dist --include ./desktop/assets --output ./dist/CrateMind.app desktop/main.ts",
    "check": "deno check desktop/main.ts",
    "test": "deno test --allow-read --allow-write --allow-run desktop/tests/"
  },
  "desktop": {
    "app": {
      "name": "CrateMind",
      "identifier": "gr.x3lixi.cratemind"
    },
    "backend": "cef",
    "output": {
      "macos": "./dist/CrateMind.app",
      "windows": "./dist/CrateMind",
      "linux": "./dist/cratemind.AppImage"
    }
  }
}
```

Adjust output paths for the actual repo.

If `--include` is not accepted in the exact installed Deno Desktop CLI version, inspect `deno desktop --help` and adapt. Do not guess.

---

# 5. Repository layout

Recommended structure:

```text
cratemind/
  frontend/
    package.json
    vite.config.ts
    src/
    dist/                         # generated by npm run build

  backend/                        # keep Python version for reference
    app/
    tests/

  desktop/
    main.ts                       # Deno Desktop entrypoint
    deno.json                     # or root deno.json if preferred

    src/
      api/
        router.ts
        tracks.ts
        searches.ts
        sets.ts
        exports.ts
        play.ts
        pairNotes.ts
        audio.ts

      db/
        database.ts
        migrations.ts
        schema.sql
        seed.ts

      services/
        scanner.ts
        metadata.ts
        ffprobe.ts
        fingerprint.ts
        searchParser.ts
        searchExecutor.ts
        recommender.ts
        exporterM3u.ts
        exporterMarkdown.ts
        streaming.ts
        appPaths.ts
        fileSafety.ts

      types/
        models.ts
        api.ts

      utils/
        http.ts
        json.ts
        path.ts
        mime.ts
        errors.ts

    assets/
      bin/
        macos-arm64/
          ffprobe
          fpcalc
        macos-x64/
          ffprobe
          fpcalc
        windows-x64/
          ffprobe.exe
          fpcalc.exe
        linux-x64/
          ffprobe
          fpcalc

    tests/
      searchParser.test.ts
      streaming.test.ts
      scanner.test.ts
      api.test.ts
```

Keep Python backend untouched until Deno reaches parity.

---

# 6. Data layer

## Use node:sqlite first

Use Deno’s Node-compatible `node:sqlite` module for the experiment.

Reasons:
- Avoid third-party SQLite modules that may download native libraries.
- Avoid runtime FFI/network surprises.
- Keep the build closer to self-contained.
- SQLite is simple enough here.

Example:

```ts
import { DatabaseSync } from "node:sqlite";

export const db = new DatabaseSync(appDbPath());

db.exec(`
  PRAGMA journal_mode = WAL;
  PRAGMA foreign_keys = ON;
  PRAGMA busy_timeout = 5000;
`);
```

## Verify FTS5 on startup

Because CrateMind uses FTS5, add a startup check:

```ts
export function verifySqliteFeatures(db: DatabaseSync) {
  const options = db.prepare("PRAGMA compile_options").all() as Array<{ compile_options: string }>;
  const hasFts5 = options.some((row) => String(row.compile_options).includes("FTS5"));

  try {
    db.exec("CREATE VIRTUAL TABLE IF NOT EXISTS __fts5_probe USING fts5(x)");
    db.exec("DROP TABLE IF EXISTS __fts5_probe");
  } catch (error) {
    throw new Error(`SQLite FTS5 is not available: ${String(error)}`);
  }

  return { hasFts5 };
}
```

If FTS5 is unavailable, fail loudly. Do not silently downgrade search.

## App data path

Do not rely on browser storage. Store the DB in an OS app-data location.

Implement:

```ts
function getAppDataDir(): string {
  const home = Deno.env.get("HOME") ?? Deno.env.get("USERPROFILE");
  if (!home) throw new Error("Cannot find home directory");

  if (Deno.build.os === "darwin") {
    return `${home}/Library/Application Support/CrateMind`;
  }

  if (Deno.build.os === "windows") {
    const appData = Deno.env.get("APPDATA") ?? `${home}\\AppData\\Roaming`;
    return `${appData}\\CrateMind`;
  }

  return `${Deno.env.get("XDG_DATA_HOME") ?? `${home}/.local/share`}/cratemind`;
}
```

Create:

```text
app-data/
  cratemind.sqlite
  backups/
  exports/
  logs/
```

Add migration/version table:

```sql
CREATE TABLE IF NOT EXISTS schema_migrations (
  version INTEGER PRIMARY KEY,
  applied_at TEXT NOT NULL
);
```

---

# 7. Schema migration from Python to Deno

Port the current SQLite schema, not the SQLModel ORM.

Core tables likely include:

- tracks
- track_dj_profile
- tags
- track_tags
- play_events
- saved_searches
- sets
- set_tracks
- track_pair_notes
- duplicate_groups / duplicate_group_tracks if present
- FTS table(s)

Important: preserve field names if the frontend already expects them.

Recommended migration strategy:

1. Inspect current Python models and migrations/schema.
2. Create `desktop/src/db/schema.sql`.
3. Create idempotent migration files:
   - `001_initial.sql`
   - `002_memory_crates.sql`
   - `003_audio_playback_stats.sql`
4. Add migration runner.
5. Add tests that create a fresh DB and verify all expected tables/columns exist.
6. Add optional importer for an existing Python-generated SQLite DB if schema-compatible.

Do not attempt automatic destructive migration of the existing real DB first. Copy it.

---

# 8. API compatibility layer

Keep the frontend changes minimal by matching the current REST routes.

## URL strategy

Current frontend should call relative URLs:

```ts
fetch("/api/tracks")
fetch(`/api/tracks/${id}/play`, { method: "POST" })
fetch(`/tracks/${id}/audio`)
```

If current code uses `VITE_API_URL`, replace it with:

```ts
const API_BASE = "";
```

or a helper:

```ts
export function apiUrl(path: string) {
  return path.startsWith("/") ? path : `/${path}`;
}
```

No CORS needed. No remote host.

## Route map

Implement Deno API routes matching existing frontend calls.

Likely routes:

```http
GET    /api/tracks
GET    /api/tracks/:id
PATCH  /api/tracks/:id/profile
POST   /api/tracks/:id/play
GET    /api/search?q=...
GET    /api/searches
POST   /api/searches
PATCH  /api/searches/:id
DELETE /api/searches/:id

GET    /api/sets
POST   /api/sets
GET    /api/sets/:id
POST   /api/sets/:id/tracks
PATCH  /api/sets/:id/tracks/reorder
DELETE /api/sets/:id/tracks/:trackId
GET    /api/sets/:id/recommendations
POST   /api/sets/:id/export/m3u8
POST   /api/sets/:id/export/markdown

GET    /api/pair-notes
POST   /api/pair-notes

POST   /api/scan
GET    /api/scan/status

GET    /tracks/:id/audio
```

Do not invent a new API unless there is a strong reason. The point is to keep the UI portable.

---

# 9. Static UI serving

Build React first:

```bash
cd frontend
npm run build
```

Deno Desktop entrypoint should serve `frontend/dist`.

Implementation:

```ts
import { serveDir } from "jsr:@std/http/file-server";

async function serveSpa(req: Request): Promise<Response> {
  const response = await serveDir(req, {
    fsRoot: new URL("../frontend/dist", import.meta.url).pathname,
    urlRoot: "",
    showDirListing: false,
    enableCors: false,
  });

  if (response.status !== 404) return response;

  // React Router fallback
  const indexPath = new URL("../frontend/dist/index.html", import.meta.url);
  const html = await Deno.readTextFile(indexPath);
  return new Response(html, {
    headers: { "content-type": "text/html; charset=utf-8" },
  });
}
```

If path resolution differs after Deno Desktop embedding/extraction, fix based on actual runtime behavior. Use `import.meta.dirname` / `import.meta.url`, not `Deno.cwd()`.

---

# 10. Audio streaming

Port the Python `streaming.py` behavior to Deno.

Requirements:

- endpoint: `GET /tracks/:id/audio`
- DB-id lookup only
- no arbitrary paths
- 200 full response
- 206 valid Range
- 416 invalid Range
- 404 missing track
- 410 missing file
- 415 unsupported extension
- Accept-Ranges
- Content-Range
- Content-Length
- Content-Type
- never load full large files into memory

Supported extensions:

```ts
const AUDIO_MIME: Record<string, string> = {
  ".mp3": "audio/mpeg",
  ".m4a": "audio/mp4",
  ".mp4": "audio/mp4",
  ".aac": "audio/aac",
  ".ogg": "audio/ogg",
  ".opus": "audio/ogg",
  ".wav": "audio/wav",
  ".flac": "audio/flac",
};
```

AIFF/AIF should remain 415 for browser playback.

## Range parsing

Support:

```text
Range: bytes=0-99
Range: bytes=100-
Range: bytes=-500
```

Reject:

```text
Range: bytes=0-99,200-300
Range: items=0-99
Range: bytes=999999999-
```

Use `Deno.open` and a `ReadableStream` with chunked reads.

Pseudo-code:

```ts
async function streamFileRange(path: string, start: number, end: number): Promise<ReadableStream<Uint8Array>> {
  const file = await Deno.open(path, { read: true });
  await file.seek(start, Deno.SeekMode.Start);

  let remaining = end - start + 1;

  return new ReadableStream({
    async pull(controller) {
      const chunkSize = Math.min(64 * 1024, remaining);
      if (chunkSize <= 0) {
        file.close();
        controller.close();
        return;
      }

      const buffer = new Uint8Array(chunkSize);
      const n = await file.read(buffer);

      if (n === null) {
        file.close();
        controller.close();
        return;
      }

      remaining -= n;
      controller.enqueue(buffer.subarray(0, n));
    },
    cancel() {
      try { file.close(); } catch {}
    },
  });
}
```

Tests must mirror existing Python tests.

---

# 11. Scanner and metadata extraction

Python used Mutagen + ffprobe. In Deno experiment, replace Mutagen with **ffprobe JSON**.

Why:
- ffprobe is already part of your stack.
- It returns stream info and format tags.
- It avoids needing a full JS audio-tag equivalent early.
- It is good enough for v1 metadata reading.

## ffprobe command

```ts
const cmd = new Deno.Command(ffprobePath(), {
  args: [
    "-v", "quiet",
    "-print_format", "json",
    "-show_format",
    "-show_streams",
    filePath,
  ],
  stdout: "piped",
  stderr: "piped",
});
```

Parse:

```ts
format.duration
format.bit_rate
format.tags.artist
format.tags.title
format.tags.album
format.tags.genre
format.tags.date
format.tags.comment
streams[0].codec_name
streams[0].sample_rate
streams[0].channels
```

Normalize common tag casing:

```ts
function tag(tags: Record<string, unknown>, ...keys: string[]) {
  const lower = Object.fromEntries(Object.entries(tags ?? {}).map(([k, v]) => [k.toLowerCase(), v]));
  for (const key of keys) {
    const val = lower[key.toLowerCase()];
    if (typeof val === "string" && val.trim()) return val.trim();
  }
}
```

Common keys:

```text
artist, ARTIST, album_artist
title, TITLE
album, ALBUM
genre, GENRE
date, DATE, year
comment, COMMENT
bpm, BPM, TBPM
key, initialkey, INITIALKEY, TKEY
label, LABEL, organization
```

## Sidecar binary strategy

For true self-contained app:

1. Add platform-specific ffprobe binaries under `desktop/assets/bin/<platform>/`.
2. Include them in the desktop bundle.
3. On first launch, extract/copy the correct binary to app-data `bin/`.
4. chmod executable on macOS/Linux.
5. Use that path in `Deno.Command`.

If bundling binaries becomes awkward in Deno Desktop on day one, keep a fallback:

- use system `ffprobe` if found
- otherwise show “ffprobe missing” diagnostics

But the target state for this experiment is bundled sidecars.

## fpcalc / Chromaprint

Keep optional.

Same strategy as ffprobe:

- bundled per platform if available
- feature disabled if missing
- app remains usable without it

---

# 12. Search parser

Port existing `search.py` behavior exactly.

Must support:

```text
status:approved
darkness:7+
energy:8+
bpm:150-160
role:bridge
break:long
tolerance:huge
not_recent:30
played_recently:30
never_played
dramatic
can_cut_into
can_cut_out_of
```

Also preserve existing tokens.

Implementation style:

```ts
type ParsedQuery = {
  filters: SqlFilter[];
  ftsTerms: string[];
  negations: SqlFilter[];
  debugTokens: ParsedToken[];
};
```

Build SQL with parameter binding only.

No string interpolation of user input into SQL except controlled column/operator mappings.

Example:

```ts
filters.push({
  sql: "profile.darkness >= ?",
  params: [7],
});
```

## Tests

Port current parser tests:

- flagship query returns exactly matching weapon
- recent-play decoy excluded by `not_recent`
- non-dramatic decoy excluded by `dramatic`
- `never_played` works and is negatable
- invalid token fails cleanly or is treated as text according to current behavior

---

# 13. Play history

Implement same behavior:

```http
POST /api/tracks/:id/play
```

Does:

1. Validate track exists.
2. Insert `play_events`.
3. Increment `play_count`.
4. Update `last_played_at`.
5. Return updated track/stats.

Keep this transactional.

Pseudo-SQL:

```sql
BEGIN;
INSERT INTO play_events (track_id, played_at, context, source)
VALUES (?, ?, ?, 'manual');

UPDATE tracks
SET play_count = COALESCE(play_count, 0) + 1,
    last_played_at = ?
WHERE id = ?;
COMMIT;
```

If stats are in `track_stats`, update that instead. Match current schema.

---

# 14. Saved searches / Memory Crates

Implement same CRUD:

```http
GET    /api/searches
POST   /api/searches
PATCH  /api/searches/:id
DELETE /api/searches/:id
```

Each saved search should have live count.

Efficient enough approach:

```ts
for each saved search:
  parse query
  run count query
```

Good enough for v1. Optimize later.

Seed defaults if missing:

- Forgotten Approved: `status:approved not_recent:90`
- Approved Never Played: `status:approved never_played`
- New Untagged: current query from app
- Long Break Candidates: `break:long`
- Peak Bridge Weapons: flagship query
- Duplicate Suspects: if supported

---

# 15. Set Builder

Port existing SetBuilder behavior.

Required:

- create set
- add 4 tracks
- reorder
- recommendations between neighbours
- pair-note reasons
- export M3U8
- export Markdown
- log whole-set play if already implemented

Use transactions for reorder.

Avoid complex drag/drop changes during the Deno port. Keep frontend behavior unchanged.

---

# 16. Pair notes

Port:

```http
GET /api/pair-notes?from_track_id=&to_track_id=
POST /api/pair-notes
```

Fields:

- from_track_id
- to_track_id
- rating
- transition_type
- bpm_strategy
- notes
- created_at
- updated_at

Recommender should surface pair notes as reasons exactly as current app does.

---

# 17. Exports

Use app-data exports directory by default:

```text
~/Library/Application Support/CrateMind/exports/
%APPDATA%\CrateMind\exports\
~/.local/share/cratemind/exports/
```

Export formats:

- M3U8
- Markdown
- CSV if already supported

No overwrite by default.

Return:

```json
{
  "ok": true,
  "path": "...",
  "format": "m3u8"
}
```

Later add desktop binding to reveal file in Finder/Explorer.

---

# 18. Deno Desktop bindings

Do not use bindings for the whole API at first.

Use bindings only for desktop-native actions:

- choose music folder
- choose export folder
- reveal file/folder
- maybe read app version
- maybe open external player
- maybe native notifications later

Why not use bindings for everything?

- Current frontend already uses REST.
- Audio Range streaming belongs in HTTP.
- Same-origin REST keeps browser/dev testing easy.
- Bindings are better for native affordances, not bulk CRUD.

Example type declaration:

```ts
// frontend/src/desktop-bindings.d.ts
export interface DesktopBindings {
  chooseMusicFolder(): Promise<string | null>;
  revealPath(path: string): Promise<void>;
  getAppInfo(): Promise<{ version: string; dataDir: string }>;
}

declare global {
  const bindings: DesktopBindings | undefined;
}
```

Web-safe helper:

```ts
export const desktop = {
  async chooseMusicFolder() {
    if (typeof bindings === "undefined") return null;
    return await bindings.chooseMusicFolder();
  },
};
```

In Deno:

```ts
const win = new Deno.BrowserWindow();

win.bind("getAppInfo", () => ({
  version: APP_VERSION,
  dataDir: getAppDataDir(),
}));
```

Validate every path passed from the UI.

---

# 19. Frontend changes

## API base

Remove external base URL.

Bad:

```ts
const API_BASE = import.meta.env.VITE_API_URL;
fetch(`${API_BASE}/tracks`);
```

Good:

```ts
fetch("/api/tracks");
```

or:

```ts
export function api(path: string) {
  return fetch(path.startsWith("/") ? path : `/api/${path}`);
}
```

## Audio URL

Current:

```ts
audioUrl(trackId)
```

Change to:

```ts
export function audioUrl(trackId: number) {
  return `/tracks/${trackId}/audio`;
}
```

## Desktop-safe storage

Do not rely on localStorage for important persistent state because desktop local HTTP origins may vary across launches depending on implementation. Keep real app state in SQLite. UI-only ephemeral preferences can use localStorage, but do not store library paths, DB paths, saved searches, or important data there.

---

# 20. Tests

Port tests in layers.

## Deno tests to write

```text
desktop/tests/searchParser.test.ts
desktop/tests/streaming.test.ts
desktop/tests/audioEndpoint.test.ts
desktop/tests/playEvents.test.ts
desktop/tests/savedSearches.test.ts
desktop/tests/exports.test.ts
desktop/tests/scanner.test.ts
```

## Must match current verification

Current app had:

- flagship query verified
- recency tokens real via play logging
- 32 pytest passing after audio player
- audio streaming tests:
  - full
  - valid range
  - suffix range
  - invalid range → 416
  - missing track → 404
  - missing file → 410
  - unsupported → 415
  - no arbitrary path → 422/404 depending route design

Recreate equivalent Deno tests.

## Test DB

Use temporary directory:

```ts
const dir = await Deno.makeTempDir();
const dbPath = `${dir}/test.sqlite`;
```

Never use real app data in tests.

---

# 21. Security / file safety

Real risks only:

1. Never accept arbitrary file paths for audio streaming.
2. Serve audio only by DB track ID.
3. Scanner may read user-selected music folders only.
4. No file delete/move operations in this port.
5. Export writes only to app export directory unless user chooses another folder.
6. No tag writing.
7. No DJ database mutation.
8. No remote fetch calls.
9. No CORS.
10. No external telemetry/error reporting.

Add a development-only network guard if useful:

```ts
const originalFetch = globalThis.fetch;
globalThis.fetch = (input, init) => {
  const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
  if (url.startsWith("http://127.0.0.1") || url.startsWith("/") || url.startsWith("http://localhost")) {
    return originalFetch(input, init);
  }
  throw new Error(`External fetch blocked in CrateMind desktop: ${url}`);
};
```

But be careful: in the webview, relative fetches are normal. Do not break asset loading.

Better: grep/build audit:

```bash
rg "https?://" frontend/src desktop/src
rg "VITE_API|API_BASE|localhost|127.0.0.1" frontend/src desktop/src
```

External links in documentation/copy are okay; runtime network calls are not.

---

# 22. Development workflow

## Stage 1 — Create Deno Desktop skeleton

Acceptance:

- `deno desktop --backend cef desktop/main.ts` opens a window.
- It serves a tiny HTML page.
- No backend port management.

## Stage 2 — Serve existing React build

Acceptance:

- `npm run build` creates `frontend/dist`.
- Deno Desktop serves the app.
- React Router hard refresh works.
- MiniPlayer UI renders.

## Stage 3 — Add minimal health API

```http
GET /api/health
```

Returns:

```json
{
  "ok": true,
  "runtime": "deno-desktop",
  "db": "connected"
}
```

Frontend can show a “Desktop mode” badge.

## Stage 4 — SQLite schema + migrations

Acceptance:

- Fresh DB created in app-data.
- Migrations run.
- Tests verify schema.
- FTS5 probe passes.

## Stage 5 — Port search parser

Acceptance:

- Parser tests pass.
- Flagship query parse output matches Python behavior.

## Stage 6 — Port tracks/search/profile/play

Acceptance:

- Library loads.
- Track profiles can be edited.
- Flagship query returns correct tracks.
- Play logging updates recency.

## Stage 7 — Port audio streaming

Acceptance:

- MiniPlayer works.
- Range tests pass.
- AIFF 415 behavior preserved.

## Stage 8 — Port Memory Crates/review queues

Acceptance:

- Dashboard cards load with live counts.
- Saved searches CRUD works.

## Stage 9 — Port SetBuilder/pair notes/recommendations/exports

Acceptance:

- v1.1 acceptance test passes end to end.

## Stage 10 — Desktop-native affordances

Add bindings:

- choose folder
- reveal export
- app info/data dir

Acceptance:

- No web-only workflow is broken.
- Bindings fail gracefully in browser/dev mode.

---

# 23. Suggested coding-agent prompt

Use this with the coding agent.

```text
Task: Create a Deno Desktop self-contained experiment for CrateMind.

Context:
CrateMind currently runs as a local web app with:
- Python 3.13 FastAPI backend
- SQLModel
- SQLite + FTS5
- Mutagen + ffprobe + optional fpcalc
- Vite 6 / React 18 / TypeScript / Tailwind v4 frontend
- no cloud/auth/external services

Current implemented features:
- Library search and DJ token parser
- flagship query:
  status:approved darkness:7+ energy:8+ bpm:150-160 role:bridge break:long tolerance:huge not_recent:30 dramatic
- play logging with play_count + last_played_at + PlayEvent
- Memory Crates / saved searches
- review queues / dashboard
- SetBuilder Lite
- transition pair notes
- recommender reasons
- M3U8 + Markdown exports
- MiniPlayer audition playback via /tracks/{id}/audio with Range support

Goal:
Create an experimental Deno Desktop version that is fully self-contained and makes no external API calls.

Important architecture:
- Do not wrap the Python FastAPI server.
- Do not spawn a Python backend.
- Port the backend behavior to Deno/TypeScript.
- Use Deno.serve() as the single same-origin app server.
- Serve the built Vite React app from frontend/dist.
- Serve API routes under /api/*.
- Serve audio under /tracks/:id/audio.
- Frontend must use relative same-origin URLs only.
- No VITE_API_URL, no CORS, no localhost backend config.
- Use local SQLite via node:sqlite if available.
- Keep all app data in OS app-data directory.
- Use ffprobe via Deno.Command for metadata, preferably bundled as a sidecar binary later.
- Keep fpcalc optional.

First:
1. Inspect repo.
2. Return a concise migration plan.
3. Identify current frontend API calls and backend routes.
4. Identify the minimal feature slice needed to boot the desktop app.
5. Do not implement until after the plan.

Implementation phases:
1. Add desktop/main.ts and deno.json tasks/config.
2. Serve frontend/dist with React Router fallback.
3. Add GET /api/health.
4. Add SQLite app-data DB + migrations + FTS5 probe.
5. Port tracks/search/profile/play endpoints.
6. Port search parser with tests.
7. Port audio streaming with Range support and tests.
8. Port Memory Crates/saved searches/dashboard counts.
9. Port SetBuilder/pair notes/recommender/export.
10. Add desktop bindings only for native actions like choose folder/reveal export.

Real constraints:
- No external runtime API calls.
- No cloud/auth/analytics/telemetry.
- No CORS.
- No separate FastAPI process.
- No arbitrary file path serving.
- Audio streaming only by DB track ID.
- No audio file mutation.
- No tag writing.
- No DJ database mutation.
- No delete/move files.
- Keep frontend workflows intact.
- Keep MiniPlayer working.
- Keep keyboard shortcuts working.
- Do not rely on localStorage for important persistent app state.
- Tests/build must pass.

Preferred backend:
- Use Deno.serve with simple routing first.
- Use node:sqlite first.
- Verify FTS5 at startup.
- Use parameterized SQL.
- Replace Mutagen with ffprobe JSON metadata extraction for the experiment.

Rendering backend:
- Use CEF first for consistent modern CSS/audio rendering and DevTools.
- WebView can be tested later for smaller binary size.

Acceptance test:
The Deno Desktop app should:
1. Launch as a desktop window.
2. Show the existing CrateMind UI.
3. Load tracks from local SQLite.
4. Run the flagship query.
5. Play/audition a track through MiniPlayer.
6. Log a play and make not_recent filters bite.
7. Show Memory Crates counts.
8. Add tracks to a set.
9. Show recommendations/reasons.
10. Export M3U8 + Markdown.
11. Make no external API calls.
```

---

# 24. Feature parity checklist

## Required for experiment success

```text
Desktop window opens
React UI served from Deno
SQLite DB created in app-data
Migrations work
Tracks endpoint works
Search parser works
Flagship query works
Profile edit works
Play logging works
Audio streaming works with Range
MiniPlayer works
Saved searches work
Dashboard counts work
SetBuilder works
Pair notes work
Recommender reasons work
Exports work
No external API calls
```

## Can be deferred

```text
Chromaprint/fpcalc
Duplicate detection
Folder picker binding
Reveal in Finder/Explorer
Native menu
Tray/dock
Auto-update
Code signing/notarization
Cross-platform sidecar bundling
Existing Python DB importer
```

---

# 25. Honest risk assessment

## Low risk

- Serving React build.
- Same-origin REST API.
- Search parser port.
- Saved searches.
- Play logging.
- Exports.
- MiniPlayer UI.

## Medium risk

- SQLite FTS5 availability through `node:sqlite`.
- Audio Range streaming correctness.
- App-data path differences across OS.
- Browser codec differences across CEF/WebView.
- Long-running scanner blocking the Deno event loop.

## High risk

- Bundling ffprobe/fpcalc perfectly across macOS/Windows/Linux.
- Reaching full feature parity in one pass.
- Migrating existing real DB without copy/backups.
- Trying to support both CEF and WebView before CEF works.
- Rewriting UI architecture during the runtime port.

## Best strategy

Port one vertical slice first:

```text
Desktop window
→ React UI
→ SQLite
→ seed 3 tracks
→ flagship query
→ MiniPlayer audio route
```

If that works, continue. If not, stop and reassess. Do not spend 2 days porting everything before proving the core loop.

---

# 26. Final recommendation

Do the Deno Desktop experiment, but do it cleanly:

- **Deno-native backend**
- **CEF first**
- **same-origin API**
- **node:sqlite first**
- **ffprobe replaces Mutagen for metadata**
- **HTTP for audio streaming**
- **bindings only for native desktop actions**
- **Python implementation remains stable reference**

This is a worthy experiment because CrateMind is young, local-first, and already TypeScript-heavy on the frontend.

Do not do a Python sidecar unless the Deno-native port hits a real blocker.

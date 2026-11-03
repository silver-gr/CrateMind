# CrateMind

Local-first personal DJ intelligence layer. Scans your music library, lets you
attach DJ taste metadata (energy / darkness / set role / status / …), finds
duplicates, builds sets with a transparent recommender, and exports safe
artifacts (M3U8 / CSV / JSON backup / Markdown).

**It owns taste metadata and listening bookmarks. It does not touch beatgrids or
cue points in other DJ apps, and it never writes to, moves or locks DJ-app files. An opt-in import may read them: the library database from a private copy, and per-track analysis files in place, read-only.** It never deletes or moves audio files.

## Quick start

The new Tauri desktop build reuses this Python backend. See
[desktop operations](TAURI_DESKTOP_OPERATIONS.md) for self-contained builds,
safe enrollment, folder mapping and complete two-way handoff. Desktop computes
BPM/key locally; the BPM review and SoundCloud/Spotify processing remain
web-owned. The legacy Deno application and
its `desktop/` source were retired on 2026-10-29. The shared backend retains its
bounded importer for existing Deno libraries; implementation tests use generated
fixtures and do not migrate the live library.

### Backend

```bash
cd backend
uv sync

# configure library paths
cp ../.env.example .env
# edit .env -> set CRATEMIND_LIBRARY_ROOTS to your music folder(s)

uv run uvicorn app.main:app --reload --port 8000
```

API docs at http://localhost:8000/docs

### Frontend

```bash
cd frontend
bun install
bun run dev
```

App at http://localhost:5173 (proxies `/api` to the backend).

### Tests

```bash
cd backend && uv run pytest
```

## Workflow

1. Set library roots in `backend/.env`, start backend; scan from **Settings**. Settings also runs **Fingerprint** (Chromaprint) and **Audio analysis (BPM + key)** (ffmpeg) jobs.
2. **Dashboard** → review-queue cards with live counts (Forgotten Approved,
   New Untagged, Long Break Candidates, Weapons, Duplicate Suspects) plus your
   **Memory Crates**. Click a card to open those tracks.
3. **Library** → search (field syntax + FTS), tag via the profile panel, pick an
   *Active set* and add results to it, or **Save as crate** to pin a search.
4. **Tagging Queue** → rapid keyboard tagging of untagged tracks.
5. **Duplicates** → review and resolve duplicate groups (never auto-deletes).
6. **Set Builder** → assemble a set, see BPM/energy/darkness curves and
   transition warnings, ask for the next track *or* a **bridge between** two
   adjacent tracks (recommendations show every reason, including transition
   pair-note memory), record pair notes, **Mark set played**, and export.

### Listening cues

While listening, press physical **I** for Entry, **O** for Exit, or **C** for a
general Cue. The compact player also has **+ Entry**, **+ Exit**, **+ Cue**, and
**Cues** controls. Capture is immediate, needs no label, and works while paused.
Only the player owning playback keys handles shortcuts; buttons target their
own player. Typing, dialogs, modified keys, and held-key repeats do not capture.

Open **Cues** to seek, label, change type or timestamp (`m:ss.SSS`), adjust by
0.1 seconds, or explicitly confirm deletion. Seeking preserves play/pause.
Entry and Exit are independent bookmarks: multiple points are allowed in any
order, and an Exit does not stop playback.

Cues live in SQLite's `track_cues` table, tied to the audio track's own ID.
They survive reloads, restarts, rescans, and temporarily missing files; deleting
the actual track row removes its cues. They are never copied between matches or
written into music files. Positions are integer milliseconds. The API allows
100ms beyond a known finite positive duration for metadata/rounding differences;
unknown duration adds no artificial limit. Cue operations do not reload audio
or log plays.

### Memory Crates (v1.1)

A Memory Crate is a saved search that re-runs live over your taste metadata —
like a Serato smart crate, but personal. Build a query in the Library, hit
**Save as crate**, and it shows on the Dashboard with a live count. The flagship
"Forgotten Approved" crate is `status:approved not_recent:90`. Recency tokens
become real once you log plays (**▶ played** in the profile panel, or
**Mark set played** after practice).

## External tools

- `ffprobe` (recommended) — duration/codec/bitrate. Degrades gracefully if absent.
- `fpcalc` / Chromaprint (optional) — acoustic fingerprints for duplicate detection.
- `ffmpeg` (required for **Audio analysis**) — decodes audio read-only to
  estimate BPM and musical key. Run the job from **Settings → «Γρήγορες Ενέργειες ›
  BPM + Key · Μόνο νέα»** (both runtimes) or the «Ανάλυση BPM + Key» card (web
  only, with online BPM review). Results fill BPM/key only where embedded tags
  are missing; source files and tags are never modified.

On web, all three are auto-detected on `PATH` and can be overridden in `.env`;
the desktop app bundles them.

## Search syntax

The Library search box accepts field filters plus free text, e.g.:

```
energy:7-9 darkness:6-10 role:peak bpm:148-155 status:approved
substyle:hitech weirdness:7+ confidence:4+
mandragora status:approved -retired
```

Recency + transition tokens:

```
not_recent:30        not played in the last 30 days (or never)
played_recently:14   played within the last 14 days
never_played         play_count == 0
dramatic             dramatic_transition_candidate flag set
can_cut_into / can_cut_out_of   cut-point flags
tolerance:huge       bpm_jump_tolerance contains "huge"
```

The flagship query — approved, dark, high-energy 150–160 bridge tracks with a
long breakdown, survive a big BPM jump, not played recently:

```
status:approved darkness:7+ energy:8+ bpm:150-160 role:bridge break:long tolerance:huge not_recent:30 dramatic
```

Recency tokens depend on logged plays (the **▶ played** button in the profile
panel, or `POST /tracks/{id}/play`).

Whole-number BPM ranges match the BPM as the Library shows it, rounded:
`bpm:140-145` keeps 139.6 and 145.02 (the «Φίλτρα» BPM slider writes such
ranges). Decimal bounds (`bpm:139.8-145.2`) stay exact.

`status:` takes a comma list: `status:approved,weapon` matches either status
(the therapy «Εγκεκριμένα» presets use it, because therapy shows a DJ weapon
as approved).

Free text and quoting:

- Free text is accent- and case-insensitive and matches word prefixes:
  `μανος χατζιδ` finds «Μάνος Χατζιδάκις», `relax` finds «Relaxation».
- An excluded word (`-relax`) is exact: it removes «Relax One» but keeps
  «Relaxation Two».
- Only double quotes quote: `artist:"Μάνος Χατζιδάκις"`, `-"two words"`.
  Apostrophes are literal, so `Σ' αγαπώ` works as typed. Punctuation-only
  terms are ignored.
- String fields (`artist:`, `genre:`, …) are accent- and case-insensitive too.

Vocabularies, valence and folders:

```
valence:6-8              emotional valence (1–10), same ranges as energy
purpose:χαλάρωση         a vocabulary value (accents and case ignored)
purpose:"συναισθηματική έκφραση"   a multi-word value needs quotes
purpose:*                tracks with any value in that vocabulary
-purpose:*               tracks with no value in that vocabulary
folder:"C:/Music/Relax/" path contains this text; \ and / are the same
```

A vocabulary token uses the vocabulary's key, which the app never shows. The
suggested therapy vocabulary uses these keys:

```
purpose       Θεραπευτικός στόχος
mood          Διάθεση
voice         Φωνή
lyrics        Γλώσσα στίχων
instruments   Όργανα
phase         Φάση συνεδρίας
ages          Ηλικιακή ομάδα
tradition     Μουσική παράδοση
```

For a vocabulary you created yourself, click one of its values in the tag
cloud: the Library opens with that value's token in the search box, and the
search chips show the vocabulary's Greek label. A value the vocabulary does
not have matches nothing. A key that is not a vocabulary
falls back to free text, so `-purpose:*` without a `purpose` vocabulary
matches every track. End a folder with `/` to stop `Relax` matching
`Relaxation`.

## Safety

- DB is backed up to `data/backups/` on every launch (last N kept).
- Exports only ever write into the output folder; they never overwrite source
  files unless you pass `overwrite=true`.
- All taste metadata lives in `data/cratemind.sqlite`; back it up via the
  JSON-backup export for a portable canonical copy.

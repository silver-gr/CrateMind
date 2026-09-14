# CrateMind

Local-first personal DJ intelligence layer. Scans your music library, lets you
attach DJ taste metadata (energy / darkness / set role / status / …), finds
duplicates, builds sets with a transparent recommender, and exports safe
artifacts (M3U8 / CSV / JSON backup / Markdown).

**It owns taste metadata. It does not touch beatgrids, cue points, or your DJ
app databases.** It never deletes or moves audio files.

## Quick start

### Backend

```bash
cd backend
python3 -m venv .venv
. .venv/bin/activate
pip install -e ".[dev]"

# configure library paths
cp ../.env.example .env
# edit .env -> set CRATEMIND_LIBRARY_ROOTS to your music folder(s)

uvicorn app.main:app --reload --port 8000
```

API docs at http://localhost:8000/docs

### Frontend

```bash
cd frontend
npm install
npm run dev
```

App at http://localhost:5173 (proxies `/api` to the backend).

### Tests

```bash
cd backend && . .venv/bin/activate && pytest
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
  estimate BPM and musical key. Run the job from **Settings → Ανάλυση BPM + Key**.
  Results fill BPM/key only where embedded tags are missing; source files and
  tags are never modified.

Both auto-detected on `PATH`; override paths in `.env`.

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

## Safety

- DB is backed up to `data/backups/` on every launch (last N kept).
- Exports only ever write into the output folder; they never overwrite source
  files unless you pass `overwrite=true`.
- All taste metadata lives in `data/cratemind.sqlite`; back it up via the
  JSON-backup export for a portable canonical copy.

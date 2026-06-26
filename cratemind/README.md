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

1. Set library roots in `backend/.env`, start backend.
2. **Library** page → run a scan → browse/filter tracks.
3. **Tagging Queue** → rapid keyboard tagging of untagged tracks.
4. **Duplicates** → review and resolve duplicate groups (never auto-deletes).
5. **Set Builder** → assemble a set, see BPM/energy curves, get next-track
   recommendations with visible reasons, export.

## External tools

- `ffprobe` (recommended) — duration/codec/bitrate. Degrades gracefully if absent.
- `fpcalc` / Chromaprint (optional) — acoustic fingerprints for duplicate detection.

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

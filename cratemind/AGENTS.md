# AGENTS.md

## Project

CrateMind — a local-first personal DJ intelligence layer.

It scans local music folders, reads metadata, stores custom DJ taste tags in
SQLite, helps build sets, and exports safe playlists. Single user, local-first.

**Owns taste metadata. Does NOT own performance-critical metadata** (beatgrids,
cue points, loops, waveforms).

## Non-goals

- Do not build a DJ performance app (decks, waveform render, beatgrid editor).
- Do not write cue points, beatgrids, or loops to DJ app databases.
- Do not mutate audio file tags by default.
- Do not delete or move audio files.
- Do not create cloud/auth/multi-user features.

## Safety rules

- All destructive actions are dry-run by default.
- Any future tag writing requires an explicit `--write-tags` flag.
- Always back up the local DB before migrations (done on launch).
- Exporters write to the output folder, never overwrite source libraries.
- Tests cover scanner idempotency.

## Stack

Backend: Python, FastAPI, SQLite, SQLModel, Mutagen, ffprobe, fpcalc/Chromaprint.
Frontend: Vite, React, TypeScript, Tailwind.

## Commands

Backend:
- `cd backend && python -m venv .venv && . .venv/bin/activate && pip install -e ".[dev]"`
- `uvicorn app.main:app --reload --port 8000`
- `pytest`

Frontend:
- `cd frontend && npm install`
- `npm run dev`
- `npm run build`

## Coding style

- Prefer simple, boring code.
- Add tests for parser/scanner/export behavior.
- Keep services small and composable.
- Do not introduce external services unless explicitly requested.
- Prefer SQLite FTS5 before adding vector search.

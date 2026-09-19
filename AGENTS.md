# Repository Guidelines

## Project Structure & Module Organization

CrateMind is a local-first DJ library tool. Backend code lives in `backend/app/`: API routes in `api/`, business logic in `services/`, background jobs in `jobs/`, and database/config models at top level. Backend tests live in `backend/tests/`.

Frontend code lives in `frontend/src/`: route pages in `pages/`, reusable UI in `components/`, app wiring in `app/`, and shared helpers/types in `lib/`. Runtime data such as the SQLite catalog and backups belong under backend data paths; never treat music library files as source code.

## Build, Test, and Development Commands

Backend setup and server:

```bash
cd backend
uv sync
uvicorn app.main:app --reload --port 8000
```

Backend tests:

```bash
cd backend && uv run pytest
```

Frontend setup and local dev:

```bash
cd frontend
bun install
bun run dev
```

Production frontend check/build:

```bash
cd frontend && bun run build
```

## Coding Style & Naming Conventions

Use simple Python modules with focused service functions and FastAPI routers. Prefer `pathlib`, structured parsing, SQLModel models, and explicit error handling. Keep side effects obvious, especially around scanning, exports, and file access.

Use TypeScript React function components. Page components use PascalCase filenames, shared helpers use camelCase, and route-level data types belong in `frontend/src/lib/types.ts` unless they are local to one component.

All user-facing UI copy should be Greek by default. Keep English only where it is clearer for established DJ, audio, file-format, or developer terminology, such as `BPM`, `M3U8`, `tag`, or `export`.

## Testing Guidelines

Backend uses `pytest`; tests are named `test_*.py` in `backend/tests/`. Add tests for scanner idempotency, parser behavior, duplicate safety, recommender scoring, exports, and API regressions. No frontend test runner is configured; use `bun run build` for type/build validation when requested.

## Commit & Pull Request Guidelines

History uses imperative, intent-style subjects such as `Add CrateMind v1.1...` with concise bodies explaining backend/frontend impact and tests. Follow that pattern; include constraints, rejected alternatives, and tested/not-tested notes when useful. PRs should summarize user-visible behavior, data-safety impact, commands run, and screenshots for UI changes.

## Safety & Configuration

CrateMind must not delete, move, or retag source audio files unless explicitly requested. Exports write to output folders, not source libraries. Configure library roots in `backend/.env` from `.env.example`; keep local databases, backups, and media paths out of commits.

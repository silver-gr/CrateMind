# AGENTS.md

Guidance for coding agents working in `/Users/silver/Projects/Music-ReORG`.

## Project Overview

This workspace catalogs and analyzes a local music library. It is intentionally small:

- `import_media_to_db.py` scans `Media/` and writes audio metadata to `media_catalog.sqlite`.
- `analyze_bpm.py` estimates BPM values for rows in `media_catalog.sqlite`.
- `DEDUP_REPORT.md`, `non_320.txt`, `hashes.txt`, `fingerprints.txt`, `tags.txt`, and `sc_*.json` are analysis outputs/reports.
- `Media` is a symlink to an external music library volume. Treat it as source data, not project code.

There is no package manifest and no test suite at the moment. Prefer small, direct Python changes over adding framework or build-system machinery.

## Local Runtime

Use the local BPM virtualenv when running the Python scripts:

```bash
.venv_bpm/bin/python import_media_to_db.py --help
.venv_bpm/bin/python analyze_bpm.py --help
```

Observed local dependencies:

- Python 3.14 via `.venv_bpm/bin/python`
- `numpy`
- `scipy`
- `librosa`
- system `ffmpeg` and `ffprobe`

The import script needs `ffprobe`. The BPM script needs `ffmpeg`, and uses `librosa` when available with a NumPy/SciPy fallback.

## Common Commands

Index the music library into the default database:

```bash
.venv_bpm/bin/python import_media_to_db.py
```

Index a different library or database:

```bash
.venv_bpm/bin/python import_media_to_db.py --media-root /path/to/Music --db /path/to/media_catalog.sqlite
```

Analyze BPM for tracks that do not already have BPM values:

```bash
.venv_bpm/bin/python analyze_bpm.py
```

Run a small BPM smoke test before a long analysis:

```bash
.venv_bpm/bin/python analyze_bpm.py --limit 10 --workers 2
```

Force BPM re-analysis:

```bash
.venv_bpm/bin/python analyze_bpm.py --force
```

Inspect the catalog schema:

```bash
sqlite3 media_catalog.sqlite '.schema media_files'
```

## Data Safety

- Do not edit, delete, move, or rename files under `Media/` unless the user explicitly asks.
- Do not run deduplication or deletion actions from `DEDUP_REPORT.md` without explicit confirmation.
- `import_media_to_db.py` recreates the `media_files` table contents with `DELETE FROM media_files`; call this out before running it if the user did not directly request a fresh import.
- `analyze_bpm.py` mutates BPM columns in the SQLite catalog. Use `--limit` for smoke tests.
- Avoid committing `.venv_bpm/`, `__pycache__/`, `.DS_Store`, `Media`, and SQLite `-wal`/`-shm` runtime files.

## Code Style

- Keep scripts as standard-library-first Python with small focused helper functions.
- Preserve the existing `argparse` command-line style.
- Use `pathlib.Path` for filesystem paths.
- Keep SQLite schema migrations additive and idempotent, as in `ensure_bpm_columns`.
- Prefer structured parsing (`json`, SQLite queries, `ffprobe` JSON) over ad hoc string parsing.
- Keep comments sparse and useful; most of the current code is self-explanatory.

## Repository Notes

`CLAUDE.md` contains RTK command-wrapper guidance for Claude-based sessions. In this Codex workspace, normal shell commands are fine unless the user specifically asks to follow those RTK conventions.

This repository may contain large generated analysis files. Before broad edits or commits, check `git status --short` and avoid accidentally staging external media or runtime artifacts.

<!-- gitnexus:start -->
# GitNexus — Code Intelligence

This project is indexed by GitNexus as **cratemind** (2939 symbols, 7003 relationships, 244 execution flows). Use the GitNexus MCP tools to understand code, assess impact, and navigate safely.

> Index stale? Run `node .gitnexus/run.cjs analyze` from the project root — it auto-selects an available runner. No `.gitnexus/run.cjs` yet? `npx gitnexus analyze` (npm 11 crash → `npm i -g gitnexus`; #1939).

## Always Do

- **MUST run impact analysis before editing any symbol.** Before modifying a function, class, or method, run `impact({target: "symbolName", direction: "upstream"})` and report the blast radius (direct callers, affected processes, risk level) to the user.
- **MUST run `detect_changes()` before committing** to verify your changes only affect expected symbols and execution flows. For regression review, compare against the default branch: `detect_changes({scope: "compare", base_ref: "main"})`.
- **MUST warn the user** if impact analysis returns HIGH or CRITICAL risk before proceeding with edits.
- When exploring unfamiliar code, use `query({search_query: "concept"})` to find execution flows instead of grepping. It returns process-grouped results ranked by relevance.
- When you need full context on a specific symbol — callers, callees, which execution flows it participates in — use `context({name: "symbolName"})`.
- For security review, `explain({target: "fileOrSymbol"})` lists taint findings (source→sink flows; needs `analyze --pdg`).

## Never Do

- NEVER edit a function, class, or method without first running `impact` on it.
- NEVER ignore HIGH or CRITICAL risk warnings from impact analysis.
- NEVER rename symbols with find-and-replace — use `rename` which understands the call graph.
- NEVER commit changes without running `detect_changes()` to check affected scope.

## Resources

| Resource | Use for |
|----------|---------|
| `gitnexus://repo/cratemind/context` | Codebase overview, check index freshness |
| `gitnexus://repo/cratemind/clusters` | All functional areas |
| `gitnexus://repo/cratemind/processes` | All execution flows |
| `gitnexus://repo/cratemind/process/{name}` | Step-by-step execution trace |

## CLI

| Task | Read this skill file |
|------|---------------------|
| Understand architecture / "How does X work?" | `.claude/skills/gitnexus/gitnexus-exploring/SKILL.md` |
| Blast radius / "What breaks if I change X?" | `.claude/skills/gitnexus/gitnexus-impact-analysis/SKILL.md` |
| Trace bugs / "Why is X failing?" | `.claude/skills/gitnexus/gitnexus-debugging/SKILL.md` |
| Rename / extract / split / refactor | `.claude/skills/gitnexus/gitnexus-refactoring/SKILL.md` |
| Tools, resources, schema reference | `.claude/skills/gitnexus/gitnexus-guide/SKILL.md` |
| Index, status, clean, wiki CLI commands | `.claude/skills/gitnexus/gitnexus-cli/SKILL.md` |

<!-- gitnexus:end -->

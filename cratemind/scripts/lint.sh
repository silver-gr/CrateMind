#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

cd "$ROOT/backend"
uv run --with ruff ruff check app tests

cd "$ROOT/frontend"
npm run lint

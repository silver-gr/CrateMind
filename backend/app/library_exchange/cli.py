"""Stopped-source enrollment and complete serial library handoff."""
from __future__ import annotations

import argparse
import json
import sqlite3
import sys
from pathlib import Path

from .operations import apply_import, enroll, export_exchange, prepare_import


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest="command", required=True)
    register = commands.add_parser("enroll", help="Stopped originals remain unchanged")
    register.add_argument("--catalog", type=Path, required=True)
    register.add_argument("--identity", type=Path)
    register.add_argument("--data-dir", type=Path, required=True)
    discover = commands.add_parser("inspect-deno", help="Read-only preview of known Deno app-data sources")
    discover.add_argument("--source", type=Path)
    adopt = commands.add_parser("adopt-deno", help="Copy a stopped Deno-only catalog into a new dataset and publish S0")
    adopt.add_argument("--source", type=Path, required=True)
    adopt.add_argument("--data-dir", type=Path, required=True)
    adopt.add_argument("--require-stopped", action="store_true", required=True)
    export = commands.add_parser("export")
    export.add_argument("--data-dir", type=Path, required=True)
    export.add_argument("--output", type=Path, required=True)
    inspect = commands.add_parser("inspect")
    inspect.add_argument("--bundle", type=Path, required=True)
    inspect.add_argument("--data-dir", type=Path)
    apply = commands.add_parser("import")
    apply.add_argument("--bundle", type=Path, required=True)
    apply.add_argument("--data-dir", type=Path, required=True)
    apply.add_argument("--require-stopped", action="store_true", required=True)
    apply.add_argument("--replace-incoming", action="store_true")
    apply.add_argument("--confirm-local-digest")
    args = parser.parse_args(argv)
    try:
        if args.command == "inspect-deno":
            from ..desktop_runtime.adoption import inspect_deno_sources, preview_deno_source
            previews = [preview_deno_source(args.source)] if args.source else inspect_deno_sources()
            print(json.dumps([preview.to_dict() for preview in previews], ensure_ascii=False))
        elif args.command == "adopt-deno":
            from ..desktop_runtime.adoption import adopt_deno_source
            result = adopt_deno_source(args.source, args.data_dir, require_stopped=args.require_stopped)
            print(json.dumps(result.to_dict() | {"CRATEMIND_DATASET_ROOT": str(result.dataset.dataset_root)}, ensure_ascii=False))
        elif args.command == "enroll":
            result = enroll(args.catalog, args.identity, args.data_dir)
            print(json.dumps(result.to_dict() | {"CRATEMIND_DATASET_ROOT": str(result.dataset.dataset_root)}, ensure_ascii=False))
        elif args.command == "export":
            print(json.dumps(export_exchange(args.data_dir, args.output).to_dict(), ensure_ascii=False))
        else:
            preview = prepare_import(args.bundle, args.data_dir)
            if args.command == "inspect":
                print(json.dumps(preview.to_dict(), ensure_ascii=False))
            else:
                result = apply_import(preview, args.data_dir,
                                      decision="replace" if args.replace_incoming else "import",
                                      confirmation_digest=args.confirm_local_digest)
                print(json.dumps(result.to_dict(), ensure_ascii=False))
    except (ValueError, OSError, RuntimeError, sqlite3.Error) as exc:
        print(json.dumps({"error": str(exc)}, ensure_ascii=False), file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

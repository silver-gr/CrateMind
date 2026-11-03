#!/usr/bin/env python3
"""Lay out the Windows app folder that `vpk pack` packages (Velopack trial).

Mirrors the NSIS install dir: the main exe plus tauri.conf.json's bundle.resources,
copied from the staged native/src-tauri/resources to the same relative paths. Tauri's
resource_dir() is the exe's folder on Windows, so the app finds them the same way.
"""
import argparse
import json
import shutil
from pathlib import Path

TAURI = Path(__file__).resolve().parents[2] / "native/src-tauri"


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--exe", required=True, type=Path, help="built main executable")
    parser.add_argument("--name", required=True, help="exe file name inside the pack dir")
    parser.add_argument("--out", required=True, type=Path)
    args = parser.parse_args()
    if args.out.exists():
        shutil.rmtree(args.out)
    args.out.mkdir(parents=True)
    shutil.copy2(args.exe, args.out / args.name)
    resources = json.loads((TAURI / "tauri.conf.json").read_text())["bundle"]["resources"]
    for source, target in resources.items():
        src, dst = TAURI / source, args.out / target
        if src.is_dir():
            shutil.copytree(src, dst)
        else:
            dst.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(src, dst)
    print(f"Staged {args.out}: {args.name} + {len(resources)} resource entries")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

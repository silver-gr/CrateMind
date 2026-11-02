#!/usr/bin/env python3
"""Single source of truth for the CrateMind version.

    python3 scripts/version.py show
    python3 scripts/version.py set X.Y.Z
    python3 scripts/version.py check [v]X.Y.Z
    python3 scripts/version.py notes X.Y.Z
"""

from __future__ import annotations

import argparse
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SEMVER = r"\d+\.\d+\.\d+"

# (relative path, regex with groups (prefix)(version)(suffix) matching exactly one place)
LOCATIONS: list[tuple[str, str]] = [
    ("frontend/package.json", rf'^(  "version": ")({SEMVER})(",?)(?=\r?$)'),
    ("native/package.json", rf'^(\{{"name":"cratemind-native","version":")({SEMVER})(")'),
    ("native/src-tauri/tauri.conf.json", rf'^(  "version": ")({SEMVER})(",?)(?=\r?$)'),
    ("native/src-tauri/Cargo.toml", rf'(\[package\]\r?\n(?:(?!\[).*\n)*?version = ")({SEMVER})(")'),
    (
        "native/src-tauri/Cargo.lock",
        rf'(name = "cratemind-native"\r?\nversion = ")({SEMVER})(")',
    ),
    ("backend/pyproject.toml", rf'(\[project\]\r?\n(?:(?!\[).*\n)*?version = ")({SEMVER})(")'),
    (
        "backend/uv.lock",
        rf'(name = "cratemind-backend"\r?\nversion = ")({SEMVER})(")',
    ),
    ("backend/app/app_factory.py", rf'(FastAPI\(title="CrateMind", version=")({SEMVER})(")'),
]


def _compile(pattern: str) -> re.Pattern[str]:
    return re.compile(pattern, re.MULTILINE)


def read_versions() -> dict[str, str]:
    found: dict[str, str] = {}
    for rel, pattern in LOCATIONS:
        text = (ROOT / rel).read_text(encoding="utf-8")
        matches = _compile(pattern).findall(text)
        if len(matches) != 1:
            found[rel] = f"<{len(matches)} matches>"
        else:
            found[rel] = matches[0][1]
    return found


def agreed(found: dict[str, str]) -> str | None:
    values = set(found.values())
    return values.pop() if len(values) == 1 and re.fullmatch(SEMVER, next(iter(values))) else None


def report_mismatch(found: dict[str, str]) -> None:
    print("Version locations disagree:", file=sys.stderr)
    for rel, value in found.items():
        print(f"  {rel}: {value}", file=sys.stderr)


def cmd_show(_: argparse.Namespace) -> int:
    found = read_versions()
    version = agreed(found)
    if version is None:
        report_mismatch(found)
        return 1
    print(version)
    return 0


def cmd_set(args: argparse.Namespace) -> int:
    version = args.version
    if not re.fullmatch(SEMVER, version):
        print(f"Invalid version {version!r}: expected X.Y.Z", file=sys.stderr)
        return 1
    # Validate every location before writing anything.
    new_texts: dict[str, str] = {}
    for rel, pattern in LOCATIONS:
        path = ROOT / rel
        text = path.read_bytes().decode("utf-8")
        regex = _compile(pattern)
        if len(regex.findall(text)) != 1:
            print(f"{rel}: expected exactly one version match", file=sys.stderr)
            return 1
        new_texts[rel] = regex.sub(lambda m: m.group(1) + version + m.group(3), text, count=1)
    for rel, text in new_texts.items():
        (ROOT / rel).write_bytes(text.encode("utf-8"))
    found = read_versions()
    if agreed(found) != version:
        report_mismatch(found)
        return 1
    print(f"Set version {version} in {len(LOCATIONS)} locations")
    return 0


def changelog_path(args: argparse.Namespace) -> Path:
    return Path(args.changelog) if args.changelog else ROOT / "CHANGELOG.md"


def cmd_check(args: argparse.Namespace) -> int:
    version = args.version.removeprefix("v")
    if not re.fullmatch(SEMVER, version):
        print(f"Invalid version {args.version!r}: expected [v]X.Y.Z", file=sys.stderr)
        return 1
    found = read_versions()
    bad = {rel: v for rel, v in found.items() if v != version}
    if bad:
        print(f"Version files do not match {version}:", file=sys.stderr)
        for rel, v in bad.items():
            print(f"  {rel}: {v}", file=sys.stderr)
        return 1
    path = changelog_path(args)
    if not path.is_file():
        print(f"{path.name} not found", file=sys.stderr)
        return 1
    heading = re.compile(rf"^## \[{re.escape(version)}\] - ", re.MULTILINE)
    if not heading.search(path.read_text(encoding="utf-8")):
        print(f"{path.name} has no heading starting '## [{version}] - '", file=sys.stderr)
        return 1
    print(f"OK: {version}")
    return 0


def cmd_notes(args: argparse.Namespace) -> int:
    version = args.version.removeprefix("v")
    path = changelog_path(args)
    if not path.is_file():
        print(f"{path.name} not found", file=sys.stderr)
        return 1
    lines = path.read_text(encoding="utf-8").splitlines()
    prefix = f"## [{version}] - "
    start = next((i for i, line in enumerate(lines) if line.startswith(prefix)), None)
    if start is None:
        print(f"{path.name} has no entry for {version}", file=sys.stderr)
        return 1
    body: list[str] = []
    for line in lines[start + 1 :]:
        if line == "---" or line.startswith("## "):
            break
        body.append(line)
    sys.stdout.reconfigure(encoding="utf-8")
    print("\n".join(body).strip())
    return 0


def main() -> int:
    global ROOT
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawTextHelpFormatter)
    parser.add_argument("--changelog", help="path to CHANGELOG.md (default: repo root)")
    parser.add_argument("--root", type=Path, help=argparse.SUPPRESS)
    sub = parser.add_subparsers(dest="command", required=True)
    sub.add_parser("show").set_defaults(func=cmd_show)
    for name, func in (("set", cmd_set), ("check", cmd_check), ("notes", cmd_notes)):
        p = sub.add_parser(name)
        p.add_argument("version")
        p.set_defaults(func=func)
    args = parser.parse_args()
    if args.root is not None:
        ROOT = args.root.resolve()
    return args.func(args)


if __name__ == "__main__":
    sys.exit(main())

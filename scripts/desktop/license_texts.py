#!/usr/bin/env python3
"""Write the licence texts of the Python, npm and Rust packages in the desktop bundle to one file.

The package lists come from scripts/third_party_licenses.py; identical texts are printed once.
"""
from __future__ import annotations

import importlib.metadata as md
import json
import platform
import re
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "scripts"))
import third_party_licenses as inventory  # noqa: E402

TEXT_RE = re.compile(r"^(licen[cs]e|copying|copyright|notice|unlicense)", re.I)
TARGET = "x86_64-pc-windows-msvc" if platform.system() == "Windows" else "aarch64-apple-darwin"


def texts_in(folder: Path) -> list[Path]:
    return sorted(p for p in folder.iterdir() if p.is_file() and TEXT_RE.match(p.name) and p.suffix not in {".py", ".js", ".ts"}) if folder.is_dir() else []


def python_packages(gaps: list) -> list[tuple]:
    venv = ROOT / "backend/.venv-desktop"
    site = next(iter(sorted(venv.glob("lib/python3*/site-packages"))), venv / "Lib/site-packages")
    dists = {re.sub(r"[-_.]+", "-", d.metadata["Name"]).lower(): d for d in md.distributions(path=[str(site)]) if d.metadata["Name"]}
    out = []
    for row in inventory.python_entries(site, [], gaps):
        if row["ships"]:
            files = [Path(str(f)) for f in dists[re.sub(r"[-_.]+", "-", row["name"]).lower()].files or []]
            texts = [site / f for f in files if ".dist-info" in f.parts[0] and (TEXT_RE.match(f.name) or "licenses" in f.parts) and (site / f).is_file()]
            out.append((f"{row['name']} {row['version']} (Python, {row['licence'] or 'see text'}) https://pypi.org/project/{row['name']}/{row['version']}/", texts))
    return out


def npm_packages(gaps: list) -> list[tuple]:
    modules = ROOT / "frontend/node_modules"
    out = []
    for row in inventory.js_entries(ROOT / "frontend", [], gaps):
        candidates = [modules / row["name"], *modules.glob(f"**/node_modules/{row['name']}")]
        folder = next((c for c in candidates if (c / "package.json").is_file() and json.loads((c / "package.json").read_text()).get("version") == row["version"]), modules / row["name"])
        out.append((f"{row['name']} {row['version']} (npm, {row['licence']})", texts_in(folder)))
    return out


def rust_crates() -> list[tuple]:
    manifest = ROOT / "native/src-tauri/Cargo.toml"
    meta = json.loads(subprocess.run(["cargo", "metadata", "--format-version", "1", "--locked", "--filter-platform", TARGET, "--manifest-path", str(manifest)],
                                     check=True, capture_output=True, text=True, encoding="utf-8").stdout)
    packages = {p["id"]: p for p in meta["packages"]}
    nodes = {n["id"]: n for n in meta["resolve"]["nodes"]}
    seen, stack = set(), [meta["resolve"]["root"]]
    while stack:  # shipping dependencies only
        if (pid := stack.pop()) not in seen:
            seen.add(pid)
            stack.extend(d["pkg"] for d in nodes[pid]["deps"] if any(k["kind"] is None for k in d["dep_kinds"]))
    crates = sorted((packages[pid] for pid in seen - set(meta["workspace_members"])), key=lambda p: (p["name"], p["version"]))
    return [(f"{p['name']} {p['version']} (Rust, {p['license'] or 'see text'}) https://crates.io/crates/{p['name']}/{p['version']}", texts_in(Path(p["manifest_path"]).parent)) for p in crates]


def write(destination: Path) -> dict:
    gaps: list = []
    groups = [python_packages(gaps), npm_packages(gaps), rust_crates()]
    if not all(groups):
        raise RuntimeError("Licence texts are incomplete: " + "; ".join(gaps))
    packages = sum(groups, [])
    owners: dict[str, list[str]] = {}
    without = []
    for label, paths in packages:
        for path in paths:
            owners.setdefault(path.read_text(encoding="utf-8", errors="replace").strip(), []).append(label)
        if not paths:
            without.append(label)
    parts = ["Licence texts of the packages in CrateMind\n\nPackages whose distribution has no licence file (licence as declared by the package):\n" + "\n".join("  " + w for w in without)]
    parts += ["\n".join(dict.fromkeys(labels)) + "\n\n" + text for text, labels in sorted(owners.items(), key=lambda item: item[1][0].lower())]
    destination.write_text(("\n\n" + "=" * 80 + "\n").join(parts) + "\n", encoding="utf-8")
    return {"packages": len(packages), "without_text": len(without), "texts": len(owners)}


if __name__ == "__main__":
    print(json.dumps(write(Path(sys.argv[1]))))

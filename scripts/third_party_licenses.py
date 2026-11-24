#!/usr/bin/env python3
"""Inventory the third-party code the desktop bundle ships, with licence flags.

Read-only and offline (stdlib only): Python distributions from the desktop build venv,
the frontend's production npm closure, the native shell's Rust crates (cargo metadata
--offline), the staged or PATH media tools, and a hand-kept table of vendored items.
Exit code 0, unless --fail-on names a class that has entries.
"""
from __future__ import annotations

import argparse
import importlib.metadata as md
import json
import os
import re
import shutil
import subprocess
import sys
from datetime import date
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
CLASSES = ("permissive", "weak-copyleft", "strong-copyleft", "noncommercial", "unknown")
FLAGGED = CLASSES[1:]
WHY = {  # (closed build, GPL-3 build)
    "weak-copyleft": ("allowed if it stays a separate, replaceable library and its licence text and source offer ship",
                      "compatible for LGPL-2.1+/LGPL-3, MPL-2.0 and EPL-2.0 with its secondary-licence clause; CDDL, EPL-1.0 and MPL-1.1 are not"),
    "strong-copyleft": ("not allowed: remove or replace it", "compatible when it is GPL-2.0-or-later or GPL-3; GPL-2.0-only is not"),
    "noncommercial": ("read the terms: resale, hosting or relicensing may be barred",
                      "incompatible: GPL-3 forbids extra restrictions, so it must go"),
    "unknown": ("read the licence before shipping", "read the licence before shipping"),
}
NONCOM_RE = r"commons clause|no charge|non-?commercial|\bcc-by-nc|proprietary|see licen[cs]e|nonfree|\bbusl\b|\bsspl\b|elastic licen"
WEAK_RE = r"\blgpl|lesser general|library general|\bmpl\b|\bmpl-\d|mozilla public|\bepl\b|\bepl-\d|eclipse public|\bcddl"
STRONG_RE = r"\bagpl|affero|\bgpl|general public licen"
PERMISSIVE_RE = (r"\bmit\b|\bbsd|apache|\bisc\b|zlib|unlicense|\bcc0|\b0bsd|\bpsf|python software foundation|\bofl\b|\bofl-"
                 r"|open font|cdla-permissive|historical permission|\bhpnd|unicode|\bbsl-1|boost|\bwtfpl|\bx11\b|public domain|blueoak"
                 r"|\bncsa|\bcc-by-\d|\bzpl|artistic|\bpython-2")
BUILD_ONLY = {"pyinstaller", "pyinstaller-hooks-contrib", "altgraph", "macholib", "pip", "cratemind-backend"}
TOC_DIR = ROOT / "build/desktop/pyinstaller/desktop"
STAGED_TOOLS = ROOT / "native/src-tauri/resources/tools"
RUST_TARGETS = ("aarch64-apple-darwin", "x86_64-pc-windows-msvc")
# Things no package manager reports: (repo path that must exist, name, licence, note, class override).
VENDORED = [
    ("frontend/private/maximizer/master_me/COPYING", "master_me 1.3.1 (wasm)", "GPL-3.0",
     "personal builds only: a gitignored folder CI and releases never have; COPYING is GPL-3, 'or later' not stated", None),
    ("frontend/src/lib/audio/vendor/SignalsmithStretch.mjs", "Signalsmith Stretch 1.3.2 (wasm)", "MIT",
     "deck time-stretch worklet; text in frontend/public/licenses/", None),
    ("frontend/src/components/backgrounds/REACT_BITS_LICENSE.txt", "React Bits components", "MIT + Commons Clause",
     "adapted source", None),
    ("backend/packaging/desktop.spec", "PyInstaller bootloader", "GPL-2.0-or-later WITH Bootloader-exception",
     "the exception lets the frozen app ship under any licence", "permissive"),
    ("backend/packaging/desktop.spec", "CPython runtime", "PSF-2.0", "interpreter frozen into the backend onedir", None),
    ("backend/.venv-desktop/lib/python3.13/site-packages/_soundfile_data/COPYING", "libsndfile (inside the soundfile wheel)",
     "LGPL-2.1-or-later", "native library PyInstaller bundles with soundfile; the wheel itself is BSD", None),
]
# Libraries Homebrew's ffmpeg/fpcalc pull into resources/tools/lib (macOS); keys are file-name prefixes.
LIB_LICENCES = {
    "libchromaprint": "LGPL-2.1-or-later", "libcrypto": "Apache-2.0", "libssl": "Apache-2.0", "libdav1d": "BSD-2-Clause",
    "liblzma": "0BSD", "libmp3lame": "LGPL-2.0-or-later", "libmpg123": "LGPL-2.1-only", "libopus": "BSD-3-Clause",
    "libSvtAv1Enc": "BSD-3-Clause-Clear", "libvmaf": "BSD-2-Clause-Patent", "libvpx": "BSD-3-Clause",
    "libx264": "GPL-2.0-or-later", "libx265": "GPL-2.0-or-later",
}


def classify_term(term: str) -> str:
    low = term.lower()
    for cls, rx in (("noncommercial", NONCOM_RE), ("weak-copyleft", WEAK_RE), ("strong-copyleft", STRONG_RE), ("permissive", PERMISSIVE_RE)):
        if re.search(rx, low):
            return cls
    return "unknown"


def classify(text: str | None) -> str:
    """SPDX-ish: OR takes the best option, AND the worst; a restriction marker anywhere wins."""
    if not text or not text.strip() or text.strip().upper() in ("UNKNOWN", "NOASSERTION"):
        return "unknown"
    if re.search(NONCOM_RE, text.lower()):
        return "noncommercial"
    tokens = re.findall(r"\(|\)|[^\s()]+", re.sub(r"(?<=\w)\s*/\s*(?=\w)", " OR ", text))
    pos = 0
    worst = lambda *c: max(c, key=CLASSES.index)

    def atom() -> str:
        nonlocal pos
        if pos < len(tokens) and tokens[pos] == "(":
            pos += 1
            result = expr()
            if pos < len(tokens) and tokens[pos] == ")":
                pos += 1
            return result
        words = []
        while pos < len(tokens) and tokens[pos] not in ("(", ")", "OR", "AND"):
            words.append(tokens[pos])
            pos += 1
        return classify_term(" ".join(words))

    def conj() -> str:
        nonlocal pos
        result = atom()
        while pos < len(tokens) and tokens[pos] == "AND":
            pos += 1
            result = worst(result, atom())
        return result

    def expr() -> str:
        nonlocal pos
        result = conj()
        while pos < len(tokens) and tokens[pos] == "OR":
            pos += 1
            result = min(result, conj(), key=CLASSES.index)
        return result

    results = [expr()]
    while pos < len(tokens):
        if tokens[pos] == ")":
            pos += 1
        else:
            results.append(expr())
    return worst(*([r for r in results if r != "unknown"] or results))  # "(see notes)" asides never hide a class


def entry(source: str, name: str, version: str, licence: str, note: str = "", ships: bool = True, cls: str | None = None) -> dict:
    return {"source": source, "name": name, "version": version or "", "licence": licence or "",
            "class": cls or classify(licence), "note": note, "ships": ships}


def python_entries(site: Path, inputs: list, gaps: list) -> list:
    if not site.is_dir():
        gaps.append(f"Python: site-packages not found ({site}); create backend/.venv-desktop or pass --site-packages")
        return []
    tocs = [TOC_DIR / "PYZ-00.toc", TOC_DIR / "COLLECT-00.toc"]
    bundled = None
    if all(t.is_file() for t in tocs):
        text = "".join(t.read_text(errors="replace") for t in tocs)
        bundled = set(re.findall(r"site-packages[/\\]+([^/\\']+)", text))
        built = date.fromtimestamp(tocs[0].stat().st_mtime).isoformat()
        inputs.append(f"Python: `{site}`; bundled = has files in the last PyInstaller build's TOC "
                      f"(`{TOC_DIR.relative_to(ROOT)}`, built {built}; stale if the venv changed since)")
    else:
        inputs.append(f"Python: `{site}`; no PyInstaller TOC found, so the whole venv minus build-only tools is listed")
        gaps.append("Python: not restricted to what desktop.spec bundles (run scripts/desktop/build_backend.py for that)")
    rows = {}
    for dist in md.distributions(path=[str(site)]):
        name = dist.metadata["Name"]
        if not name:
            continue
        norm = re.sub(r"[-_.]+", "-", name).lower()
        meta = dist.metadata
        lic = meta.get("License-Expression") or ""
        raw = (meta.get("License") or "").strip()
        classifiers = [c.split("::")[-1].strip() for c in meta.get_all("Classifier") or [] if c.startswith("License ::")]
        if not lic and raw and "\n" not in raw and len(raw) <= 120 and raw.upper() != "UNKNOWN":
            lic = raw
        if not lic and classifiers:
            lic = " OR ".join(c for c in classifiers if c != "OSI Approved") or classifiers[0]
        if not lic and raw:
            lic = raw.splitlines()[0][:120]
        files = [str(f) for f in dist.files or []]
        has_text = bool(meta.get_all("License-File")) or any(
            re.search(r"(^|/)(licen[cs]e|copying|notice)[^/]*$", f, re.I) or "/licenses/" in f for f in files)
        tops = {f.split("/")[0] for f in files} - {"..", "__pycache__"}
        ships = norm not in BUILD_ONLY and (bundled is None or bool(tops & bundled))
        note = "licence text: " + ("yes" if has_text else "no")
        rows[norm] = entry("Python", name, dist.version, lic, note, ships)
    return sorted(rows.values(), key=lambda r: r["name"].lower())


def js_entries(frontend: Path, inputs: list, gaps: list) -> list:
    if not (frontend / "node_modules").is_dir():
        gaps.append("JavaScript: frontend/node_modules missing (run bun install); npm packages not covered")
        return []
    inputs.append("JavaScript: `frontend/package.json` dependencies (not devDependencies), resolved through "
                  "`frontend/node_modules`; the closure is a superset of what Vite bundles")

    def resolve(base: Path, name: str) -> Path | None:
        d = base
        while True:
            if (d / "node_modules" / name / "package.json").is_file():
                return d / "node_modules" / name
            if d == frontend or d.parent == d:
                return None
            d = d.parent

    root = json.loads((frontend / "package.json").read_text())
    stack = [(frontend, n, False) for n in root.get("dependencies") or {}]
    seen, rows, missing = set(), {}, []
    while stack:
        base, name, optional = stack.pop()
        pkg = resolve(base, name)
        if pkg is None:
            if not optional:
                missing.append(name)
            continue
        if pkg.resolve() in seen:
            continue
        seen.add(pkg.resolve())
        data = json.loads((pkg / "package.json").read_text())
        lic = data.get("license")
        if isinstance(lic, dict):
            lic = lic.get("type")
        if not lic and isinstance(data.get("licenses"), list):
            lic = " OR ".join(x.get("type", "") if isinstance(x, dict) else str(x) for x in data["licenses"])
        rows[(data.get("name", name), data.get("version", ""))] = entry("JavaScript", data.get("name", name), data.get("version", ""), lic or "")
        for field, opt in (("dependencies", False), ("optionalDependencies", True), ("peerDependencies", True)):
            stack.extend((pkg, dep, opt) for dep in data.get(field) or {})
    if missing:
        gaps.append("JavaScript: not installed in node_modules: " + ", ".join(sorted(set(missing))))
    return sorted(rows.values(), key=lambda r: r["name"].lower())


def rust_entries(manifest: Path, inputs: list, gaps: list) -> list:
    if not shutil.which("cargo"):
        gaps.append("Rust: cargo not found; crates not covered")
        return []
    rows, done = {}, []
    for target in RUST_TARGETS:
        cmd = ["cargo", "metadata", "--format-version", "1", "--locked", "--offline", "--filter-platform", target, "--manifest-path", str(manifest)]
        try:
            out = subprocess.run(cmd, capture_output=True, text=True, timeout=180)
        except (OSError, subprocess.TimeoutExpired) as exc:
            gaps.append(f"Rust {target}: cargo metadata failed ({exc})")
            continue
        if out.returncode:
            last = (out.stderr.strip().splitlines() or ["?"])[0]
            gaps.append(f"Rust {target}: not covered, cargo metadata --offline failed ({last}); `cargo fetch` would download the crates")
            continue
        meta = json.loads(out.stdout)
        pkgs = {p["id"]: p for p in meta["packages"]}
        nodes = {n["id"]: n for n in meta["resolve"]["nodes"]}
        seen, stack = set(), [meta["resolve"]["root"]]
        while stack:  # normal (shipping) dependencies only, no build or dev deps
            pid = stack.pop()
            if pid not in seen:
                seen.add(pid)
                stack.extend(d["pkg"] for d in nodes[pid]["deps"] if any(k["kind"] is None for k in d["dep_kinds"]))
        for pid in seen - set(meta["workspace_members"]):
            p = pkgs[pid]
            lic = p.get("license") or (f"see licence file {p['license_file']}" if p.get("license_file") else "")
            row = rows.setdefault((p["name"], p["version"]), entry("Rust", p["name"], p["version"], lic))
            row["note"] = (row["note"] + ", " if row["note"] else "") + target
        done.append(target)
    if done:
        inputs.append(f"Rust: `cargo metadata --locked --offline --filter-platform` for {', '.join(done)}, normal dependencies of `{manifest.relative_to(ROOT)}`")
    return sorted(rows.values(), key=lambda r: (r["name"], r["version"]))


def run(cmd: list) -> str:
    try:
        out = subprocess.run(cmd, capture_output=True, text=True, timeout=20)
        return out.stdout + out.stderr
    except (OSError, subprocess.TimeoutExpired):
        return ""


def media_entries(inputs: list, gaps: list) -> list:
    rows, ffmpeg_licence, where = [], None, []
    for name in ("ffmpeg", "ffprobe", "fpcalc"):
        exe = name + (".exe" if os.name == "nt" else "")
        path = STAGED_TOOLS / exe if (STAGED_TOOLS / exe).is_file() else (Path(shutil.which(name)) if shutil.which(name) else None)
        if path is None:
            gaps.append(f"Media tools: {name} neither staged nor on PATH")
            continue
        where.append(f"{name}: `{path}`")
        version_text = run([str(path), "-version"])
        version = (re.search(r"version (\S+)", version_text) or [None, ""])[1]
        if name == "fpcalc":
            lic, note = "LGPL-2.1-or-later", "Chromaprint"
            if "FFmpeg" in version_text and ffmpeg_licence:
                lic, note = ffmpeg_licence, "Chromaprint linked with the FFmpeg libraries above, so it takes their licence"
        else:
            conf = run([str(path), "-hide_banner", "-buildconf"]) or version_text
            flags = [f for f in ("--enable-gpl", "--enable-nonfree", "--enable-version3") if f in conf]
            if not conf:
                lic = "could not run the binary"
            elif "--enable-nonfree" in flags:
                lic = "FFmpeg nonfree build (not redistributable)"
            elif "--enable-gpl" in flags:
                lic = "GPL-3.0-or-later" if "--enable-version3" in flags else "GPL-2.0-or-later"
            else:
                lic = "LGPL-3.0-or-later" if "--enable-version3" in flags else "LGPL-2.1-or-later"
            ffmpeg_licence = ffmpeg_licence or lic
            note = "build flags: " + (" ".join(flags) or "none of gpl/nonfree/version3")
        rows.append(entry("Media tools", name, version, lic, note))
    lib_dir = STAGED_TOOLS / "lib"
    if lib_dir.is_dir():
        for lib in sorted(p for p in lib_dir.iterdir() if p.is_file()):
            if lib.name.startswith(("libav", "libsw")):
                lic, note = ffmpeg_licence or "", "FFmpeg library"
            else:
                lic = next((v for k, v in LIB_LICENCES.items() if lib.name.startswith(k + ".")), "")
                note = "licence from the script's table" if lic else "not in the script's table"
            rows.append(entry("Media tools", lib.name, "", lic, note))
    if where:
        inputs.append("Media tools: " + "; ".join(where) + (f"; staged libraries in `{lib_dir.relative_to(ROOT)}`" if lib_dir.is_dir() else ""))
    return rows


def vendored_entries(inputs: list, gaps: list) -> list:
    rows = []
    react_bits = sorted(p.relative_to(ROOT / "frontend/src").as_posix() for p in (ROOT / "frontend/src").rglob("*.ts*")
                        if "Commons Clause" in p.read_text(errors="replace")[:800])
    for path, name, lic, note, cls in VENDORED:
        if name == "React Bits components":
            note += f": {len(react_bits)} files with the licence header ({', '.join(react_bits)})"
        stale = not (ROOT / path).exists()
        if stale:
            gaps.append(f"Vendored: row '{name}' is stale, `{path}` is missing")
        rows.append(entry("Vendored", name, "", lic, ("STALE: path missing. " if stale else "") + f"`{path}`; {note}", not stale, cls))
    inputs.append(f"Vendored: {len(VENDORED)} hand-kept rows in this script, paths checked at run time")
    return rows


def cell(text: str) -> str:
    text = str(text).replace("|", "\\|").replace("\n", " ")
    return text if len(text) <= 160 else text[:157] + "..."


def table(rows: list, first: str = "") -> list:
    head = (["Source"] if first else []) + ["Name", "Version", "Licence", "Class", "Note"]
    lines = ["| " + " | ".join(head) + " |", "|" + "---|" * len(head)]
    for r in rows:
        values = ([r["source"]] if first else []) + [r["name"], r["version"], r["licence"], r["class"], r["note"]]
        lines.append("| " + " | ".join(cell(v) for v in values) + " |")
    return lines


def markdown(rows: list, inputs: list, gaps: list, when: str | None, flags_only: bool) -> str:
    shipping = [r for r in rows if r["ships"]]
    out = ["# Third-party licences: CrateMind desktop bundle", ""]
    if not flags_only:
        out += ([f"Generated {when}." , ""] if when else []) + ["## Inputs", ""] + [f"- {i}" for i in inputs]
        out += ["", "## Not covered", ""] + ([f"- {g}" for g in gaps] or ["- nothing"]) + [""]
    out += ["## Flagged", ""]
    for cls in FLAGGED:
        hits = [r for r in shipping if r["class"] == cls]
        if hits:
            closed, gpl = WHY[cls]
            out += [f"### {cls} ({len(hits)})", "", f"- Closed build: {closed}.", f"- GPL-3 build: {gpl}.", ""] + table(hits, "source") + [""]
    if not any(r["class"] in FLAGGED for r in shipping):
        out += ["Nothing flagged.", ""]
    if flags_only:
        return "\n".join(out)
    for source in ("Python", "JavaScript", "Rust", "Media tools", "Vendored"):
        part = [r for r in shipping if r["source"] == source]
        if part:
            out += [f"## {source} ({len(part)})", ""] + table(part) + [""]
    unshipped = [r["name"] for r in rows if not r["ships"] and r["source"] == "Python"]
    if unshipped:
        out += ["In the Python venv but not in the bundle (not classified above): " + ", ".join(unshipped) + ".", ""]
    return "\n".join(out)


def main() -> int:
    venv = ROOT / "backend/.venv-desktop"
    default_site = next(iter(sorted(venv.glob("lib/python3*/site-packages"))), venv / "Lib/site-packages")
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--site-packages", type=Path, default=default_site)
    parser.add_argument("--date", help="date to print in the header (omitted when not given)")
    parser.add_argument("--out", type=Path, help="write to FILE instead of stdout")
    parser.add_argument("--flags", action="store_true", help="print only the flagged section")
    parser.add_argument("--json", action="store_true", help="machine-readable output")
    parser.add_argument("--fail-on", default="", help=f"exit 1 when shipping entries of these classes exist: {','.join(FLAGGED)}")
    args = parser.parse_args()
    fail_on = {c.strip() for c in args.fail_on.split(",") if c.strip()}
    if fail_on - set(CLASSES):
        parser.error(f"--fail-on takes classes from: {', '.join(CLASSES)}")
    inputs, gaps = [], []
    rows = (python_entries(args.site_packages.absolute(), inputs, gaps) + js_entries(ROOT / "frontend", inputs, gaps)
            + rust_entries(ROOT / "native/src-tauri/Cargo.toml", inputs, gaps) + media_entries(inputs, gaps) + vendored_entries(inputs, gaps))
    if args.json:
        text = json.dumps({"date": args.date, "inputs": inputs, "not_covered": gaps, "entries": rows}, indent=2) + "\n"
    else:
        text = markdown(rows, inputs, gaps, args.date, args.flags)
    if args.out:
        args.out.write_text(text)
    else:
        sys.stdout.write(text)
    return 1 if any(r["ships"] and r["class"] in fail_on for r in rows) else 0


if __name__ == "__main__":
    sys.exit(main())

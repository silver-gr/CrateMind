#!/usr/bin/env python3
"""Build a local macOS app, preserve PyInstaller links, and seal the final tree.

Only ad-hoc development apps are produced. Run after staging complete resources;
Tauri's resource copier dereferences onedir links, so its raw app is not final.
"""
from __future__ import annotations

import argparse
import json
import os
import platform
import plistlib
import shutil
import subprocess
import tempfile
from pathlib import Path

from stage_resources import macho
from verify_bundle import verify

ROOT = Path(__file__).resolve().parents[2]
NATIVE = ROOT / "native"
STAGED = NATIVE / "src-tauri/resources"


def restore_and_sign(artifact: Path) -> dict:
    if artifact.is_symlink() or not artifact.is_relative_to(NATIVE / "src-tauri/target"):
        raise RuntimeError("Only generated native target apps may be repaired")
    if not (STAGED / ".cratemind-staged-resources").is_file():
        raise RuntimeError("Complete marked staged resources are required")
    resources = artifact / "Contents/Resources"
    if not resources.is_dir():
        raise RuntimeError("Build the app before restoring its resources")
    config = json.loads((NATIVE / "src-tauri/tauri.conf.json").read_text())
    icon = next((NATIVE / "src-tauri" / name for name in config["bundle"].get("icon", [])
                 if name.endswith(".icns")), None)
    if icon is None or not icon.is_file() or icon.read_bytes()[:4] != b"icns":
        raise RuntimeError("A valid configured macOS app icon is required")
    shutil.copy2(icon, resources / icon.name)
    plist = artifact / "Contents/Info.plist"
    metadata = plistlib.loads(plist.read_bytes())
    metadata["CFBundleIconFile"] = icon.name
    plist.write_bytes(plistlib.dumps(metadata))
    # Replace complete staged trees: restoring only framework links leaves the
    # duplicate files created by Tauri's copier and changes Python's layout.
    # Refresh the other resources too so --repair-only uses the current stage.
    with tempfile.TemporaryDirectory(prefix=".staged-resources-", dir=resources) as temporary:
        for name in ("backend", "frontend", "tools", "licenses", "tool-inventory.json", "NOTICES.txt"):
            source = STAGED / name
            replacement = Path(temporary) / name
            if source.is_dir():
                shutil.copytree(source, replacement, symlinks=True)
            else:
                shutil.copy2(source, replacement, follow_symlinks=False)
            destination = resources / name
            if destination.is_symlink() or destination.is_file():
                destination.unlink()
            elif destination.exists():
                shutil.rmtree(destination)
            replacement.rename(destination)
    expected_links = {str(p.relative_to(STAGED / "backend")): os.readlink(p)
                      for p in (STAGED / "backend").rglob("*") if p.is_symlink()}
    actual_links = {str(p.relative_to(resources / "backend")): os.readlink(p)
                    for p in (resources / "backend").rglob("*") if p.is_symlink()}
    if actual_links != expected_links:
        raise RuntimeError("Final backend symlink tree differs from staging")
    # Sign real code inside out, then framework containers, then the app seal.
    # --deep is for verification; explicit nested signing avoids hiding errors.
    for path in sorted(artifact.rglob("*"), key=lambda p: len(p.parts), reverse=True):
        if not path.is_symlink() and path.is_file() and macho(path):
            subprocess.run(["/usr/bin/codesign", "--force", "--sign", "-", str(path)], check=True, capture_output=True)
    for path in sorted(artifact.rglob("*.framework"), key=lambda p: len(p.parts), reverse=True):
        if not path.is_symlink():
            subprocess.run(["/usr/bin/codesign", "--force", "--sign", "-", str(path)], check=True, capture_output=True)
    subprocess.run(["/usr/bin/codesign", "--force", "--sign", "-", str(artifact)], check=True, capture_output=True)
    result = verify(artifact)
    result["preserved_backend_symlinks"] = len(actual_links)
    return result


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--preview", action="store_true")
    parser.add_argument("--repair-only", action="store_true", help="Restore/sign an existing generated app without compiling")
    args = parser.parse_args()
    if platform.system() != "Darwin" or platform.machine() != "arm64":
        parser.error("This local packaging route supports macOS arm64 only")
    verify(STAGED)
    if not args.repair_only:
        command = ["bun", "run", "tauri", "build", "--bundles", "app"]
        if args.preview:
            command += ["--config", "src-tauri/tauri.preview.conf.json"]
        environment = dict(os.environ, CARGO_BUILD_JOBS="1")
        subprocess.run(command, cwd=NATIVE, env=environment, check=True)
    name = "CrateMind Preview" if args.preview else "CrateMind"
    artifact = NATIVE / "src-tauri/target/release/bundle/macos" / (name + ".app")
    print(json.dumps(restore_and_sign(artifact), indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

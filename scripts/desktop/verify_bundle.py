#!/usr/bin/env python3
"""Read-only integrity/self-containment checks for staged resources or a macOS app."""
from __future__ import annotations
import argparse
import json
import os
import platform
import plistlib
import re
import subprocess
from pathlib import Path
from stage_resources import macho, dependencies, runpaths, resolve_dependency, system_dependency


def resource_root(artifact: Path) -> Path:
    if artifact.suffix == ".app": return artifact / "Contents/Resources"
    return artifact


def windows_runtime_errors(backend: Path) -> list[str]:
    """Presence check (not a full closure) for the MSVC runtime the DSP stack links against."""
    # Exact names only: delvewheel's renamed copies (msvcp140-<hash>.dll) satisfy
    # just the wheel that vendored them, not a plain import from llvmlite/numba.
    # A renamed copy still embeds its own original name, so it is not an importer.
    names = {path.name.lower() for path in backend.rglob("*.dll")}
    errors = [] if "vcruntime140.dll" in names else ["Missing MSVC runtime: vcruntime140.dll"]
    wanted = [name for name in ("msvcp140.dll", "msvcp140_1.dll", "vcruntime140_1.dll") if name not in names]
    imported = set()
    for path in backend.rglob("*"):
        if wanted and path.suffix.lower() in {".dll", ".pyd"} and path.is_file():
            data = path.read_bytes().lower()
            imported.update(name for name in wanted
                            if not path.name.lower().startswith(name.removesuffix(".dll") + "-") and name.encode() in data)
    errors.extend(f"Missing MSVC runtime: {name} (imported by a bundled module)" for name in wanted if name in imported)
    return errors


def verify(artifact: Path) -> dict:
    resources = resource_root(artifact)
    errors = []
    executable = resources / "backend" / ("cratemind-backend.exe" if os.name == "nt" else "cratemind-backend")
    for required in [executable, resources / "backend/_internal", resources / "frontend/index.html", resources / "tool-inventory.json", resources / "NOTICES.txt"]:
        if not required.exists(): errors.append(f"Missing required resource: {required.relative_to(resources)}")
    for tool in ["ffmpeg", "ffprobe", "fpcalc"]:
        path = resources / "tools" / (tool + (".exe" if os.name == "nt" else ""))
        if not path.is_file(): errors.append(f"Missing tool: {tool}")
        elif os.name != "nt" and not os.access(path, os.X_OK): errors.append(f"Tool not executable: {tool}")
    for package in ["librosa", "scipy", "numba", "llvmlite"]:
        if not (resources / "backend/_internal" / package).is_dir(): errors.append(f"Missing local analysis dependency: {package}")
    if os.name == "nt": errors.extend(windows_runtime_errors(resources / "backend"))
    backend_bytes = sum(path.stat().st_size for path in (resources / "backend").rglob("*") if path.is_file() and not path.is_symlink())
    count = 0
    total = 0
    native_count = 0
    deployment_minima = {}
    for path in resources.rglob("*"):
        relative = path.relative_to(resources)
        lower = path.name.lower()
        if lower == ".env" or lower.startswith(".env.") or path.suffix.lower() in {".sqlite", ".sqlite3", ".db"} or ("calibration" in lower and path.suffix.lower() in {".html", ".json", ".csv"}):
            errors.append(f"Private/generated data in bundle: {relative}")
        if any(part.lower().split("-")[0] == "essentia" for part in relative.parts):
            errors.append(f"Excluded DSP dependency in bundle: {relative}")
        if path.is_symlink():
            try:
                if not path.resolve(strict=True).is_relative_to(resources.resolve()): errors.append(f"Escaping resource symlink: {relative}")
            except OSError: errors.append(f"Broken resource symlink: {relative}")
            continue
        if not path.is_file(): continue
        count += 1
        total += path.stat().st_size
        if platform.system() == "Darwin" and macho(path):
            native_count += 1
            commands = subprocess.check_output(["/usr/bin/otool", "-l", str(path)], text=True)
            versions = re.findall(r"^\s*minos (\d+(?:\.\d+){0,2})", commands, re.MULTILINE)
            versions += re.findall(r"cmd LC_VERSION_MIN_MACOSX\n\s*cmdsize \d+\n\s*version (\d+(?:\.\d+){0,2})", commands)
            for version in versions: deployment_minima[str(relative)] = version
            owner_executable = path if path.parent == resources / "tools" else executable
            for dependency in dependencies(path):
                if system_dependency(dependency): continue
                try:
                    resolved = resolve_dependency(dependency, path, owner_executable)
                    if not resolved.is_relative_to(resources.resolve()): errors.append(f"External native dependency {relative}: {dependency}")
                except (OSError, RuntimeError) as exc: errors.append(str(exc))
            result = subprocess.run(["/usr/bin/codesign", "--verify", "--strict", str(path)], text=True, capture_output=True)
            if result.returncode: errors.append(f"Invalid ad-hoc/native signature: {relative}: {result.stderr.strip()}")
    if platform.system() == "Darwin" and artifact.suffix == ".app":
        metadata = plistlib.loads((artifact / "Contents/Info.plist").read_bytes())
        icon_name = metadata.get("CFBundleIconFile")
        if not isinstance(icon_name, str) or not icon_name or Path(icon_name).name != icon_name:
            errors.append("Missing or invalid app icon metadata")
        else:
            icon = resources / (icon_name if icon_name.endswith(".icns") else icon_name + ".icns")
            if not icon.is_file() or icon.read_bytes()[:4] != b"icns":
                errors.append("Missing or invalid bundled macOS icon")
        declared = metadata.get("LSMinimumSystemVersion")
        def version_tuple(value):
            parts = tuple(map(int, value.split(".")))
            return parts + (0,) * (3 - len(parts))
        if not isinstance(declared, str): errors.append("Missing macOS minimum version in app metadata")
        elif any(version_tuple(value) > version_tuple(declared) for value in deployment_minima.values()):
            errors.append(f"App macOS minimum {declared} is below a bundled dependency requirement")
        result = subprocess.run(["/usr/bin/codesign", "--verify", "--deep", "--strict", str(artifact)], text=True, capture_output=True)
        if result.returncode: errors.append(f"Invalid complete app signature: {result.stderr.strip()}")
    if errors: raise RuntimeError("Bundle verification failed:\n" + "\n".join(dict.fromkeys(errors)))
    return {"artifact": str(artifact), "resources": str(resources), "files": count, "resource_bytes": total, "backend_bytes": backend_bytes, "native_binaries": native_count, "dependency_minimum_macos": max(deployment_minima.values(), key=lambda value: tuple(map(int,value.split(".")))) if deployment_minima else None, "data_exclusion": "passed", "native_dependencies": "passed on macOS" if platform.system() == "Darwin" else "not verified on this platform", "release_signing": "not established; local ad-hoc signatures only", "installed_webview_qa": "not established by resource verification"}


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--artifact", type=Path, required=True)
    args = parser.parse_args()
    print(json.dumps(verify(args.artifact.absolute()), indent=2))
    return 0

if __name__ == "__main__": raise SystemExit(main())

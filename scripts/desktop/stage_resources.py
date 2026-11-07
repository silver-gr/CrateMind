#!/usr/bin/env python3
"""Stage complete backend/frontend and explicitly selected media tools, preserving links."""
from __future__ import annotations
import argparse
import hashlib
import json
import os
import platform
import shutil
import subprocess
import tempfile
import time
import uuid
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]

def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        while block := stream.read(1024 * 1024): digest.update(block)
    return digest.hexdigest()

def rename_settled(source: Path, target: Path) -> None:
    """Windows can deny a directory rename for a moment while a scanner or indexer holds a
    handle on the freshly written tree (WinError 5 in CI); retry briefly before failing."""
    for attempt in range(10):
        try:
            source.rename(target)
            return
        except PermissionError:
            if os.name != "nt" or attempt == 9: raise
            time.sleep(1)


def macho(path: Path) -> bool:
    try:
        with path.open("rb") as stream: return stream.read(4) in (b"\xcf\xfa\xed\xfe", b"\xfe\xed\xfa\xcf", b"\xca\xfe\xba\xbe", b"\xbe\xba\xfe\xca")
    except (OSError, IsADirectoryError): return False

def dependencies(path: Path) -> list[str]:
    values = [line.strip().split(" (compatibility", 1)[0] for line in subprocess.check_output(["/usr/bin/otool", "-L", str(path)], text=True).splitlines()[1:] if line.strip()]
    identity = subprocess.check_output(["/usr/bin/otool", "-D", str(path)], text=True).splitlines()[1:]
    return [value for value in values if value not in identity]

def runpaths(path: Path) -> list[str]:
    lines = subprocess.check_output(["/usr/bin/otool", "-l", str(path)], text=True).splitlines()
    return [lines[index + 2].strip().split(" ")[1] for index, line in enumerate(lines[:-2]) if line.strip() == "cmd LC_RPATH"]

def system_dependency(value: str) -> bool:
    return value.startswith(("/usr/lib/", "/System/Library/"))

def resolve_dependency(value: str, owner: Path, executable: Path) -> Path:
    def expand(raw: str) -> Path:
        return Path(raw.replace("@loader_path", str(owner.parent)).replace("@executable_path", str(executable.parent)))
    if value.startswith("@rpath/"):
        for prefix in [*runpaths(owner), *runpaths(executable)]:
            candidate = expand(prefix) / value.removeprefix("@rpath/")
            if candidate.is_file(): return candidate.resolve()
        raise RuntimeError(f"Unresolved tool library {value} from {owner}")
    candidate = expand(value)
    if not candidate.is_file(): raise RuntimeError(f"Missing tool library {candidate}")
    return candidate.resolve()

def stage_macos_tools(sources: dict[str, Path], output: Path) -> dict:
    libraries = output / "lib"
    libraries.mkdir()
    mapping: dict[Path, Path] = {}
    owners: dict[Path, Path] = {}
    queue: list[tuple[Path, Path]] = []
    names: dict[str, Path] = {}
    for name, source in sources.items():
        source = source.resolve()
        if not macho(source): raise RuntimeError(f"Tool is not a Mach-O binary: {source}")
        destination = output / name
        shutil.copy2(source, destination)
        mapping[source] = destination
        owners[source] = source
        queue.append((source, source))
    edges: dict[Path, list[tuple[str, Path]]] = {}
    for source, executable in queue:
        edges[source] = []
        for original in dependencies(source):
            if system_dependency(original): continue
            library = resolve_dependency(original, source, executable)
            if library == source: continue # dylib install identity
            edges[source].append((original, library))
            if library not in mapping:
                if library.name in names and names[library.name] != library:
                    raise RuntimeError(f"Conflicting library basename {library.name}")
                names[library.name] = library
                destination = libraries / library.name
                shutil.copy2(library, destination)
                mapping[library] = destination
                owners[library] = executable
                queue.append((library, executable))
    for source, destination in mapping.items():
        destination.chmod(destination.stat().st_mode | 0o200)
        for original, library in edges[source]:
            relative = os.path.relpath(mapping[library], destination.parent)
            subprocess.run(["/usr/bin/install_name_tool", "-change", original, "@loader_path/" + relative, str(destination)], check=True, capture_output=True)
        for prefix in runpaths(destination):
            if prefix.startswith(("/opt/", "/usr/local/", "/Users/")):
                subprocess.run(["/usr/bin/install_name_tool", "-delete_rpath", prefix, str(destination)], check=True, capture_output=True)
        if destination.parent == libraries:
            subprocess.run(["/usr/bin/install_name_tool", "-id", "@rpath/" + destination.name, str(destination)], check=True, capture_output=True)
        subprocess.run(["/usr/bin/codesign", "--force", "--sign", "-", str(destination)], check=True, capture_output=True)
    versions = {}
    for name in sources:
        result = subprocess.run([str(output / name), "-version"], env={"PATH": ""}, text=True, capture_output=True, timeout=30, check=True)
        versions[name] = {"source": str(sources[name].resolve()), "source_sha256": sha256(sources[name]), "staged_sha256": sha256(output / name), "version": (result.stdout or result.stderr).splitlines()[0]}
    return {"tools": versions, "libraries": [{"name": path.name, "source": str(source), "source_sha256": sha256(source), "staged_sha256": sha256(path)} for source, path in mapping.items() if path.parent == libraries]}

def stage_windows_tools(sources: dict[str, Path], output: Path) -> dict:
    # Static LGPL FFmpeg and Chromaprint fpcalc builds are self-contained .exe files: copy only.
    versions = {}
    for name, source in sources.items():
        destination = output / (name + ".exe")
        shutil.copy2(source, destination)
        result = subprocess.run([str(destination), "-version"], text=True, capture_output=True, timeout=30, check=True)
        versions[name] = {"source": str(source), "source_sha256": sha256(source), "staged_sha256": sha256(destination), "version": (result.stdout or result.stderr).splitlines()[0]}
    return {"tools": versions, "libraries": []}

def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--backend", type=Path, default=ROOT / "build/desktop/backend/cratemind-backend")
    parser.add_argument("--frontend", type=Path, default=ROOT / "frontend/dist-desktop")
    parser.add_argument("--output", type=Path, default=ROOT / "native/src-tauri/resources")
    for tool in ("ffmpeg", "ffprobe", "fpcalc"): parser.add_argument("--" + tool, type=Path, required=True)
    parser.add_argument("--license-file", type=Path, action="append", default=[], help="Windows only: upstream licence text to include (repeatable)")
    args = parser.parse_args()
    backend, frontend, output = args.backend.absolute(), args.frontend.absolute(), args.output.absolute()
    if not (backend / "_internal").is_dir() or not (frontend / "index.html").is_file():
        parser.error("Complete backend onedir and built desktop frontend are required")
    if platform.system() not in ("Darwin", "Windows"):
        parser.error("Non-macOS tool dependency staging requires a native-platform implementation")
    for name in ("ffmpeg", "ffprobe", "fpcalc"):
        if not getattr(args,name).is_file(): parser.error(f"Missing explicitly selected tool: {name}")
    final_output = output
    final_output.parent.mkdir(parents=True, exist_ok=True)
    staging = tempfile.TemporaryDirectory(prefix=".cratemind-stage-", dir=final_output.parent)
    output = Path(staging.name)
    for name, source in [("backend", backend), ("frontend", frontend)]:
        destination = output / name
        if destination.exists(): shutil.rmtree(destination)
        shutil.copytree(source, destination, symlinks=True)
    if platform.system() == "Darwin":
        # PyInstaller retains the Python framework but omits its original signature resource seal.
        # Re-seal copied framework resources before the enclosing Tauri app is signed.
        for framework in sorted((output / "backend").rglob("*.framework"), key=lambda path: len(path.parts), reverse=True):
            subprocess.run(["/usr/bin/codesign", "--force", "--sign", "-", str(framework)], check=True, capture_output=True)
    tools = output / "tools"
    if tools.exists(): shutil.rmtree(tools)
    tools.mkdir()
    sources = {name: getattr(args, name).absolute() for name in ("ffmpeg", "ffprobe", "fpcalc")}
    if platform.system() == "Darwin": inventory = stage_macos_tools(sources, tools)
    elif platform.system() == "Windows": inventory = stage_windows_tools(sources, tools)
    else:
        parser.error("Non-macOS tool dependency staging needs native-platform implementation; do not ship host tools")
    manifest_path = backend.parent / "build-manifest.json"
    inventory["backend"] = json.loads(manifest_path.read_text()) if manifest_path.is_file() else {"self_test": "not supplied"}
    frontend_hashes = {str(path.relative_to(output / "frontend")): sha256(path)
                       for path in sorted((output / "frontend").rglob("*")) if path.is_file()}
    inventory["frontend"] = {"sha256": hashlib.sha256(json.dumps(frontend_hashes, sort_keys=True, separators=(",", ":")).encode()).hexdigest(),
                             "file_sha256": frontend_hashes}
    inventory["platform"] = platform.platform()
    if platform.system() == "Windows":
        inventory["signing"] = "unsigned Windows development build; not distributable"
        inventory["licenses"] = "FFmpeg (LGPL build): LGPL-2.1-or-later; Chromaprint fpcalc: LGPL-2.1-or-later; redistribution requires complete license/source compliance review"
    else:
        inventory["signing"] = "ad-hoc local development; not notarized or distributable"
        inventory["licenses"] = "GPL-enabled FFmpeg and Chromaprint; redistribution requires complete license/source compliance review"
    (output / "tool-inventory.json").write_text(json.dumps(inventory, indent=2) + "\n")
    license_dir = output / "licenses"
    license_dir.mkdir(exist_ok=True)
    formulas = set()
    for source in [*sources.values(), *(Path(item["source"]) for item in inventory.get("libraries", []))]:
        real = source.resolve()
        if "Cellar" in real.parts:
            index = real.parts.index("Cellar")
            formula = Path(*real.parts[:index+3])
            if formula in formulas: continue
            formulas.add(formula)
            destination = license_dir / (formula.parent.name + "-" + formula.name)
            destination.mkdir(exist_ok=True)
            for path in formula.iterdir():
                if path.is_file() and (path.name.upper().startswith(("LICENSE", "COPYING", "COPYRIGHT")) or path.name == "sbom.spdx.json"):
                    shutil.copy2(path, destination / path.name)
    for path in args.license_file:
        if not path.is_file(): parser.error(f"Missing licence file: {path}")
        shutil.copy2(path, license_dir / path.name)
    notices = output / "NOTICES.txt"
    notices.write_text("CrateMind local development bundle\n\n" + inventory["licenses"] + "\nExact source versions and binary hashes: tool-inventory.json\nFFmpeg: https://ffmpeg.org/legal.html\nChromaprint: https://acoustid.org/chromaprint\nTool license texts and Homebrew SPDX inventories: licenses/. Python package notices remain in backend/_internal.\nNo signed distribution or license-complete release is claimed.\n")
    (output / ".cratemind-staged-resources").write_text("1\n")
    previous = final_output.with_name(final_output.name + ".previous-" + uuid.uuid4().hex)
    if final_output.exists(): rename_settled(final_output, previous)
    try: rename_settled(output, final_output)
    except BaseException:
        if previous.exists(): previous.rename(final_output)
        raise
    staging.cleanup()
    if previous.exists(): shutil.rmtree(previous)
    output = final_output
    print(json.dumps({"resources": str(output), "tool_libraries": len(inventory.get("libraries", [])), "bytes": sum(p.stat().st_size for p in output.rglob("*") if p.is_file() and not p.is_symlink())}))
    return 0

if __name__ == "__main__": raise SystemExit(main())

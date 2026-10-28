#!/usr/bin/env python3
"""Build the current target's complete onedir using the isolated Python 3.13 core."""
from __future__ import annotations
import argparse
import hashlib
import json
import os
import platform
import subprocess
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]

def source_manifest() -> dict:
    paths = [path for directory in (ROOT / "backend/app", ROOT / "backend/packaging")
             for path in directory.rglob("*") if path.is_file() and path.suffix in {".py", ".json", ".spec"}]
    paths += [ROOT / "backend/pyproject.toml", ROOT / "backend/uv.lock", Path(__file__).resolve()]
    hashes = {str(path.relative_to(ROOT)): hashlib.sha256(path.read_bytes()).hexdigest()
              for path in sorted(paths)}
    digest = hashlib.sha256(json.dumps(hashes, sort_keys=True, separators=(",", ":")).encode()).hexdigest()
    return {"sha256": digest, "file_sha256": hashes, "includes_untracked_sources": True}

def native_target() -> str:
    architecture = {"arm64": "aarch64", "AMD64": "x86_64"}.get(platform.machine(), platform.machine())
    suffix = {"Darwin": "apple-darwin", "Windows": "pc-windows-msvc", "Linux": "unknown-linux-gnu"}[platform.system()]
    return f"{architecture}-{suffix}"

def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--target", default=native_target())
    parser.add_argument("--python", type=Path, default=ROOT / "backend/.venv-desktop" / ("Scripts/python.exe" if os.name == "nt" else "bin/python"))
    parser.add_argument("--output", type=Path, default=ROOT / "build/desktop/backend")
    parser.add_argument("--self-test", action="store_true")
    args = parser.parse_args()
    if args.target != native_target():
        parser.error("PyInstaller must run natively on the requested target; cross compilation is unsupported")
    python = args.python.absolute()
    version = subprocess.check_output([str(python), "-c", "import sys,PyInstaller,json;print(json.dumps([list(sys.version_info[:3]),PyInstaller.__version__]))"], text=True)
    python_version, pyinstaller_version = json.loads(version)
    if python_version[:2] != [3, 13] or pyinstaller_version != "6.22.3":
        parser.error("The desktop build requires Python 3.13 and PyInstaller 6.22.3")
    output = args.output.absolute()
    output.mkdir(parents=True, exist_ok=True)
    subprocess.run([str(python), "-m", "PyInstaller", "--noconfirm", "--clean", "--distpath", str(output), "--workpath", str(ROOT / "build/desktop/pyinstaller"), str(ROOT / "backend/packaging/desktop.spec")], cwd=ROOT / "backend", check=True)
    bundle = output / "cratemind-backend"
    executable = bundle / ("cratemind-backend.exe" if os.name == "nt" else "cratemind-backend")
    if not executable.is_file() or not (bundle / "_internal").is_dir():
        raise RuntimeError("Incomplete onedir output")
    manifest = {"target": args.target, "python": ".".join(map(str, python_version)), "pyinstaller": pyinstaller_version, "source_revision": subprocess.check_output(["git", "rev-parse", "HEAD"], cwd=ROOT, text=True).strip(), "working_tree_build": True, "python_packages": json.loads(subprocess.check_output([str(python), "-c", "import importlib.metadata,json;print(json.dumps(sorted([{\"name\":d.metadata[\"Name\"],\"version\":d.version} for d in importlib.metadata.distributions()],key=lambda d:d[\"name\"].lower())))"], text=True))}
    manifest["source_tree"] = source_manifest()
    manifest["executable_sha256"] = hashlib.sha256(executable.read_bytes()).hexdigest()
    (output / "build-manifest.json").write_text(json.dumps(manifest, indent=2) + "\n")
    if args.self_test:
        environment = {key: value for key, value in os.environ.items() if not key.upper().startswith(("CRATEMIND_", "PYTHON", "DYLD_"))}
        environment["PATH"] = ""
        with tempfile.TemporaryDirectory(prefix="cratemind-frozen-self-test-") as temporary:
            result = subprocess.run([str(executable), "--self-test"], cwd=temporary, env=environment, capture_output=True, text=True, timeout=90)
            contract = bundle / "_internal/app/desktop_runtime/deno_schema_contract.json"
            if json.loads(contract.read_text()).get("version") != 1:
                raise RuntimeError("Frozen Deno adoption schema resource is missing or invalid")
            unavailable = subprocess.run([str(executable), "--exchange-cli", "inspect-deno", "--source", str(Path(temporary) / "absent-deno.sqlite")], cwd=temporary, env=environment, capture_output=True, text=True, timeout=30)
            if unavailable.returncode != 1 or not isinstance(json.loads(unavailable.stderr).get("error"), str):
                raise RuntimeError("Frozen Deno operator CLI did not safely reject the missing explicit fixture source")
        if result.returncode:
            raise RuntimeError(f"Frozen self-test failed ({result.returncode}):\n{result.stdout}\n{result.stderr}")
        manifest["self_test"] = json.loads(result.stdout.strip().splitlines()[-1])
        manifest["self_test"]["deno_schema_resource"] = "passed"
        manifest["self_test"]["deno_explicit_missing_source"] = "structured rejection"
        (output / "build-manifest.json").write_text(json.dumps(manifest, indent=2) + "\n")
        print(result.stdout.strip())
    print(json.dumps({"bundle": str(bundle), "manifest": str(output / "build-manifest.json")}))
    return 0

if __name__ == "__main__":
    raise SystemExit(main())

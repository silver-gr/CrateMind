"""Pure helpers of the desktop packaging scripts for bundled local analysis."""
from __future__ import annotations

import sys
import tomllib
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[2]


@pytest.fixture(scope="module")
def scripts():
    # The scripts import their siblings (stage_resources, verify_bundle) by name.
    sys.path.insert(0, str(ROOT / "scripts/desktop"))
    try:
        import smoke_installed
        import verify_bundle
        yield verify_bundle, smoke_installed
    finally:
        sys.path.remove(str(ROOT / "scripts/desktop"))


def test_windows_runtime_requires_vcruntime(scripts, tmp_path):
    verify_bundle, _ = scripts
    assert verify_bundle.windows_runtime_errors(tmp_path) == ["Missing MSVC runtime: vcruntime140.dll"]
    (tmp_path / "_internal").mkdir()
    (tmp_path / "_internal/VCRUNTIME140.dll").write_bytes(b"MZ")
    assert verify_bundle.windows_runtime_errors(tmp_path) == []


def test_msvcp_required_only_when_a_bundled_module_imports_it(scripts, tmp_path):
    verify_bundle, _ = scripts
    (tmp_path / "vcruntime140.dll").write_bytes(b"MZ")
    module = tmp_path / "_internal/scipy/_fake.cp313-win_amd64.pyd"
    module.parent.mkdir(parents=True)
    module.write_bytes(b"MZ\x00KERNEL32.dll\x00")
    assert verify_bundle.windows_runtime_errors(tmp_path) == []
    module.write_bytes(b"MZ\x00MSVCP140.dll\x00")
    assert verify_bundle.windows_runtime_errors(tmp_path) == [
        "Missing MSVC runtime: msvcp140.dll (imported by a bundled module)"]
    (tmp_path / "_internal/msvcp140.dll").write_bytes(b"MZ")
    assert verify_bundle.windows_runtime_errors(tmp_path) == []


def test_smoke_backend_environment_drops_overrides(scripts):
    _, smoke_installed = scripts
    source = {"HOME": "/fixture", "PATH": "/bin", "NUMBA_CACHE_DIR": "/x", "librosa_cache_dir": "/y",
              "CRATEMIND_DB_PATH": "/z", "PYTHONPATH": "/w", "DYLD_LIBRARY_PATH": "/v"}
    assert smoke_installed.backend_environment(source) == {"HOME": "/fixture", "PATH": ""}


def test_desktop_group_bundles_local_dsp_without_essentia():
    groups = tomllib.loads((ROOT / "backend/pyproject.toml").read_text())["dependency-groups"]
    desktop = " ".join(groups["desktop"])
    assert "librosa" in desktop and "scipy" in desktop and "essentia" not in desktop
    assert all(isinstance(item, str) for item in groups["desktop"])  # no include of the analysis group

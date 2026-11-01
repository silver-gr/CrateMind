"""Guard: the test session must never resolve the user's real data or .env."""
from __future__ import annotations

from pathlib import Path

from app.config import BACKEND_DIR, Settings

HOME = Path.home()
FORBIDDEN = [
    (HOME / "Library" / "Application Support").resolve(),
    (BACKEND_DIR / "data").resolve(),
]


def _under(path: Path, parent: Path) -> bool:
    try:
        path.resolve().relative_to(parent)
        return True
    except ValueError:
        return False


def test_env_file_disabled():
    assert Settings.model_config["env_file"] is None


def test_env_file_values_not_loaded(tmp_path, monkeypatch):
    env = tmp_path / ".env"
    env.write_text("CRATEMIND_DATASET_ROOT=/sentinel/from-env-file\n")
    monkeypatch.chdir(tmp_path)
    assert Settings().dataset_root == ""


def test_settings_paths_are_safe():
    s = Settings()
    assert s.dataset_root == ""
    paths = [s.db_file, s.backup_path, s.output_path, *s.roots]
    for p in paths:
        for bad in FORBIDDEN:
            assert not _under(p, bad), f"{p} resolves under {bad}"
        assert "gr.x3lixi" not in str(p)


def test_djay_sources_never_resolve_under_real_user_dirs():
    from app.config import get_settings
    from app.services import djay_import

    get_settings.cache_clear()
    get_settings()  # populate the cache first, as earlier test files do
    library, metadata = djay_import.resolve_sources(get_settings())
    bad_parents = [HOME, Path("/Users"), HOME / "Music", HOME / "Library" / "Group Containers"]
    for p in (library, metadata):
        assert not p.exists(), p
        for bad in bad_parents:
            assert not _under(p, bad), f"{p} resolves under {bad}"
        assert "/Music/djay" not in str(p) and "Group Containers" not in str(p)

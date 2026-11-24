"""Desktop «Αντίγραφα ασφαλείας που κρατιούνται»: preference → backup_keep → launch prune."""
import json
import shutil

import pytest

from app import config
from app.library_exchange.operations import initialize_empty
from app.runtime_profile import RuntimeProfile, runtime_profile


def _settings(tmp_path, monkeypatch, preferences: str | None, profile=RuntimeProfile.DESKTOP_CORE):
    initialize_empty(tmp_path)
    if preferences is not None:
        (tmp_path / "preferences.json").write_text(preferences, encoding="utf-8")
    monkeypatch.setenv("CRATEMIND_DATASET_ROOT", str(tmp_path))
    for key in ("CRATEMIND_DB_PATH", "CRATEMIND_IDENTITY_DB_PATH", "CRATEMIND_BACKUP_KEEP"):
        monkeypatch.delenv(key, raising=False)
    config.get_settings.cache_clear()
    try:
        with runtime_profile(profile):
            return config.get_settings()
    finally:
        config.get_settings.cache_clear()


def _pref(value) -> str:
    return json.dumps({"cratemind-backup-keep": value})


@pytest.mark.parametrize("raw, keep", [
    (_pref("1"), 1), (_pref("3"), 3), (_pref("5"), 5), (_pref("7"), 7),
    (None, 3), (json.dumps({}), 3), (_pref("0"), 3), (_pref("8"), 3), (_pref("-1"), 3),
    (_pref("abc"), 3), (_pref(""), 3), (_pref(" 1"), 3), (_pref("1.0"), 3), (_pref("01"), 3),
    (_pref(1), 3), (_pref(None), 3), ("{not json", 3), ("[]", 3), (json.dumps({"x": "1"}), 3),
])
def test_desktop_backup_keep_preference(tmp_path, monkeypatch, raw, keep):
    assert _settings(tmp_path, monkeypatch, raw).backup_keep == keep


def test_web_profile_ignores_the_preference_file(tmp_path, monkeypatch):
    assert _settings(tmp_path, monkeypatch, _pref("1"), RuntimeProfile.WEB).backup_keep == 3


@pytest.fixture
def launch(db, tmp_path):
    import app.db as dbmod
    dbmod._settings.__dict__['backup_dir'] = str(tmp_path / 'bk')
    return dbmod


def _launch(dbmod):
    dbmod.launch_phase.clear()
    return dbmod.backup_on_launch(), dbmod.launch_phase['backup']


def _bundles(root):
    return sorted(root.glob('cratemind-*'))


@pytest.mark.parametrize("value, older, kept", [
    ("1", 4, 1), ("3", 4, 3), ("7", 9, 7), ("7", 3, 4), ("3", 1, 2),
])
def test_launch_keeps_the_chosen_number_of_bundles(launch, tmp_path, monkeypatch, value, older, kept):
    keep = _settings(tmp_path / 'desktop', monkeypatch, _pref(value)).backup_keep
    monkeypatch.setattr(launch._settings, 'backup_keep', keep)
    first, _ = _launch(launch)
    olds = [first.parent / f'cratemind-2020{index + 1:02d}01T000000000000Z' for index in range(older)]
    for old in olds:  # bundles from earlier days
        shutil.copytree(first, old)
    again, reason = _launch(launch)
    assert again == first and reason == 'reused'
    remaining = _bundles(first.parent)
    assert len(remaining) == kept and first in remaining
    assert remaining == olds[len(olds) - (kept - 1):] + [first]  # the oldest went


def test_keep_one_spares_non_bundles_and_broken_bundles(launch, monkeypatch):
    monkeypatch.setattr(launch._settings, 'backup_keep', 1)
    first, _ = _launch(launch)
    root = first.parent
    old = root / 'cratemind-20200101T000000000000Z'
    shutil.copytree(first, old)
    broken = root / 'cratemind-20990101T000000000000Z'  # newest name, fails verification
    shutil.copytree(first, broken)
    (broken / 'manifest.json').write_text('{}', encoding='utf-8')
    other = root / 'my-copy'
    shutil.copytree(first, other)
    link = root / 'cratemind-20200102T000000000000Z'
    link.symlink_to(old, target_is_directory=True)
    bundle, reason = _launch(launch)
    assert reason == 'new:unverified'
    assert bundle.is_dir() and broken.is_dir() and other.is_dir() and link.is_symlink()
    assert not old.exists() and not first.exists()

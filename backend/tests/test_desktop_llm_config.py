import json

from app import config
from app.library_exchange.operations import initialize_empty
from app.runtime_profile import RuntimeProfile, runtime_profile


def _desktop_settings(tmp_path, monkeypatch, extra: dict):
    initialize_empty(tmp_path)
    cfg = json.loads((tmp_path / "desktop-config.json").read_text()) if (tmp_path / "desktop-config.json").exists() \
        else {"version": 1, "revision": "initial", "library_roots": []}
    (tmp_path / "desktop-config.json").write_text(json.dumps({**cfg, **extra}))
    monkeypatch.setenv("CRATEMIND_DATASET_ROOT", str(tmp_path))
    for key in ("CRATEMIND_DB_PATH", "CRATEMIND_IDENTITY_DB_PATH"):  # conftest pins these; a dataset root owns them here
        monkeypatch.delenv(key, raising=False)
    config.get_settings.cache_clear()
    try:
        with runtime_profile(RuntimeProfile.DESKTOP_CORE):
            return config.get_settings()
    finally:
        config.get_settings.cache_clear()


def test_desktop_reads_llm1_from_desktop_config(tmp_path, monkeypatch):
    settings = _desktop_settings(tmp_path, monkeypatch, {
        "llm1_base_url": "http://127.0.0.1:9/v1", "llm1_api_key": "test-key",
        "llm1_model": "test-model", "llm1_model_effort": "max"})
    assert (settings.llm1_base_url, settings.llm1_api_key, settings.llm1_model, settings.llm1_model_effort) == \
        ("http://127.0.0.1:9/v1", "test-key", "test-model", "max")


def test_desktop_ignores_empty_or_non_string_llm1_values(tmp_path, monkeypatch):
    settings = _desktop_settings(tmp_path, monkeypatch, {"llm1_base_url": "", "llm1_model": 5})
    assert settings.llm1_base_url == "" and settings.llm1_model == "" and settings.llm1_model_effort == "high"

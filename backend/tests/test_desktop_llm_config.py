import json

from app import config
from app.services import llm_config
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


def test_desktop_reads_the_llm_file_beside_its_config(tmp_path, monkeypatch):
    llm_config.write_file(tmp_path / llm_config.FILE_NAME, {
        "base_url": "http://127.0.0.1:9/v1", "api_key": "test-key", "model": "test-model", "effort": "max"})
    settings = _desktop_settings(tmp_path, monkeypatch, {})
    current = llm_config.current(settings)
    assert (current.llm1_base_url, current.llm1_api_key, current.llm1_model, current.llm1_model_effort) == \
        ("http://127.0.0.1:9/v1", "test-key", "test-model", "max")
    assert set(current.sources.values()) == {"file"}


def test_desktop_no_longer_reads_llm_values_from_desktop_config(tmp_path, monkeypatch):
    # They move to the LLM file once, at desktop start (`migrate_desktop_config`).
    settings = _desktop_settings(tmp_path, monkeypatch, {
        "llm1_base_url": "http://127.0.0.1:9/v1", "llm1_api_key": "test-key", "llm1_model": "test-model"})
    current = llm_config.current(settings)
    assert current.llm1_base_url == "" and current.llm1_api_key == "" and current.llm1_model_effort == "high"

"""The LLM connection used by artist research: endpoint, model, reasoning effort and API key.

Settings saves them in one small file, `llm-settings.json`, in CrateMind's per-user data
folder (the desktop app-data folder, or the folder of the web runner's database), never
inside a dataset generation, so no backup bundle or exchange bundle ever contains it. The
file is written atomically with user-only permissions (0600 on POSIX; on Windows the
per-user profile folder's own ACL). It is not encrypted and uses no system keychain: anyone
who can act as this user account can read it. A non-empty `CRATEMIND_LLM1_*` value (the web
runner's environment or `.env`) stays in use over the file, and `sources` says which one is.

The file is read on every call, so a save takes effect without a restart or cache clear.
"""
from __future__ import annotations

import json
import os
import re
import tempfile
import threading
from dataclasses import dataclass, field
from pathlib import Path
from urllib.parse import urlsplit

from ..config import Settings, get_settings

FILE_NAME = "llm-settings.json"
MAX_FILE_BYTES = 64 * 1024
# The values Settings offers; the client sends the chosen one as `reasoning.effort`.
EFFORTS = ("minimal", "low", "medium", "high", "xhigh", "max")
NO_EFFORT = "none"  # stored as is; the client then sends no effort at all
# UI name -> Settings field (and the CRATEMIND_* variable that overrides it).
FIELDS = {"base_url": "llm1_base_url", "model": "llm1_model",
          "effort": "llm1_model_effort", "api_key": "llm1_api_key"}
_LIMITS = {"base_url": 2048, "model": 200, "effort": 32, "api_key": 4096}
_CONTROL = re.compile(r"[\x00-\x20\x7f]")
_lock = threading.Lock()


def env_name(name: str) -> str:
    return "CRATEMIND_" + FIELDS[name].upper()


def data_dir(settings=None) -> Path:
    """CrateMind's per-user data folder: the desktop app-data folder (the dataset root the
    runner points at), else the folder of the web runner's database."""
    s = settings or get_settings()
    return Path(s.dataset_root).expanduser() if s.dataset_root else s.db_file.parent


def file_path(settings=None) -> Path:
    return data_dir(settings) / FILE_NAME


def _clean(name: str, value) -> str | None:
    if not isinstance(value, str):
        return None
    value = value.strip()
    if not value or len(value) > _LIMITS[name] or _CONTROL.search(value):
        return None
    return value


def read_file(path: Path) -> dict[str, str]:
    """The stored values that pass the same checks as a save; anything unreadable is empty."""
    try:
        if not path.is_file() or path.stat().st_size > MAX_FILE_BYTES:
            return {}
        value = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return {}
    if not isinstance(value, dict):
        return {}
    return {name: cleaned for name in FIELDS if (cleaned := _clean(name, value.get(name))) is not None}


def write_file(path: Path, values: dict[str, str]) -> None:
    """Replace the file atomically; the new file is user-only (0600) from its first byte."""
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, staging = tempfile.mkstemp(prefix="." + path.name, dir=path.parent)  # mkstemp creates 0600
    try:
        if hasattr(os, "fchmod"):
            os.fchmod(fd, 0o600)
        with os.fdopen(fd, "w", encoding="utf-8") as stream:
            json.dump({"version": 1, **values}, stream, ensure_ascii=False, indent=2)
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(staging, path)
        from .backup import _sync_directory
        _sync_directory(path.parent)
    finally:
        Path(staging).unlink(missing_ok=True)


@dataclass(frozen=True)
class LLMConfig:
    llm1_base_url: str
    llm1_model: str
    llm1_model_effort: str  # "" sends no effort
    llm1_api_key: str = field(repr=False)
    sources: dict[str, str] = field(default_factory=dict)  # UI name -> "env" | "file" | "default"


def current(settings=None) -> LLMConfig:
    """The values in use now: a non-empty environment value, else the saved file, else the default."""
    s = settings or get_settings()
    stored = read_file(file_path(s))
    values: dict[str, str] = {}
    sources: dict[str, str] = {}
    for name, attr in FIELDS.items():
        env = getattr(s, attr, "")
        if attr in s.model_fields_set and isinstance(env, str) and env.strip():
            values[name], sources[name] = env.strip(), "env"
        elif name in stored:
            values[name], sources[name] = stored[name], "file"
        else:
            values[name], sources[name] = Settings.model_fields[attr].default, "default"
    effort = "" if values["effort"] == NO_EFFORT else values["effort"]
    return LLMConfig(values["base_url"], values["model"], effort, values["api_key"], sources)


class LLMSettingsError(ValueError):
    """A Greek message that never contains the submitted values."""


def validate_patch(patch: dict) -> dict[str, str]:
    if not isinstance(patch, dict) or set(patch) - set(FIELDS):
        raise LLMSettingsError("Μη αναγνωρίσιμη ρύθμιση μοντέλου.")
    out: dict[str, str] = {}
    for name, value in patch.items():
        if not isinstance(value, str):
            raise LLMSettingsError("Μη έγκυρη τιμή ρύθμισης μοντέλου.")
        value = value.strip()
        if name == "base_url":
            parts = urlsplit(value)
            if (len(value) > _LIMITS[name] or _CONTROL.search(value) or parts.scheme not in {"http", "https"}
                    or not parts.hostname or parts.username or parts.password or parts.query or parts.fragment):
                raise LLMSettingsError("Η διεύθυνση πρέπει να είναι http:// ή https:// χωρίς κωδικό μέσα της, "
                                       "π.χ. https://api.openai.com/v1.")
        elif name == "model":
            if not value or _clean(name, value) is None:
                raise LLMSettingsError("Γράψε το όνομα του μοντέλου (έως 200 χαρακτήρες).")
        elif name == "effort":
            if value not in EFFORTS and value != NO_EFFORT:
                raise LLMSettingsError("Μη έγκυρο επίπεδο σκέψης.")
        elif name == "api_key":
            if _clean(name, value) is None:
                raise LLMSettingsError("Το κλειδί API δεν μπορεί να είναι κενό ή να έχει κενά και αλλαγές γραμμής "
                                       "(έως 4096 χαρακτήρες).")
        out[name] = value
    return out


def save(patch: dict, settings=None) -> None:
    """Merge validated values into the file."""
    values = validate_patch(patch)
    path = file_path(settings)
    with _lock:
        stored = read_file(path)
        stored.update(values)
        write_file(path, stored)


def delete_key(settings=None) -> None:
    path = file_path(settings)
    with _lock:
        stored = read_file(path)
        if "api_key" in stored or path.exists():
            stored.pop("api_key", None)
            write_file(path, stored)


def migrate_desktop_config(root: Path) -> bool:
    """Move LLM values out of `desktop-config.json` (top level, and the older `artist_enrichment`
    object; the top level won there) into the LLM file, then drop them from the config.

    Idempotent: a value already in the LLM file is never overwritten (only missing ones are
    filled in, so a key is never lost to a file saved earlier without one), and a config without
    LLM keys is left untouched. The file is written before the config, so a crash in between
    leaves the key in both and the next start finishes the move. Returns whether the config
    was rewritten."""
    from ..desktop_runtime.preferences import atomic_json

    config_path = root / "desktop-config.json"
    try:
        if not config_path.is_file() or config_path.stat().st_size > 512 * 1024:
            return False
        config = json.loads(config_path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return False
    if not isinstance(config, dict):
        return False
    nested = config.get("artist_enrichment")
    nested = nested if isinstance(nested, dict) else None
    attrs = set(FIELDS.values())
    if not (attrs & set(config) or (nested is not None and attrs & set(nested))):
        return False
    found: dict[str, str] = {}
    for source in ([nested] if nested is not None else []) + [config]:
        for name, attr in FIELDS.items():
            if (cleaned := _clean(name, source.get(attr))) is not None:
                found[name] = cleaned
    target = root / FILE_NAME
    with _lock:
        stored = read_file(target)
        if any(name not in stored for name in found):
            write_file(target, {**found, **stored})
    for attr in attrs:
        config.pop(attr, None)
        if nested is not None:
            nested.pop(attr, None)
    if nested is not None and not nested:
        config.pop("artist_enrichment")
    atomic_json(config_path, config)
    return True

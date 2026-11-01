"""Application configuration (local-first, env-driven)."""
from __future__ import annotations

import shutil
import os
from functools import lru_cache
from pathlib import Path

from pydantic_settings import BaseSettings, SettingsConfigDict

BACKEND_DIR = Path(__file__).resolve().parent.parent


class Settings(BaseSettings):
    model_config = SettingsConfigDict(
        # The un-prefixed flag survives subprocess CRATEMIND_* scrubbing; the
        # test suite sets it so no child process reads the developer's .env.
        env_file=None if os.environ.get("NO_CRATEMIND_ENV_FILE") else str(BACKEND_DIR / ".env"),
        env_prefix="CRATEMIND_",
        extra="ignore",
    )

    library_roots: str = ""
    scan_roots: list[str] = []
    dataset_root: str = ""
    path_mappings_file: str = ""
    output_dir: str = "./data/exports"
    db_path: str = "./data/cratemind.sqlite"
    backup_dir: str = "./data/backups"
    backup_keep: int = 3
    ffprobe_path: str = ""
    fpcalc_path: str = ""
    ffmpeg_path: str = ""
    llm1_base_url: str = ""
    llm1_api_key: str = ""
    llm1_model: str = ""
    llm1_model_effort: str = "high"
    artist_intelligence_batch_size: int = 25
    bpm_disagreement_percent: float = 3.0
    essentia_enabled: bool = False
    reccobeats_enabled: bool = True
    reccobeats_api_url: str = "https://api.reccobeats.com/v1/analysis/audio-features"
    reccobeats_timeout_seconds: float = 60.0
    reccobeats_clip_start_seconds: float = 60.0
    getsongbpm_enabled: bool = True
    getsongbpm_bulk_enabled: bool = False
    getsongbpm_api_url: str = "https://api.getsong.co"
    getsongbpm_api_key: str = ""
    getsongbpm_timeout_seconds: float = 30.0
    cyanite_enabled: bool = False
    cyanite_api_url: str = "https://api.cyanite.ai/graphql"
    cyanite_access_token: str = ""
    cyanite_timeout_seconds: float = 60.0
    cyanite_analysis_credit_limit: int = 5
    cors_origins: str = "http://localhost:5173"
    djay_library: str = ""
    djay_metadata: str = ""

    # ----- derived helpers -----

    def _resolve(self, p: str) -> Path:
        path = Path(p).expanduser()
        if not path.is_absolute():
            path = (BACKEND_DIR / path).resolve()
        return path

    @property
    def db_file(self) -> Path:
        return self._resolve(self.db_path)

    @property
    def backup_path(self) -> Path:
        return self._resolve(self.backup_dir)

    @property
    def output_path(self) -> Path:
        return self._resolve(self.output_dir)

    @property
    def roots(self) -> list[Path]:
        if self.dataset_root or self.path_mappings_file:
            from .services.library_paths import connected_library_roots, load_path_mappings, resolve_source_path
            if self.scan_roots:
                mappings = load_path_mappings(self)
                selected = []
                for logical in self.scan_roots:
                    try:
                        path = resolve_source_path(logical, mappings)
                        if path.is_dir() and path not in selected:
                            selected.append(path)
                    except OSError:
                        continue
                return selected
            return connected_library_roots(self)
        out: list[Path] = []
        for chunk in self.library_roots.split(","):
            chunk = chunk.strip()
            if chunk:
                out.append(Path(chunk).expanduser())
        return out

    @property
    def cors_list(self) -> list[str]:
        return [c.strip() for c in self.cors_origins.split(",") if c.strip()]

    @property
    def ffprobe(self) -> str | None:
        return self.ffprobe_path or shutil.which("ffprobe")

    @property
    def fpcalc(self) -> str | None:
        return self.fpcalc_path or shutil.which("fpcalc")

    @property
    def ffmpeg(self) -> str | None:
        return self.ffmpeg_path or shutil.which("ffmpeg")

    def ensure_dirs(self) -> None:
        self.db_file.parent.mkdir(parents=True, exist_ok=True)
        self.backup_path.mkdir(parents=True, exist_ok=True)
        self.output_path.mkdir(parents=True, exist_ok=True)


@lru_cache
def get_settings() -> Settings:
    from .runtime_profile import RuntimeProfile, get_runtime_profile
    from .services.active_dataset import resolve_active_dataset, reject_retired_source

    desktop = get_runtime_profile() is RuntimeProfile.DESKTOP_CORE
    settings = Settings(_env_file=None) if desktop else Settings()
    if settings.dataset_root:
        explicit = {key: os.environ[key] for key in (
            "CRATEMIND_DB_PATH", "CRATEMIND_IDENTITY_DB_PATH") if os.environ.get(key)}
        active = resolve_active_dataset(settings.dataset_root, explicit)
        settings.db_path = str(active.catalog_path)
        settings.backup_dir = str(active.dataset_root / "backups")
        settings.output_dir = str(active.exports_path)
    else:
        reject_retired_source(settings.db_file)
    return settings

"""Application configuration (local-first, env-driven)."""
from __future__ import annotations

import shutil
from functools import lru_cache
from pathlib import Path

from pydantic_settings import BaseSettings, SettingsConfigDict

BACKEND_DIR = Path(__file__).resolve().parent.parent


class Settings(BaseSettings):
    model_config = SettingsConfigDict(
        env_file=str(BACKEND_DIR / ".env"),
        env_prefix="CRATEMIND_",
        extra="ignore",
    )

    library_roots: str = ""
    output_dir: str = "./data/exports"
    db_path: str = "./data/cratemind.sqlite"
    backup_dir: str = "./data/backups"
    backup_keep: int = 10
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
    getsongbpm_api_url: str = "https://api.getsong.co"
    getsongbpm_api_key: str = ""
    getsongbpm_timeout_seconds: float = 30.0
    cyanite_enabled: bool = False
    cyanite_api_url: str = "https://api.cyanite.ai/graphql"
    cyanite_access_token: str = ""
    cyanite_timeout_seconds: float = 60.0
    cyanite_analysis_credit_limit: int = 5
    cors_origins: str = "http://localhost:5173"

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
    return Settings()

"""External BPM validators used only after local-engine disagreement."""
from __future__ import annotations

import http.client
import json
import math
import re
import secrets
import subprocess
import tempfile
from dataclasses import dataclass
from pathlib import Path
from urllib.error import HTTPError, URLError
from urllib.parse import urlencode, urlparse
from urllib.request import Request, urlopen


class BpmValidationError(RuntimeError):
    pass


@dataclass(frozen=True)
class ReccoBeatsResult:
    bpm: float


@dataclass(frozen=True)
class GetSongBpmResult:
    song_id: str
    bpm: float
    key: str | None = None


def _json_response(request: Request, timeout_seconds: float, provider: str) -> dict:
    try:
        with urlopen(request, timeout=timeout_seconds) as response:
            return json.loads(response.read().decode("utf-8"))
    except HTTPError as exc:
        detail = exc.read().decode("utf-8", errors="replace")[:500]
        raise BpmValidationError(f"{provider} HTTP {exc.code}: {detail}") from exc
    except (URLError, TimeoutError, json.JSONDecodeError) as exc:
        raise BpmValidationError(f"{provider} request failed: {exc}") from exc


class ReccoBeatsClient:
    def __init__(
        self,
        *,
        api_url: str,
        ffmpeg: str,
        timeout_seconds: float = 60.0,
        clip_start_seconds: float = 60.0,
    ) -> None:
        if urlparse(api_url).scheme != "https":
            raise BpmValidationError("ReccoBeats API URL must use HTTPS")
        self.api_url = api_url
        self.ffmpeg = ffmpeg
        self.timeout_seconds = max(1.0, timeout_seconds)
        self.clip_start_seconds = max(0.0, clip_start_seconds)

    def _temporary_clip(self, source: str, duration_seconds: float | None) -> Path:
        if duration_seconds is not None and duration_seconds > 0:
            centered_start = max(0.0, (duration_seconds - 30.0) / 2.0)
            start = min(self.clip_start_seconds, centered_start)
        else:
            start = self.clip_start_seconds

        handle = tempfile.NamedTemporaryFile(
            prefix="cratemind-reccobeats-",
            suffix=".mp3",
            delete=False,
        )
        handle.close()
        dest = Path(handle.name)
        cmd = [
            self.ffmpeg,
            "-y",
            "-v",
            "error",
            "-ss",
            f"{start:.3f}",
            "-i",
            source,
            "-t",
            "30",
            "-vn",
            "-ac",
            "2",
            "-ar",
            "44100",
            "-b:a",
            "128k",
            str(dest),
        ]
        proc = subprocess.run(cmd, capture_output=True, check=False)
        if proc.returncode != 0 or not dest.is_file() or dest.stat().st_size == 0:
            dest.unlink(missing_ok=True)
            detail = proc.stderr.decode("utf-8", errors="replace").strip()
            raise BpmValidationError(detail or "ffmpeg could not prepare ReccoBeats clip")
        if dest.stat().st_size > 5 * 1024 * 1024:
            dest.unlink(missing_ok=True)
            raise BpmValidationError("ReccoBeats clip exceeds 5 MB")
        return dest

    def analyze(self, source: str, duration_seconds: float | None = None) -> ReccoBeatsResult:
        clip = self._temporary_clip(source, duration_seconds)
        try:
            boundary = f"----CrateMind{secrets.token_hex(16)}"
            prefix = (
                f"--{boundary}\r\n"
                'Content-Disposition: form-data; name="audioFile"; '
                'filename="cratemind-validation.mp3"\r\n'
                "Content-Type: audio/mpeg\r\n\r\n"
            ).encode()
            suffix = f"\r\n--{boundary}--\r\n".encode()
            payload = prefix + clip.read_bytes() + suffix
            parsed = urlparse(self.api_url)
            if not parsed.hostname:
                raise BpmValidationError("ReccoBeats API URL has no host")
            target = parsed.path or "/"
            if parsed.query:
                target = f"{target}?{parsed.query}"
            connection = http.client.HTTPSConnection(
                parsed.hostname,
                port=parsed.port,
                timeout=self.timeout_seconds,
            )
            try:
                connection.request(
                    "POST",
                    target,
                    body=payload,
                    headers={
                        "Content-Type": f"multipart/form-data; boundary={boundary}",
                        "Content-Length": str(len(payload)),
                        "User-Agent": "CrateMind/0.1",
                    },
                )
                response = connection.getresponse()
                detail = response.read().decode("utf-8", errors="replace")
            except (OSError, TimeoutError, http.client.HTTPException) as exc:
                raise BpmValidationError(f"ReccoBeats request failed: {exc}") from exc
            finally:
                connection.close()
            if response.status >= 400:
                raise BpmValidationError(
                    f"ReccoBeats HTTP {response.status}: {detail[:500]}"
                )
            try:
                body = json.loads(detail)
            except json.JSONDecodeError as exc:
                raise BpmValidationError(
                    f"ReccoBeats returned invalid JSON: {detail[:500]}"
                ) from exc
        finally:
            clip.unlink(missing_ok=True)

        try:
            bpm = float(body["tempo"])
        except (KeyError, TypeError, ValueError) as exc:
            raise BpmValidationError("ReccoBeats returned no tempo") from exc
        if not math.isfinite(bpm) or bpm <= 0:
            raise BpmValidationError("ReccoBeats returned invalid tempo")
        return ReccoBeatsResult(bpm=round(bpm, 2))


def _normalized_name(value: str) -> str:
    return re.sub(r"[^\w]+", "", value.casefold(), flags=re.UNICODE)


def _artist_names(value: object) -> list[str]:
    rows = value if isinstance(value, list) else [value]
    names: list[str] = []
    for row in rows:
        if isinstance(row, dict) and isinstance(row.get("name"), str):
            names.append(row["name"])
    return names


class GetSongBpmClient:
    def __init__(
        self,
        *,
        api_url: str,
        api_key: str,
        timeout_seconds: float = 30.0,
    ) -> None:
        if not api_key:
            raise BpmValidationError("GetSongBPM API key is missing")
        if urlparse(api_url).scheme != "https":
            raise BpmValidationError("GetSongBPM API URL must use HTTPS")
        self.api_url = api_url.rstrip("/")
        self.api_key = api_key
        self.timeout_seconds = max(1.0, timeout_seconds)

    def lookup(self, *, artist: str, title: str) -> GetSongBpmResult:
        query = urlencode(
            {
                "type": "both",
                "lookup": f"song:{title} artist:{artist}",
                "limit": 10,
            }
        )
        request = Request(
            f"{self.api_url}/search/?{query}",
            headers={
                "X-API-KEY": self.api_key,
                "Accept": "application/json",
                "User-Agent": "CrateMind/0.1",
            },
        )
        body = _json_response(request, self.timeout_seconds, "GetSongBPM")
        rows = body.get("search")
        if not isinstance(rows, list):
            raise BpmValidationError("GetSongBPM returned no search results")

        wanted_title = _normalized_name(title)
        wanted_artist = _normalized_name(artist)
        for row in rows:
            if not isinstance(row, dict):
                continue
            row_title = row.get("title")
            if not isinstance(row_title, str) or _normalized_name(row_title) != wanted_title:
                continue
            artists = _artist_names(row.get("artist"))
            if not any(_normalized_name(name) == wanted_artist for name in artists):
                continue
            try:
                bpm = float(row["tempo"])
            except (KeyError, TypeError, ValueError):
                continue
            song_id = row.get("id")
            if not isinstance(song_id, str) or not math.isfinite(bpm) or bpm <= 0:
                continue
            key = row.get("key_of")
            return GetSongBpmResult(
                song_id=song_id,
                bpm=round(bpm, 2),
                key=key if isinstance(key, str) and key else None,
            )
        raise BpmValidationError("GetSongBPM found no exact artist/title match")

"""External BPM validators used only after local-engine disagreement."""
from __future__ import annotations

import http.client
import json
import logging
import math
import re
import secrets
import subprocess
import tempfile
from dataclasses import dataclass
from pathlib import Path
from urllib.error import HTTPError, URLError
from urllib.parse import quote, urlencode, urlparse
from urllib.request import Request, urlopen

logger = logging.getLogger(__name__)


class BpmValidationError(RuntimeError):
    pass


@dataclass(frozen=True)
class ReccoBeatsResult:
    bpm: float
    track_id: str | None = None
    key: str | None = None
    source: str = "upload"


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
        parsed = urlparse(api_url)
        if not parsed.netloc:
            raise BpmValidationError("ReccoBeats API URL has no host")
        self.api_base_url = f"{parsed.scheme}://{parsed.netloc}"
        self.api_url = (
            api_url
            if parsed.path and parsed.path != "/"
            else f"{self.api_base_url}/v1/analysis/audio-features"
        )
        self.ffmpeg = ffmpeg
        self.timeout_seconds = max(1.0, timeout_seconds)
        self.clip_start_seconds = max(0.0, clip_start_seconds)

    def lookup(
        self,
        *,
        artist: str,
        title: str,
        duration_seconds: float | None = None,
    ) -> ReccoBeatsResult:
        query = urlencode(
            {
                "searchText": f"{artist} {title}",
                "page": 0,
                "size": 20,
            }
        )
        request = Request(
            f"{self.api_base_url}/v1/track/search?{query}",
            headers={
                "Accept": "application/json",
                "User-Agent": "CrateMind/0.1",
            },
        )
        body = _json_response(request, self.timeout_seconds, "ReccoBeats")
        rows = body.get("content")
        if not isinstance(rows, list):
            raise BpmValidationError("ReccoBeats returned no search results")

        wanted_title = _normalized_name(title)
        wanted_artists = _normalized_artist_names(artist)
        matches: list[dict] = []
        for row in rows:
            if not isinstance(row, dict):
                continue
            row_title = row.get("trackTitle")
            if (
                not isinstance(row_title, str)
                or _normalized_name(row_title) != wanted_title
            ):
                continue
            row_artists: set[str] = set()
            for name in _artist_names(row.get("artists")):
                row_artists.update(_normalized_artist_names(name))
            if not wanted_artists or not wanted_artists.issubset(row_artists):
                continue
            matches.append(row)

        if duration_seconds is not None and duration_seconds > 0 and matches:
            tolerance = min(12.0, max(5.0, duration_seconds * 0.03))
            timed_matches = []
            for row in matches:
                duration_ms = row.get("durationMs")
                if isinstance(duration_ms, (int, float)) and duration_ms > 0:
                    delta = abs(float(duration_ms) / 1000.0 - duration_seconds)
                    timed_matches.append((delta, row))
            if timed_matches:
                matches = [
                    row for delta, row in timed_matches if delta <= tolerance
                ]

        if not matches:
            raise BpmValidationError(
                "ReccoBeats found no exact artist/title/duration match"
            )

        def match_rank(row: dict) -> tuple[float, float]:
            duration_ms = row.get("durationMs")
            delta = (
                abs(float(duration_ms) / 1000.0 - duration_seconds)
                if duration_seconds is not None
                and duration_seconds > 0
                and isinstance(duration_ms, (int, float))
                else float("inf")
            )
            popularity = row.get("popularity")
            return delta, -float(popularity) if isinstance(popularity, (int, float)) else 0.0

        selected = min(matches, key=match_rank)
        track_id = selected.get("id")
        if not isinstance(track_id, str) or not track_id:
            raise BpmValidationError("ReccoBeats matched track has no ID")

        feature_request = Request(
            f"{self.api_base_url}/v1/track/{quote(track_id, safe='')}/audio-features",
            headers={
                "Accept": "application/json",
                "User-Agent": "CrateMind/0.1",
            },
        )
        features = _json_response(
            feature_request,
            self.timeout_seconds,
            "ReccoBeats",
        )
        bpm = _validated_bpm(features, "ReccoBeats")
        return ReccoBeatsResult(
            bpm=bpm,
            track_id=track_id,
            key=_reccobeats_key(features.get("key"), features.get("mode")),
            source="catalog",
        )

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

        return ReccoBeatsResult(
            bpm=_validated_bpm(body, "ReccoBeats"),
            source="upload",
        )


def _normalized_name(value: str) -> str:
    return re.sub(r"[^\w]+", "", value.casefold(), flags=re.UNICODE)


def _normalized_artist_names(value: str) -> set[str]:
    parts = re.split(
        r"\s*(?:,|;|&|\+|/|\bx\b|\bfeat(?:uring)?\.?\b|\bft\.?\b)\s*",
        value,
        flags=re.IGNORECASE,
    )
    normalized = {_normalized_name(part) for part in parts if part.strip()}
    return {part for part in normalized if part}


def _artist_names(value: object) -> list[str]:
    rows = value if isinstance(value, list) else [value]
    names: list[str] = []
    for row in rows:
        if isinstance(row, dict) and isinstance(row.get("name"), str):
            names.append(row["name"])
    return names


def _validated_bpm(body: dict, provider: str) -> float:
    try:
        bpm = float(body["tempo"])
    except (KeyError, TypeError, ValueError) as exc:
        raise BpmValidationError(f"{provider} returned no tempo") from exc
    if not math.isfinite(bpm) or bpm <= 0:
        raise BpmValidationError(f"{provider} returned invalid tempo")
    return round(bpm, 2)


def _reccobeats_key(key: object, mode: object) -> str | None:
    pitches = ("C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B")
    try:
        pitch_index = int(key)
        mode_index = int(mode)
    except (TypeError, ValueError):
        return None
    if pitch_index not in range(12) or mode_index not in (0, 1):
        return None
    quality = "major" if mode_index == 1 else "minor"
    return f"{pitches[pitch_index]} {quality}"


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

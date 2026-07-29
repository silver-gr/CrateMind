"""Cyanite adapter for BPM disagreements.

Only callers decide which tracks may leave the machine. This module converts
one source file to a bounded temporary MP3, uploads it, creates a Cyanite
LibraryTrack, and reads asynchronous Audio Analysis V7 state.
"""
from __future__ import annotations

import json
import subprocess
import tempfile
from dataclasses import dataclass
from pathlib import Path
from urllib.error import HTTPError, URLError
from urllib.parse import urlparse
from urllib.request import Request, urlopen


class CyaniteError(RuntimeError):
    pass


@dataclass(frozen=True)
class CyaniteResult:
    track_id: str
    status: str
    bpm: float | None = None
    bpm_range_adjusted: float | None = None
    key: str | None = None
    error: str | None = None


_FILE_UPLOAD = """
mutation FileUploadRequestMutation {
  fileUploadRequest {
    id
    uploadUrl
  }
}
"""

_CREATE_TRACK = """
mutation LibraryTrackCreateMutation($input: LibraryTrackCreateInput!) {
  libraryTrackCreate(input: $input) {
    __typename
    ... on LibraryTrackCreateSuccess {
      createdLibraryTrack { id }
    }
    ... on LibraryTrackCreateError {
      code
      message
    }
  }
}
"""

_TRACK_STATUS = """
query LibraryTrackStatus($id: ID!) {
  libraryTrack(id: $id) {
    __typename
    ... on LibraryTrack {
      audioAnalysisV7 {
        __typename
        ... on AudioAnalysisV7Finished {
          result {
            bpm
            bpmRangeAdjusted
            key
          }
        }
        ... on AudioAnalysisV7Failed {
          error { message }
        }
        ... on AudioAnalysisV7NotAuthorized {
          message
        }
      }
    }
    ... on LibraryTrackNotFoundError {
      message
    }
  }
}
"""


class CyaniteClient:
    def __init__(
        self,
        *,
        access_token: str,
        api_url: str,
        ffmpeg: str,
        timeout_seconds: float = 60.0,
    ) -> None:
        if not access_token:
            raise CyaniteError("Cyanite access token is missing")
        if urlparse(api_url).scheme != "https":
            raise CyaniteError("Cyanite API URL must use HTTPS")
        self.access_token = access_token
        self.api_url = api_url
        self.ffmpeg = ffmpeg
        self.timeout_seconds = max(1.0, timeout_seconds)

    def _graphql(self, query: str, variables: dict | None = None) -> dict:
        payload = json.dumps({"query": query, "variables": variables or {}}).encode()
        request = Request(
            self.api_url,
            data=payload,
            headers={
                "Authorization": f"Bearer {self.access_token}",
                "Content-Type": "application/json",
            },
            method="POST",
        )
        try:
            with urlopen(request, timeout=self.timeout_seconds) as response:
                body = json.loads(response.read().decode("utf-8"))
        except HTTPError as exc:
            detail = exc.read().decode("utf-8", errors="replace")[:500]
            raise CyaniteError(f"Cyanite HTTP {exc.code}: {detail}") from exc
        except (URLError, TimeoutError, json.JSONDecodeError) as exc:
            raise CyaniteError(f"Cyanite request failed: {exc}") from exc
        if body.get("errors"):
            message = "; ".join(str(item.get("message", item)) for item in body["errors"])
            raise CyaniteError(message)
        data = body.get("data")
        if not isinstance(data, dict):
            raise CyaniteError("Cyanite returned no data")
        return data

    def _temporary_mp3(self, source: str) -> Path:
        handle = tempfile.NamedTemporaryFile(prefix="cratemind-cyanite-", suffix=".mp3", delete=False)
        handle.close()
        dest = Path(handle.name)
        cmd = [
            self.ffmpeg,
            "-y",
            "-v",
            "error",
            "-i",
            source,
            "-t",
            "899",
            "-vn",
            "-ac",
            "2",
            "-ar",
            "44100",
            "-b:a",
            "320k",
            str(dest),
        ]
        proc = subprocess.run(cmd, capture_output=True, check=False)
        if proc.returncode != 0 or not dest.is_file() or dest.stat().st_size == 0:
            dest.unlink(missing_ok=True)
            detail = proc.stderr.decode("utf-8", errors="replace").strip()
            raise CyaniteError(detail or "ffmpeg could not prepare Cyanite upload")
        return dest

    def _upload(self, upload_url: str, source: Path) -> None:
        if urlparse(upload_url).scheme != "https":
            raise CyaniteError("Cyanite upload URL must use HTTPS")
        payload = source.read_bytes()
        request = Request(
            upload_url,
            data=payload,
            headers={
                "Content-Type": "audio/mpeg",
                "Content-Length": str(len(payload)),
            },
            method="PUT",
        )
        try:
            with urlopen(request, timeout=self.timeout_seconds) as response:
                if response.status not in {200, 201, 204}:
                    raise CyaniteError(f"Cyanite upload returned HTTP {response.status}")
        except HTTPError as exc:
            raise CyaniteError(f"Cyanite upload returned HTTP {exc.code}") from exc
        except (URLError, TimeoutError) as exc:
            raise CyaniteError(f"Cyanite upload failed: {exc}") from exc

    def submit(self, *, source: str, title: str, external_id: str) -> CyaniteResult:
        upload = self._graphql(_FILE_UPLOAD)["fileUploadRequest"]
        upload_id = upload.get("id")
        upload_url = upload.get("uploadUrl")
        if not upload_id or not upload_url:
            raise CyaniteError("Cyanite returned an invalid upload request")

        prepared = self._temporary_mp3(source)
        try:
            self._upload(upload_url, prepared)
        finally:
            prepared.unlink(missing_ok=True)

        created = self._graphql(
            _CREATE_TRACK,
            {"input": {"uploadId": upload_id, "title": title, "externalId": external_id}},
        )["libraryTrackCreate"]
        if created.get("__typename") != "LibraryTrackCreateSuccess":
            raise CyaniteError(created.get("message") or created.get("code") or "track creation failed")
        track_id = created["createdLibraryTrack"]["id"]
        return self.fetch(track_id)

    def fetch(self, track_id: str) -> CyaniteResult:
        track = self._graphql(_TRACK_STATUS, {"id": track_id})["libraryTrack"]
        if track.get("__typename") != "LibraryTrack":
            return CyaniteResult(
                track_id=track_id,
                status="failed",
                error=track.get("message") or "Cyanite track not found",
            )
        analysis = track["audioAnalysisV7"]
        kind = analysis.get("__typename", "")
        status = {
            "AudioAnalysisV7NotStarted": "not_started",
            "AudioAnalysisV7Enqueued": "enqueued",
            "AudioAnalysisV7Processing": "processing",
            "AudioAnalysisV7Finished": "finished",
            "AudioAnalysisV7Failed": "failed",
            "AudioAnalysisV7NotAuthorized": "not_authorized",
        }.get(kind, "unknown")
        if status == "finished":
            result = analysis["result"]
            return CyaniteResult(
                track_id=track_id,
                status=status,
                bpm=result.get("bpm"),
                bpm_range_adjusted=result.get("bpmRangeAdjusted"),
                key=result.get("key"),
            )
        error = None
        if status == "failed":
            error = (analysis.get("error") or {}).get("message") or "Cyanite analysis failed"
        elif status == "not_authorized":
            error = analysis.get("message") or "Cyanite analysis not authorized"
        return CyaniteResult(track_id=track_id, status=status, error=error)

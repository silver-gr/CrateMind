"""«Καθαρά ονόματα»: what the app shows and tells about it (stage 1). Reads `track_names`; never imports the
engine and never writes a name.

The show lane fills this in: the overlay step (`apply`, called from canonical_library.overlay), the search side
(`reindex_changed`, the `names:` tokens in services/search.py), and the three payloads of api/names_status.py.
Contract: .omc/research/name-cleaning-2026-11-27/integration/CONTRACT.md.
"""
from __future__ import annotations

from sqlmodel import Session

UNKNOWN_ARTIST = "Άγνωστος καλλιτέχνης"  # shown for status `none`, whose stored artist is ''


class SwitchRefused(Exception):
    """The switch may not be turned on yet. `args[0]` is the Greek reason shown to the owner."""


def apply(rows: list[dict], session: Session | None) -> list[dict]:
    """The overlay's last step, on every exit of `canonical_library.overlay`. With the switch on and a
    `track_names` row for the track: replace `artist` and `title`, add `names_status` and `names_off`
    ({"artist", "title"}: the values replaced). With the switch off, or no row: the row is returned exactly as
    it came. BPM fields, `original_*` and `metadata_provenance` are never touched."""
    raise NotImplementedError("show lane")


def reindex_changed(session: Session, track_ids: list[int] | None = None, *, commit: bool = True) -> int:
    """Reindex the FTS rows whose shown name differs from the stored one (all of them when `track_ids` is None:
    a switch turn). Returns the number of rows reindexed. Called by the switch route and by a run."""
    raise NotImplementedError("show lane")


def status(session: Session) -> dict:
    """The payload of GET /api/names/status (api/names_status.py `NamesStatus`)."""
    raise NotImplementedError("show lane")


def set_switch(session: Session, on: bool) -> dict:
    """Turn the switch (names_switch.set_on), reindex the rows whose shown name differs and, when turning on,
    ask for a run (names_store.request_run("switch", force=True)). Raises SwitchRefused while a present track
    has `raw_state` NULL. Returns `status(session)`."""
    raise NotImplementedError("show lane")


def why(session: Session, track_id: int) -> dict | None:
    """The payload of GET /api/names/tracks/{id} (api/names_status.py `NameWhy`); None for an unknown track."""
    raise NotImplementedError("show lane")

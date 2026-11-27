"""The inputs and outputs of resolve(). Plain frozen data: no I/O, no database rows."""
from __future__ import annotations

from dataclasses import dataclass, field


@dataclass(frozen=True)
class Link:
    """A linked remote record of the track's recording. `artists` is Spotify's artist array, or the SoundCloud
    publisher (one entry) when there is one; `uploader` is the SoundCloud account."""
    service: str
    artists: tuple[str, ...] = ()
    title: str = ""
    uploader: str = ""


@dataclass(frozen=True)
class TrackInput:
    id: int
    artist: str = ""
    title: str = ""
    album: str = ""
    track_no: str = ""
    file_name: str = ""
    folder: str = ""  # the containing folder, relative to the music root, "/"-separated
    bpm_grid: float | None = None
    bpm_analyzed: float | None = None
    links: tuple[Link, ...] = ()


@dataclass(frozen=True)
class References:
    """Library-wide remote evidence: every Spotify artist entry and SoundCloud publisher (not uploader) spelling with
    its count, every SoundCloud uploader with the act keys it posted, and remote title keys with their counts."""
    spotify: tuple[tuple[str, int], ...] = ()
    sc_publisher: tuple[tuple[str, int], ...] = ()
    titles: tuple[tuple[str, int], ...] = ()


@dataclass(frozen=True)
class Decision:
    """One owner (or seeded) decision. kind: spelling, track, same_act, one_act, not_act, bracket_word,
    album_credit, facts, preference. `value` is the answer as text (a spelling, «Artist | Title», «yes»/«no», …)."""
    kind: str
    scope: str
    value: str
    source: str = "owner"


@dataclass(frozen=True)
class Act:
    name: str
    key: str
    role: str  # primary | collaborator | featured | remixer | original | member


@dataclass(frozen=True)
class Step:
    rule: str
    field: str
    before: str = ""
    after: str = ""
    evidence: str = ""


@dataclass
class TrackResult:
    id: int
    artist: str
    title: str
    acts: tuple[Act, ...] = ()
    album_credit: str = ""
    folder: str = ""
    tempo_hint: str = ""
    notes: dict = field(default_factory=dict)
    status: str = "sure"  # sure | look | open | none | hand
    open_code: str = ""
    trail: tuple[Step, ...] = ()
    reason: str = ""
    rules: tuple[str, ...] = ()


@dataclass
class Resolution:
    ruleset: str
    tracks: dict[int, TrackResult]
    acts: list[dict]
    albums: list[dict]
    open_items: list[dict]
    look_items: list[dict]

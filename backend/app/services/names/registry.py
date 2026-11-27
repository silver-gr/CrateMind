"""Layer 3: the library-wide registry of acts, titles and channels, built once from phase P0 (never from decided
output). Leave-self-out: a track's own tags, its own linked records and its album-mates never count as evidence
for its own structural decision."""
from __future__ import annotations

import re
from collections import Counter, defaultdict
from dataclasses import dataclass, field

from .fields import PLACEHOLDER_RE
from .text import fold

SUBTITLE_RE = re.compile(r"(?i)^(?:part|pt\.?|chapter|act|movement|vol\.?|volume|ep|lp|intro|outro|cd|disc|side)\b")
LABEL_NAME_RE = re.compile(r"(?i)\b(?:records?|recordings|recs)\.?$|\bofficial$|\bmusic$")


def usable_key(name: str) -> str:
    """The act key of a name that can be an act: not a placeholder, not a bare number, at least 2 characters."""
    if not name or PLACEHOLDER_RE.match(name) or re.fullmatch(r"\s*\d+\s*", name):
        return ""
    k = fold(name)
    return k if len(k) >= 2 else ""


@dataclass
class Registry:
    local: dict[str, dict[int, str]] = field(default_factory=lambda: defaultdict(dict))  # key -> {track: group}
    spotify: Counter = field(default_factory=Counter)
    spotify_whole: set[str] = field(default_factory=set)  # keys of whole Spotify artist entries (one act, N25)
    sc_publisher: Counter = field(default_factory=Counter)
    titles: Counter = field(default_factory=Counter)
    local_titles: dict[str, set[int]] = field(default_factory=lambda: defaultdict(set))
    decided_acts: set[str] = field(default_factory=set)
    one_act_keys: set[str] = field(default_factory=set)
    not_act_keys: set[str] = field(default_factory=set)
    channels: dict[str, str] = field(default_factory=dict)  # key -> why (fronts | decision)
    uploader_channels: set[str] = field(default_factory=set)  # accounts that post 5+ other known acts
    own_links: dict[int, tuple[Counter, Counter, set[str]]] = field(default_factory=dict)
    solo: dict[str, set[int]] = field(default_factory=lambda: defaultdict(set))  # key -> tracks crediting it alone
    spotify_bare: Counter = field(default_factory=Counter)  # Spotify entries with a qualifier left out («Macedo (BR)»)

    # ---------------------------------------------------------------- acts
    def add_local(self, name: str, track_id: int, group: str) -> None:
        k = usable_key(name)
        if k:
            self.local[k][track_id] = group

    def local_count(self, key: str, track_id: int | None = None, group: str = "") -> int:
        return sum(1 for t, g in self.local.get(key, {}).items() if t != track_id and (not group or g != group))

    def remote_count(self, key: str, track_id: int | None = None) -> int:
        """Spotify artist entries and SoundCloud publishers with this key. A track's own linked records count: they
        are not its tags (leave-self-out is about the tags; titles leave the own records out, see known_title)."""
        return self.spotify.get(key, 0) + self.sc_publisher.get(key, 0) + self.spotify_bare.get(key, 0)

    def solo_count(self, key: str, track_id: int | None = None) -> int:
        return len(self.solo.get(key, set()) - {track_id})

    def known_key(self, key: str) -> bool:
        """Known anywhere (no leave-self-out): used only to count what an uploader posts."""
        return bool(key) and (key in self.decided_acts or self.spotify.get(key, 0) > 0
                              or self.sc_publisher.get(key, 0) > 0 or len(self.local.get(key, {})) >= 2)

    def known(self, name: str, track_id: int | None = None, group: str = "") -> bool:
        k = usable_key(name)
        if not k or k in self.not_act_keys or k in self.channels:
            return False
        if k in self.decided_acts:
            return True
        return self.remote_count(k, track_id) >= 1 or self.local_count(k, track_id, group) >= 1

    @staticmethod
    def bare(key_or_name: str) -> str:
        """An act key with a trailing qualifier («Neutralizer (A)») or «and Friends» left out."""
        v = re.sub(r"\s*[(\[][A-Z]{1,3}[)\]]\s*$", "", key_or_name)
        v = re.sub(r"(?i)\s*(?:and|&)\s+friends\s*$", "", v)
        return fold(v)

    def strong(self, name: str, track_id: int | None = None, group: str = "") -> bool:
        k = usable_key(name)
        if not k or k in self.not_act_keys or k in self.channels:
            return False
        if k in self.decided_acts:
            return True
        return self.spotify.get(k, 0) >= 1 or self.local_count(k, track_id, group) >= 2

    def one_act(self, name: str) -> bool:
        k = fold(name)
        return bool(k) and (k in self.one_act_keys or k in self.spotify_whole)

    # ---------------------------------------------------------------- titles (R2)
    def known_title(self, text: str, track_id: int | None = None) -> bool:
        k = fold(text)
        if len(k) < 4:
            return False
        own = self.own_links.get(track_id, (Counter(), Counter(), set()))[2] if track_id is not None else set()
        remote = self.titles.get(k, 0) - (1 if k in own else 0)
        local = len(self.local_titles.get(k, set()) - {track_id})
        return remote + local >= 1

    def channel(self, name: str) -> str:
        """R3: why a name is a label, an uploader account or a channel ('' when it is none of them)."""
        k = fold(name)
        if not k:
            return ""
        if k in self.channels:
            return self.channels[k]
        from .lexer import split_credit
        acts = split_credit(name).acts
        if acts and all(LABEL_NAME_RE.search(a.strip()) for a in acts):
            return "label"
        return ""

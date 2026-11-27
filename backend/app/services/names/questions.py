"""The pattern questions («Ερωτήσεις προτιμήσεων») of one resolution: pure, like the rest of the engine.

Stage 2 of plan 2026-11-27-name-cleaning-integration moves their Greek texts and options here; the names job
stores what this returns in its run record, and the decisions service lists it."""
from __future__ import annotations


def pattern_questions(resolution, inputs, decisions) -> list[dict]:
    """One dict per pattern question that still matters for this library:
    {"kind": "preference", "scope": "pref:…", "question": Greek, "options": ["A=…", "B=…"],
     "recommended": letter or "", "why": Greek, "tracks": [track ids it settles]}.
    An answered question is listed too (the caller marks it from the active decisions)."""
    return []

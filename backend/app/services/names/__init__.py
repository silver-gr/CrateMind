"""«Καθαρισμός ονομάτων»: one deterministic system for artist and title names (plan 2026-11-27-name-cleaning).

Stage 1: the engine only. Nothing in the app imports this package yet (pinned by a test); it does no file I/O
(pinned by an AST test) and never writes a tag.
"""
from .model import Act, Decision, Link, References, Resolution, Step, TrackInput, TrackResult
from .resolve import UNKNOWN_ARTIST, resolve
from .ruleset import KEY_VERSION, RULESET, digest

__all__ = ["Act", "Decision", "Link", "References", "Resolution", "Step", "TrackInput", "TrackResult",
           "UNKNOWN_ARTIST", "resolve", "RULESET", "KEY_VERSION", "digest"]

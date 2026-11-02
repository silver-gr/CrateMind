"""Suggested vocabularies. A starting point only; everything stays editable.

THERAPY_PRESET transcribes the draft table of the music-therapy spec
(docs/superpowers/specs/2026-11-02-music-therapy-design.md) verbatim.
"""
from __future__ import annotations

THERAPY_PRESET: list[dict] = [
    {"key": "purpose", "label": "Θεραπευτικός στόχος", "multi": True, "values": [
        "χαλάρωση", "ενεργοποίηση", "γείωση", "συναισθηματική έκφραση", "αναπόληση",
        "κίνηση", "συγκέντρωση", "ύπνος", "κοινωνική σύνδεση",
    ]},
    {"key": "mood", "label": "Διάθεση", "multi": True, "values": [
        "γαλήνια", "χαρούμενη", "τρυφερή", "νοσταλγική", "μελαγχολική", "ενθουσιώδης",
        "μεγαλειώδης", "ανήσυχη",
    ]},
    {"key": "voice", "label": "Φωνή", "multi": False, "values": [
        "οργανικό", "φωνή χωρίς λόγια", "με στίχους",
    ]},
    {"key": "lyrics", "label": "Γλώσσα στίχων", "multi": True, "values": [
        "ελληνικά", "αγγλικά", "άλλη",
    ]},
    {"key": "instruments", "label": "Όργανα", "multi": True, "values": [
        "πιάνο", "έγχορδα", "κιθάρα", "πνευστά", "κρουστά", "ηλεκτρονικοί ήχοι", "ήχοι φύσης",
        "φωνή/χορωδία",
    ]},
    {"key": "phase", "label": "Φάση συνεδρίας", "multi": True, "values": [
        "έναρξη", "ζέσταμα", "κύριο μέρος", "κλείσιμο",
    ]},
    {"key": "ages", "label": "Ηλικιακή ομάδα", "multi": True, "values": [
        "παιδιά", "έφηβοι", "ενήλικες", "τρίτη ηλικία",
    ]},
    {"key": "tradition", "label": "Μουσική παράδοση", "multi": True, "values": [
        "ελληνική παραδοσιακή", "έντεχνη", "κλασική", "τζαζ", "world", "ποπ/ροκ", "ηλεκτρονική",
        "ambient",
    ]},
]

PRESETS: dict[str, list[dict]] = {"therapy": THERAPY_PRESET}

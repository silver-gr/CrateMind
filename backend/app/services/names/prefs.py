"""names-7: the owner's answers to the pattern questions of owner-decisions.csv, read from decisions of kind
«preference» (scope «pref:…» or «status:…»; the value is the option letter). The engine acts only on the answers
listed in ACTS_ON: any other answer, or none, leaves the engine's default and the question open. A user who has
answered nothing gets the defaults; which answers a user gave is data the caller passes in, never a list here."""
from __future__ import annotations

# scope -> the answers the engine acts on. «A» is the engine's default reading of each question (answering it only
# settles the question); a «B» listed here changes what the engine shows.
ACTS_ON: dict[str, str] = {
    "status:none": "A",                     # no artist anywhere: «Unknown Artist»
    "pref:lookalike_letters": "A",          # plain letters when a source writes it so, else as written
    "pref:file_credit_over_spotify": "A",   # the file's credit wins over Spotify's extra collaborator
    "pref:whole_credit_folder": "A",        # a pair with no solo evidence: the folder holds the whole pair
    "pref:short_part_capitals": "AB",       # B: capitals in a 1-2 letter part stay as written («VelX»)
    "pref:approved_folder_casing": "B",     # B: the library's most common spelling (the default)
    "pref:alternating_case": "AB",          # B: alternating and other irregular capitals as written («ZaVo»)
    "pref:stylised_capitals": "A",          # A: stylised CamelCase as written («ZinkOphObo»)
    "pref:year_at_title_end": "A",          # A: a year at the end stays in the title
    "pref:release_note_bracket": "A",       # A: the start is the title, the artist the SoundCloud account
    "pref:tag_vs_head": "AB",               # A: the title's artist; B: the tag's
    "pref:remix_only_title": "A",           # A: «X Remix» with X known: X is the artist
    "pref:y_only_capitals": "AB",           # B: a one-word capital name whose only vowel is Y keeps them
}


def answer(decisions: dict, scope: str) -> str:
    """The answer letter the engine acts on for one pattern question, or '' (unanswered, or an answer it does not act
    on). `decisions` is the (kind, scope) -> Decision index of resolve()."""
    d = decisions.get(("preference", scope))
    v = d.value.strip().upper() if d is not None else ""
    return v if len(v) == 1 and v in ACTS_ON.get(scope, "") else ""


__all__ = ["ACTS_ON", "answer"]

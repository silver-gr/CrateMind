"""The pattern questions («Ερωτήσεις προτιμήσεων») of one resolution: pure, like the rest of the engine.

Stage 2 of plan 2026-11-27-name-cleaning-integration moved them here from the preview's
decisions_and_folders.py `pattern_rows`; the names job stores what this returns in its run record, and the
decisions service lists it. One answer settles every track of the shape. The question texts are generic; the
examples in `why` come from the library itself. Two preview rows are left out: the approved-folder casing (it
read the owner's research sheet, which the app does not have; the engine's default is that row's answer) and
one channel's name (a single library's fact, kept as the owner's `not_act` row). The preview's single row for
similar names is asked per pair here, as the preview's sheet asked it."""
from __future__ import annotations

import re

from . import spelling as SP
from . import text as T
from .resolve import index_decisions

KEEP = "A=ναι, όπως τώρα"


def _examples(items, n: int = 8) -> str:
    items = [x for x in items if x]
    return ("· π.χ. " + ", ".join(items[:n])) if items else ""


def pattern_questions(resolution, inputs, decisions) -> list[dict]:
    """One dict per pattern question that still matters for this library:
    {"kind": "preference" | "not_act" | "same_act", "scope": "pref:…", "question": Greek,
     "options": ["A=…", "B=…"], "recommended": letter, "why": Greek, "tracks": [track ids it settles]}.
    An answered question is listed too, even when no track of its shape is left (the caller marks it from the
    active decisions), so an answer can be read and given again. `decisions` is the list passed to resolve()
    or its (kind, scope) index. Most tracks first."""
    D = decisions if isinstance(decisions, dict) else index_decisions(decisions or ())
    tr = resolution.tracks
    out: list[dict] = []

    def with_rule(rule: str) -> list[int]:
        return sorted(t for t, r in tr.items() if rule in r.rules)

    def pattern(kind, scope, question, options, why, ids):
        ids = sorted(set(ids))
        if ids or (kind, scope) in D:
            out.append({"kind": kind, "scope": scope, "question": question, "options": list(options),
                        "recommended": "A", "why": why, "tracks": ids})

    def with_acts(keys) -> list[int]:
        return [t for t, r in tr.items() if any(x.key in keys for x in r.acts)]

    heads = with_rule("A1h")
    pattern("preference", "pref:tag_vs_head",
            "Το tag γράφει έναν γνωστό καλλιτέχνη και ο τίτλος ξεκινά με άλλον γνωστό καλλιτέχνη: ποιος είναι ο "
            "καλλιτέχνης;",
            ["A=το όνομα στην αρχή του τίτλου (το tag μένει στις σημειώσεις)", "B=το όνομα του tag"],
            "Το όνομα στον τίτλο είναι συνήθως πιο ακριβές από τον λογαριασμό που ανέβασε το κομμάτι"
            + _examples([f"{tr[t].notes.get('tag_artist')} → {tr[t].artist}" for t in heads], 4), heads)
    short = sorted({s.before for t in with_rule("N2c") for s in tr[t].trail if s.rule == "N2c"})
    pattern("preference", "pref:short_part_capitals",
            "Ονόματα με κεφαλαία σε τμήμα ενός ή δύο γραμμάτων: κεφαλαίο μόνο το πρώτο γράμμα;",
            ["A=ναι, κεφαλαίο μόνο το πρώτο γράμμα, όπως τώρα", "B=όπως γράφονται"],
            "Δείχνονται τώρα με κεφαλαίο μόνο το πρώτο γράμμα" + _examples(short, 12), with_rule("N2c"))
    pattern("preference", "pref:whole_credit_folder",
            "Σύμπραξη 2-3 ονομάτων που κανένα δεν είναι γνωστό μόνο του και καμία εγγραφή δεν τη γράφει ως ένα "
            "όνομα: φάκελος με όλη τη σύμπραξη ή ο φάκελος του πρώτου;",
            ["A=όλη η σύμπραξη, όπως τώρα", "B=ο πρώτος καλλιτέχνης"],
            "Καμία πηγή δεν λέει αν το όνομα είναι ένας καλλιτέχνης ή δύο", with_rule("N25q"))
    pattern("preference", "pref:year_at_title_end",
            "Τίτλοι που τελειώνουν σε χρονιά: η χρονιά είναι μέρος του τίτλου;",
            ["A=ναι, μένει στον τίτλο, όπως τώρα", "B=όχι, βγαίνει στις σημειώσεις"],
            "Τίποτα δεν αφαιρείται από τον τίτλο πριν απαντήσεις", with_rule("D3y"))
    pattern("preference", "pref:remix_only_title",
            "Ο τίτλος ήταν μόνο «X Remix» ή «produced by X» και ο X γνωστός καλλιτέχνης: ο X είναι ο καλλιτέχνης "
            "και το πεδίο καλλιτέχνη ο τίτλος;",
            [KEEP, "B=όχι: το πεδίο είναι ο αρχικός καλλιτέχνης και ο τίτλος λείπει (Για απόφαση)"],
            "Ένα όνομα με τρία κεφαλαία μπορεί να είναι κι αυτό καλλιτέχνης", with_rule("N21t"))
    pattern("preference", "status:none",
            "Κομμάτια χωρίς καλλιτέχνη σε καμία πηγή: μένουν «Άγνωστος καλλιτέχνης» (φάκελος «Unknown Artist»);",
            ["A=ναι, μένουν", "B=θα δώσω ονόματα ένα-ένα"],
            "Κάθε κομμάτι μπορεί να πάρει όνομα αργότερα με «Διόρθωση»",
            [t for t, r in tr.items() if r.status == "none"])
    pattern("preference", "pref:file_credit_over_spotify",
            "Όταν το Spotify γράφει κι άλλον συνεργάτη: κρατάμε ό,τι γράφει το αρχείο;",
            ["A=ναι", "B=προστίθεται ο συνεργάτης του Spotify"],
            "Το Spotify γράφει συχνά και όσους έκαναν remix ή τη δισκογραφική", with_rule("N23diff"))
    alt = []
    for a in resolution.acts:
        for part in a["local"].split(" ; "):
            sp = part.rsplit(" ×", 1)[0]
            if any(SP.CAMEL_RE.match(w) and not SP.camel(w) for w in sp.split(" ")):
                alt.append((a, sp))
                break
    pattern("preference", "pref:alternating_case",
            "Ονόματα με εναλλάξ κεφαλαία ανά δύο γράμματα: κεφαλαίο μόνο το πρώτο γράμμα;",
            ["A=ναι, κεφαλαίο μόνο το πρώτο γράμμα", "B=όπως γράφονται"],
            "Ο κανόνας του πρώτου κεφαλαίου" + _examples(sorted({sp for _, sp in alt}), 12),
            with_acts({a["key"] for a, _ in alt}))
    pattern("preference", "pref:stylised_capitals",
            "Ονόματα με κεφαλαία μέσα στη λέξη που καμία δεύτερη πηγή δεν γράφει έτσι: όπως γράφονται;",
            ["A=όπως γράφονται", "B=κεφαλαίο μόνο το πρώτο γράμμα"],
            "Ένα όνομα από ενωμένες λέξεις μπορεί να γράφεται έτσι επίτηδες"
            + _examples(sorted({a["spelling"] for a in resolution.acts if a["doubt"] == "U5s"}), 12),
            with_rule("N2s"))
    look_chars = set(SP.LOOKALIKE_CHARS)
    la = [a for a in resolution.acts
          if any(c in look_chars for c in a["local"] + a.get("spotify", "") + a["spelling"])]
    pattern("preference", "pref:lookalike_letters",
            "Ονόματα γραμμένα με Ø, Δ, Λ ή γράμματα άλλου αλφαβήτου: με απλά γράμματα όταν μια πηγή τα γράφει "
            "έτσι, αλλιώς όπως γράφονται;",
            ["A=ναι, όπως τώρα", "B=πάντα όπως τα γράφει ο καλλιτέχνης"],
            "Μένουν όπως γράφονται μόνο όταν καμία πηγή δεν τα γράφει με απλά γράμματα"
            + _examples(sorted(a["spelling"] for a in la), 14), with_acts({a["key"] for a in la}))
    yonly = [a for a in resolution.acts
             if re.fullmatch(r"[^\W\d_AEIOUaeiou]{4,}", a["spelling"]) and "y" in a["spelling"].lower()
             and any(re.fullmatch(r"[A-Z]{4,}", p.rsplit(" ×", 1)[0]) for p in a["local"].split(" ; "))]
    pattern("preference", "pref:y_only_capitals",
            "Μονολεκτικά ονόματα με κεφαλαία και μόνο φωνήεν το Y: κεφαλαίο μόνο το πρώτο γράμμα;",
            ["A=ναι, κεφαλαίο μόνο το πρώτο γράμμα", "B=μένουν κεφαλαία"],
            "Το Y μετρά ως φωνήεν" + _examples([a["spelling"] for a in yonly], 12),
            with_acts({a["key"] for a in yonly}))
    pattern("preference", "pref:project_bracket",
            "Σύμπραξη με όνομα σε παρένθεση («A & B (Όνομα)»): ποιος είναι ο καλλιτέχνης;",
            ["A=το όνομα της παρένθεσης (project· τα ονόματα στα μέλη)",
             "B=η σύμπραξη (η παρένθεση στις σημειώσεις)"],
            "Το όνομα της παρένθεσης δείχνεται τώρα ως ο καλλιτέχνης", with_rule("N8p"))
    music = sorted(t.id for t in inputs if t.id in tr and re.search(r"(?i)\bmusic\s*$", T.chars(t.artist)) and (
        tr[t.id].status in ("open", "none") or {"4b.uploader", "N23", "N23sc"} & set(tr[t.id].rules)))
    pattern("not_act", "name:*music",
            "Ονόματα που τελειώνουν σε «Music»: δισκογραφική ή καλλιτέχνης;",
            ["A=δισκογραφική, όπως τώρα", "B=καλλιτέχνης"],
            "Η βιβλιοθήκη τα δείχνει σήμερα ως δισκογραφικές", music)
    n20 = sorted(t for t, r in tr.items() if any(s.rule == "N20" and s.field == "pair" for s in r.trail)
                 and r.status in ("look", "none"))
    pattern("preference", "pref:release_note_bracket",
            "Παρένθεση που άνοιξε στον καλλιτέχνη και έκλεισε στον τίτλο με σημείωση έκδοσης (VA, Vol, Records, "
            "αριθμός): η αρχή είναι ο τίτλος και καλλιτέχνης ο λογαριασμός SoundCloud;",
            ["A=ναι", "B=μένουν για απόφαση"], "Το tag κόπηκε στη μέση της παρένθεσης", n20)
    pattern("preference", "pref:album_title_heads",
            "Άλμπουμ με τον ίδιο «καλλιτέχνη» σε όλα τα κομμάτια και άλλον καλλιτέχνη στην αρχή κάθε τίτλου: "
            "καλλιτέχνης είναι αυτός του τίτλου;",
            ["A=ναι, όπως τώρα (το όνομα του tag είναι ο λογαριασμός ή η δισκογραφική)", "B=όχι, το όνομα του tag"],
            "Το όνομα στον τίτλο είναι συνήθως πιο ακριβές από τον λογαριασμό που ανέβασε το άλμπουμ",
            with_rule("S1"))
    pattern("preference", "pref:uploader_as_artist",
            "Το πεδίο καλλιτέχνη είναι άδειο ή γενικό (αριθμός, VA) και δείχνεται ο λογαριασμός SoundCloud που "
            "ανέβασε το κομμάτι: σωστό;",
            [KEEP, "B=όχι, χωρίς καλλιτέχνη μέχρι να δώσω όνομα"],
            "Ο λογαριασμός είναι η μόνη πηγή που δίνει όνομα", with_rule("4b.uploader"))
    pattern("preference", "pref:soundcloud_publisher",
            "Ο καλλιτέχνης βρέθηκε στον εκδότη της συνδεδεμένης εγγραφής SoundCloud (το πεδίο είχε δισκογραφική ή "
            "τίποτα): σωστό;", [KEEP, "B=όχι, το πεδίο του αρχείου"],
            "Ο εκδότης δεν είναι ο λογαριασμός που ανέβασε το κομμάτι", with_rule("N23sc"))
    gen = sorted({t for t, r in tr.items() for s in r.trail if s.rule in ("C3", "C4") and s.field == "artist"})
    pattern("preference", "pref:spelling_without_library_vote",
            "Ονόματα που η βιβλιοθήκη δεν γράφει πουθενά «καθαρά» (μόνο κεφαλαία ή μόνο μικρά): γράφονται όπως στο "
            "Spotify ή στο SoundCloud, αλλιώς με κεφαλαίο το πρώτο γράμμα;", [KEEP, "B=όπως γράφονται στο αρχείο"],
            "Ο κανόνας του πρώτου κεφαλαίου" + _examples(sorted(
                {a["spelling"] for a in resolution.acts if a["rule"] in ("C3", "C4") and not a["doubt"]}), 12), gen)
    pattern("preference", "pref:names_in_title_brackets",
            "Ονόματα καλλιτεχνών μέσα στην παρένθεση του remix παίρνουν τη γραφή του καλλιτέχνη: ναι;",
            [KEEP, "B=όπως γράφονται στον τίτλο"], "Κάθε καλλιτέχνης γράφεται παντού με τον ίδιο τρόπο",
            with_rule("N28"))
    pattern("preference", "pref:credit_text_from_title",
            "Κείμενο που βγήκε από τον τίτλο και ίσως είναι όνομα (mastering, κανάλι, δισκογραφική): κρατιέται στα "
            "στοιχεία του κομματιού;", ["A=ναι, στα στοιχεία, όπως τώρα", "B=μένει στον τίτλο"],
            "Τίποτα που βγαίνει από έναν τίτλο δεν χάνεται", with_rule("D3c"))

    # one question per pair of similar names (N19s), and every answered pair, so it can be given again
    spelling = {a["key"]: a["spelling"] for a in resolution.acts}
    pairs: dict[str, list] = {}
    for t in sorted(tr):
        for s in tr[t].trail:
            if s.rule == "N19s":
                a, _, b = s.evidence.partition(" ~ ")
                pairs.setdefault(f"pair:{T.fold(a)}|{T.fold(b)}", [a, b, []])[2].append(t)
    for kind, scope in sorted(D):
        if kind == "same_act" and scope.startswith("pair:") and "|" in scope and scope not in pairs:
            x, _, y = scope[5:].partition("|")
            pairs[scope] = [spelling.get(x, x), spelling.get(y, y), with_acts({x, y})]
    for scope in sorted(pairs):
        a, b, ids = pairs[scope]
        pattern("same_act", scope, f"Είναι το «{a}» ο ίδιος καλλιτέχνης με το «{b}»;",
                ["A=όχι, μένουν χωριστά", "B=ναι, ο ίδιος"],
                "Τα δύο ονόματα διαφέρουν κατά ένα γράμμα (ή ένα «The»)· δεν ενώνονται χωρίς εσένα", ids)
    out.sort(key=lambda q: (-len(q["tracks"]), q["scope"]))
    return out

"""«Καθαρά ονόματα», stage 2: the pattern questions of one resolution (names/questions.py), on invented names."""
from __future__ import annotations

from app.services.names import Decision, References, TrackInput, resolve
from app.services.names.questions import pattern_questions

CORPUS = [
    TrackInput(1, "", "Lonely Title", folder="Unknown Artist/Unknown Album"),
    TrackInput(2, "Velkro", "Rise", links=()),
    TrackInput(3, "Liquid Sol & Alkimyst", "Tranceform"),
    TrackInput(4, "Kelvaron", "Tide"), TrackInput(5, "Kelvaron", "Floor"), TrackInput(6, "Kelvaron", "Shore"),
    TrackInput(7, "Kelvarin", "Lake"),
]


def _scopes(qs) -> dict[str, list[int]]:
    return {q["scope"]: q["tracks"] for q in qs}


def test_a_cold_library_gets_questions_not_guesses():
    res = resolve(CORPUS, References(), [])
    qs = pattern_questions(res, CORPUS, [])
    scopes = _scopes(qs)
    assert scopes["status:none"] == [1]
    assert scopes["pref:whole_credit_folder"] == [3]
    assert scopes["pair:kelvarin|kelvaron"] == [7]  # one question per pair of similar names
    for q in qs:
        assert q["kind"] in ("preference", "not_act", "same_act") and q["recommended"] == "A"
        assert q["question"] and [o.split("=", 1)[0] for o in q["options"]] == ["A", "B"]
        assert any("Ͱ" <= ch <= "Ͽ" for ch in q["question"] + q["why"])  # Greek
    assert [len(q["tracks"]) for q in qs] == sorted((len(q["tracks"]) for q in qs), reverse=True)
    assert res.tracks[7].status == "look"  # the pair is never merged on its own


def test_an_answered_question_stays_listed_so_it_can_be_given_again():
    decisions = [Decision("preference", "pref:year_at_title_end", "A"),
                 Decision("same_act", "pair:kelvarin|kelvaron", "yes")]
    res = resolve(CORPUS, References(), decisions)
    scopes = _scopes(pattern_questions(res, CORPUS, decisions))
    assert scopes["pref:year_at_title_end"] == []  # no track of the shape, still listed
    assert scopes["pair:kelvarin|kelvaron"] == [4, 5, 6, 7]  # the merged act's tracks
    assert "pref:project_bracket" not in scopes  # unanswered and nothing of its shape


def test_the_index_of_decisions_is_accepted_too():
    from app.services.names.resolve import index_decisions

    decisions = [Decision("not_act", "name:*music", "label")]
    res = resolve(CORPUS, References(), decisions)
    assert _scopes(pattern_questions(res, CORPUS, index_decisions(decisions)))["name:*music"] == []

"""«Καθαρισμός ονομάτων» stage 1: one test per acceptance row and counter-example of
.omc/plans/2026-11-27-name-cleaning.md, with invented names of the same shape (never the owner's data)."""
from __future__ import annotations

from app.services.names import Decision, Link, References, TrackInput, resolve
from app.services.names.text import fold


def t(i, artist, title, album="", folder="", **kw):
    return TrackInput(id=i, artist=artist, title=title, album=album, folder=folder, **kw)


def run(*tracks, refs=None, decisions=()):
    return resolve(list(tracks), refs or References(), list(decisions))


def acts_of(res, key):
    return sorted({a.name for r in res.tracks.values() for a in r.acts if a.key == key})


# ---------------------------------------------------------------- case 1: a title in the artist field
def test_row1_title_with_remix_in_artist_field_and_tempo_only_title():
    res = run(t(1, "Last Light Fades (Zarvo & Mintrel Remix)", "245", bpm_grid=245.0),
              t(2, "Zarvo", "Tide"), t(3, "Mintrel", "Floor"))
    r = res.tracks[1]
    assert r.artist == "Zarvo & Mintrel"
    assert r.title == "Last Light Fades (Zarvo & Mintrel Remix)"
    assert r.tempo_hint == "245"
    assert r.folder == "Zarvo"
    assert "N21" in r.rules and r.reason


# ---------------------------------------------------------------- case 2: a genre tag in front of the name
def test_row2_genre_bracket_dropped_from_artist_and_folder():
    r = run(t(1, "[Prog] Kelvaro", "Arc"), t(2, "Kelvaro", "Bow")).tracks[1]
    assert (r.artist, r.folder) == ("Kelvaro", "Kelvaro")
    assert "N7" in r.rules


def test_row2_counter_bracket_that_is_a_name_stays():
    assert run(t(1, "Malefico [The Endless Rope]", "Song")).tracks[1].artist == "Malefico [The Endless Rope]"


# ---------------------------------------------------------------- case 3: project members in brackets
def test_row3a_members_without_space():
    r = run(t(1, "Durovan(Pexlo & Marumba)", "Aho")).tracks[1]
    assert r.artist == "Durovan" and r.notes["members"] == ["Pexlo", "Marumba"]


def test_row3a_cut_form():
    r = run(t(1, "Durovan(Pexlo", "Aho")).tracks[1]
    assert r.artist == "Durovan" and r.notes["members"] == ["Pexlo"]


def test_row3b_members_with_apostrophe():
    assert run(t(1, "Echo Modulation (Bitter Plum's & Dyvex)", "X")).tracks[1].artist == "Echo Modulation"


def test_row3c_members_with_vs_and_casing():
    r = run(t(1, "GLASSY TIDES (Orvek vs Spirol)", "X"), t(2, "Glassy Tides", "Y")).tracks[1]
    assert r.artist == "Glassy Tides" and r.notes["members"] == ["Orvek", "Spirol"]


def test_row3d_same_act_as_the_solo_tracks():
    res = run(t(1, "Kaltu (Pexlo & Grey Murmur)", "X"), t(2, "Kaltu", "Y"))
    assert res.tracks[1].artist == "Kaltu"
    assert {a.key for a in res.tracks[1].acts if a.role == "primary"} == {a.key for a in res.tracks[2].acts
                                                                          if a.role == "primary"}


def test_row3e_camelcase_head_and_members():
    r = run(t(1, "ZenithOrbs (Prismy Hum & LogicOrb)", "X")).tracks[1]
    assert r.artist == "ZenithOrbs" and r.notes["members"] == ["Prismy Hum", "LogicOrb"]


def test_row3_counter_brackets_that_are_not_members():
    res = run(t(1, "Grace (DE), Opax", "A"), t(2, "Neutralo (A)", "B"), t(3, "thomo[s]", "C"),
              t(4, "Conic Blazers (Psykov) & Futuvo", "D"), t(5, "Velkro (aka Kro)", "E"))
    assert "Grace (DE)" in res.tracks[1].artist
    assert res.tracks[2].artist == "Neutralo (A)"
    assert res.tracks[3].artist.casefold() == "thomo[s]"
    assert res.tracks[4].artist.casefold() == "conic blazers (psykov) & futuvo"
    assert res.tracks[5].artist == "Velkro" and res.tracks[5].notes["alias"] == ["Kro"]


# ---------------------------------------------------------------- case 4: an EP by two acts
def _ep(ids, artist, album, folder, titles=None):
    return [t(i, artist, (titles or {}).get(i, f"Song {i}"), album, folder) for i in ids]


def test_row4a_ep_by_a_duo_gets_the_duo_folder():
    res = run(*_ep([1, 2, 3, 4], "Nobra & Dyvel", "Tidal EP", "Nobra & Dyvel/Tidal EP"), t(5, "Nobra", "Solo"),
              t(6, "Dyvel", "Solo"))
    for i in (1, 2, 3, 4):
        assert res.tracks[i].artist == "Nobra & Dyvel"
        assert res.tracks[i].folder == "Nobra & Dyvel"
        assert "N12" in res.tracks[i].rules
    assert res.tracks[5].folder == "Nobra"


def test_row4b_join_word_kept_in_artist_folder_uses_and_sign():
    res = run(*_ep([1, 2, 3], "Outer Cove vs. Temporal", "Molten Shapes", "Outer Cove vs. Temporal/Molten Shapes"),
              *_ep([4, 5, 6], "GLIDESTREET & FUZZLES", "Vs. Comets", "GLIDESTREET & FUZZLES/Vs. Comets"),
              t(7, "Glidestreet", "A"), t(8, "Fuzzles", "B"), t(9, "Outer Cove", "C"))
    assert {res.tracks[i].artist for i in (1, 2, 3)} == {"Outer Cove vs. Temporal"}
    assert {res.tracks[i].folder for i in (1, 2, 3)} == {"Outer Cove & Temporal"}
    assert {res.tracks[i].artist for i in (4, 5, 6)} == {"Glidestreet & Fuzzles"}
    assert {res.tracks[i].folder for i in (4, 5, 6)} == {"Glidestreet & Fuzzles"}


def _channel_library():
    """«Mira K» fronts tracks whose titles open with other known acts: an R3 channel."""
    return [t(101, "Mira K", "Orbalo - Shine", "Shine Single", "Mira K/Shine Single"),
            t(102, "Mira K", "Velkro - Rise", "Rise Single", "Mira K/Rise Single"),
            t(103, "Mira K", "Kelvaro - Fall", "Fall Single", "Mira K/Fall Single"),
            t(104, "Orbalo", "Solo"), t(105, "Velkro", "Solo"), t(106, "Kelvaro", "Solo"),
            t(107, "Crane", "Solo"), t(108, "Bolt", "Solo")]


def test_row4c_album_head_under_a_channel():
    album, folder = "Crane + Bolt - Remedy | EP", "Mira K/Crane + Bolt - Remedy _ EP"
    res = run(*_channel_library(), t(1, "Mira K", "Crane + Bolt - Catharsis", album, folder),
              t(2, "Mira K", "Crane + Bolt - Remedy", album, folder), t(3, "Mira K", "Crane + Bolt - Elves", album, folder))
    for i in (1, 2, 3):
        assert res.tracks[i].artist == "Crane & Bolt"
        assert res.tracks[i].folder == "Crane & Bolt"


def test_row4d_album_tag_head_names_the_act_under_a_channel():
    album, folder = "Orbalo - Stellar", "Mira K/Orbalo - Stellar"
    res = run(*_channel_library(), t(1, "Mira K", "Lively Shades", album, folder), t(2, "Mira K", "Arctic", album, folder))
    for i in (1, 2):
        r = res.tracks[i]
        assert (r.artist, r.status, r.folder) == ("Orbalo", "sure", "Orbalo")
        assert "N29" in r.rules


def test_row4d_prime_channel_with_nothing_naming_the_act_stays_open():
    r = run(*_channel_library(), t(1, "Mira K", "Quiet Orbit", "", "Mira K/Unknown Album")).tracks[1]
    assert (r.artist, r.status, r.open_code, r.folder) == ("Mira K", "open", "U10", "Mira K")


def test_row4e_two_track_ep():
    res = run(*_ep([1, 2], "Egora & Syntex", "Before / After", "Egora & Syntex/Before _ After"), t(3, "Egora", "Solo"))
    assert {res.tracks[i].folder for i in (1, 2)} == {"Egora & Syntex"}


def test_row4f_ep_split_over_two_folders_is_one_group():
    res = run(t(1, "Critic Fray & Horax", "Thrills", "Millennial Waves", "Music/Downloaded by MediaHuman"),
              t(2, "Critic Fray & Horax", "Let Go", "Millennial Waves", "Critic Fray & Horax/Millennial Waves"),
              t(3, "Critic Fray & Horax", "Replay", "Millennial Waves", "Critic Fray & Horax/Millennial Waves"),
              t(4, "Horax", "Solo"))
    assert len({res.tracks[i].folder for i in (1, 2, 3)}) == 1
    assert res.tracks[1].folder == "Critic Fray & Horax"


def test_row4g_two_thirds_share_a_credit_raises_one_album_question():
    res = run(t(1, "Drop Dripz vs Yanno", "Bar", "Coaster", "Drop Dripz vs Yanno/Coaster"),
              t(2, "Drop Dripz vs Yanno", "Know", "Coaster", "Drop Dripz vs Yanno/Coaster"),
              t(3, "Drop Dripz", "Stubble", "Coaster", "Drop Dripz/Coaster"), t(4, "Yanno", "Solo"))
    for i, top in ((1, "Drop Dripz vs Yanno"), (2, "Drop Dripz vs Yanno"), (3, "Drop Dripz")):
        r = res.tracks[i]
        assert (r.status, r.open_code, r.folder) == ("open", "U11", top)
    assert sum(1 for o in res.open_items if o["kind"] == "album_credit") == 1
    assert res.tracks[1].artist == "Drop Dripz vs Yanno"


def test_row4x_compilers_friends_and_big_credits_get_no_album_credit():
    comp = [t(i, "Compiled by Ferrox & Astrolo", f"{h} - Tune {i} (182)", "VA Sleep Test", "Compiled by Ferrox & Astrolo/VA")
            for i, h in ((1, "Velkro"), (2, "Orbalo"), (3, "Kelvaro"))]
    friends = _ep([4, 5], "Velkro and Friends", "Roots", "Velkro and Friends/Roots")
    big = _ep([6, 7], "Aa, Bb, Cc, Dd", "Four", "Aa, Bb, Cc, Dd/Four")
    res = run(*comp, *friends, *big, t(8, "Velkro", "Solo"), t(9, "Orbalo", "Solo"), t(10, "Kelvaro", "Solo"))
    for i in range(1, 8):
        assert res.tracks[i].album_credit == ""
    assert res.tracks[1].artist == "Velkro"


# ---------------------------------------------------------------- case 5: remixer, original artist and tempo in one field
def test_row5a_remix_credit_and_original_artist_in_the_artist_field():
    r = run(t(1, " [Hitech Psytrance] Mimo Vex Remix 200 Bpm ▱ Eurythma", "Slowly Drifting .·๑"),
            t(2, "Mimo Vex", "Other")).tracks[1]
    assert (r.artist, r.title, r.tempo_hint) == ("Mimo Vex", "Slowly Drifting (Mimo Vex Remix)", "200")
    assert r.notes["original"] == ["Eurythma"]


def test_row5b_the_same_shape_in_the_title_tag():
    r = run(t(1, "[HiTech Darkpsy Psytrance] MimoVex", "Slowly Drifting Rmx 200 Bpm - Eurythma"),
            t(2, "Mimo Vex", "Other"), t(3, "Mimo Vex", "Third")).tracks[1]
    assert (r.artist, r.title, r.tempo_hint) == ("Mimo Vex", "Slowly Drifting (Mimo Vex Remix)", "200")
    assert r.notes["original"] == ["Eurythma"]


def test_remix_counter_the_file_credits_the_original_artist():
    r = run(t(1, "Shanti Folk", "Hanu (Tech Hitch Remix)"), t(2, "Tech Hitch", "Solo")).tracks[1]
    assert (r.artist, r.title) == ("Shanti Folk", "Hanu (Tech Hitch Remix)")


# ---------------------------------------------------------------- the other C rows
def test_album_fronted_by_an_uploader_track_number_and_tempo():
    album = "VA Gathering by Razor"
    res = run(t(1, "Razor", "11.Varázsfo & Neorn - The Universal (244bpm)", album, "Razor/VA"),
              t(2, "Razor", "12.Fat Fredo - Dripping (272bpm)", album, "Razor/VA"),
              t(3, "Razor", "13.Raw Garlik - Omnia (163bpm)", album, "Razor/VA"))
    r = res.tracks[1]
    assert (r.artist, r.title, r.tempo_hint) == ("Varázsfo & Neorn", "The Universal", "244")


def test_cross_field_version_bracket_then_swap():
    refs = References(spotify=(("Lincoln Parx", 3),))
    r = run(t(1, "In The Dark (Simox Remix", "Lincoln Parx)- FREE DOWNLOAD"), refs=refs).tracks[1]
    assert (r.artist, r.title) == ("Lincoln Parx", "In The Dark (Simox Remix)")


def test_fields_swapped():
    r = run(t(1, "Smoke Three Pipes", "Cojo vs Sifu"), t(2, "Cojo", "A"), t(3, "Sifu", "B")).tracks[1]
    assert (r.artist, r.title) == ("Cojo vs Sifu", "Smoke Three Pipes")
    assert "N13" in r.rules


def test_swap_counter_a_title_made_of_unknown_words_stays():
    r = run(t(1, "Velkro", "Sun & Moon")).tracks[1]
    assert (r.artist, r.title) == ("Velkro", "Sun & Moon")


def test_placeholder_number_artist_takes_the_title_head():
    r = run(t(1, "15", "Sadhu X - Elemental [198]")).tracks[1]
    assert (r.artist, r.title, r.status, r.tempo_hint) == ("Sadhu X", "Elemental", "look", "198")


def test_leading_numbers_before_known_acts():
    res = run(t(1, "10 Ajjo & Nirmo", "Daze"), t(2, "Ajjo", "Solo"),
              t(3, "Gotalo", "198 Gotalo vs Angry Lune - Shant (2026 edit)", bpm_grid=198.0), t(4, "Gotalo", "Solo"),
              t(5, "", "10 Cyborgo & AstriDak - Robot Lov"), t(6, "Cyborgo", "Solo"))
    assert res.tracks[1].artist == "Ajjo & Nirmo"
    assert (res.tracks[3].artist, res.tracks[3].title, res.tracks[3].tempo_hint) == (
        "Gotalo vs Angry Lune", "Shant (2026 edit)", "198")
    assert (res.tracks[5].artist, res.tracks[5].title) == ("Cyborgo & AstriDak", "Robot Lov")


def test_numbers_that_are_names_or_titles_stay():
    res = run(t(1, "Velkro", "7 Skies", bpm_grid=145.0), t(2, "Velkro", "400 Drops", bpm_grid=145.0),
              t(3, "Velkro", "604 Revolution", bpm_grid=145.0), t(4, "Velkro", "1991", bpm_grid=145.0),
              t(5, "Velkro", "2525", bpm_grid=145.0), t(6, "Velkro", "36", bpm_grid=145.0),
              t(7, "Velkro", "Greece 2020 158", bpm_grid=74.0))
    assert [res.tracks[i].title for i in range(1, 8)] == ["7 Skies", "400 Drops", "604 Revolution", "1991", "2525",
                                                          "36", "Greece 2020 158"]


def test_cross_field_group_with_a_known_act_inside():
    r = run(t(1, "Ida Nado (Visionary Shamans", "Temple of Dubs VA)"), t(2, "Visionary Shamans", "Solo")).tracks[1]
    assert (r.artist, r.title) == ("Visionary Shamans", "Ida Nado")
    assert r.notes.get("album") == "Temple of Dubs VA"


def test_cross_field_group_without_evidence_is_open_u8():
    # (with a release word such as «VA» in the bracket the head is the title: test_names_rules, names-3)
    r = run(t(1, "Ida Nado (Visionary Shamans", "Temple of Dubs)")).tracks[1]
    assert (r.status, r.open_code) == ("open", "U8")


def test_lookalike_spellings_fold_to_one_act():
    res = run(t(1, "KiLLAZK", "A"), t(2, "KiLLAZK", "B"), t(3, "Killazk", "C"), t(4, "Killazk", "D"),
              t(5, "KILLAZK", "E"), t(6, "KiLLΔZK", "F"), t(7, "KillΔzk", "G"))
    assert {res.tracks[i].artist for i in range(1, 8)} == {"Killazk"}
    assert not any("δ" in r.artist for r in res.tracks.values())


# ---------------------------------------------------------------- K rows: casing
def test_casing_takes_the_acceptable_library_spelling():
    res = run(t(1, "SPIRALVEL", "A"), t(2, "Spiralvel", "B"), t(3, "BIONIXFORM", "C"), t(4, "BionixForm", "D"),
              t(5, "BionixForm", "E"), t(6, "zynxpunx", "F"), t(7, "ZynxPunx", "G"), t(8, "RiDDoN", "H"),
              t(9, "Riddon", "I"), t(10, "Fractaly hum", "J"), t(11, "Fractaly Hum", "K"), t(12, "COSMA", "L"),
              t(13, "COSMA", "M"), t(14, "Cosma", "N"))
    got = [res.tracks[i].artist for i in (1, 3, 6, 8, 10, 12)]
    assert got == ["Spiralvel", "BionixForm", "ZynxPunx", "Riddon", "Fractaly Hum", "Cosma"]


def test_casing_tie_on_groups_goes_to_tracks_and_is_look():
    res = run(*_ep([1, 2, 3], "E-montra", "One", "E-montra/One"), t(4, "E-Montra", "Single"))
    assert res.tracks[4].artist == "E-montra"
    assert res.tracks[4].status == "look"


def test_casing_generated_when_there_is_no_other_spelling():
    res = run(t(1, "ALL IN TWO", "A"), t(2, "DIE SANDFRAU", "B"), t(3, "NGHT OWLZ", "C"), t(4, "ATB", "D"),
              t(5, "ZDLKT", "E"), t(6, "DJ SAVO", "F"))
    assert [res.tracks[i].artist for i in range(1, 7)] == ["All In Two", "Die Sandfrau", "Nght Owlz", "ATB", "ZDLKT",
                                                           "DJ Savo"]
    assert all(res.tracks[i].status == "look" for i in (1, 2, 3))


def test_join_word_lowered_and_acts_cased():
    res = run(t(1, "COSMA VS GOTALO", "A"), t(2, "Cosma", "B"), t(3, "Gotalo", "C"), t(4, "OVNI X", "D"))
    assert res.tracks[1].artist == "Cosma vs Gotalo"
    assert res.tracks[4].artist == "Ovni X"


def test_act_names_inside_a_version_bracket_take_the_act_spelling():
    res = run(t(1, "Velkro", "Shine (DIE SANDFRAU Remix)"), t(2, "Die Sandfrau", "A"))
    assert res.tracks[1].title == "Shine (Die Sandfrau Remix)"


def test_decorations_removed():
    res = run(t(1, "Rajju Bobo 🔱", "A"), t(2, "PeePace (ॐ)", "B"), t(3, "ॐ Neutro", "C"), t(4, "ॐ Hyperplex", "D"))
    assert [res.tracks[i].artist for i in range(1, 5)] == ["Rajju Bobo", "PeePace", "Neutro", "Hyperplex"]


def test_a_spelling_decision_wins_and_covers_every_track():
    res = run(t(1, "VELTROX", "A"), t(2, "Veltrox", "B"), decisions=[Decision("spelling", "act:veltrox", "=VelTrox")])
    assert {res.tracks[1].artist, res.tracks[2].artist} == {"VelTrox"}


def test_a_track_decision_is_shown_as_typed():
    res = run(t(1, "weird", "thing"), decisions=[Decision("track", "track:1", "my Artist | My Title")])
    r = res.tracks[1]
    assert (r.artist, r.title, r.status) == ("my Artist", "My Title", "hand")


# ---------------------------------------------------------------- counter-examples
def test_counter_live_outside_brackets_is_a_name():
    res = run(t(1, "Kayvos Live", "Soul"), t(2, "Live Magnor", "Melodic"), t(3, "Anubix Live", "Night"))
    assert [res.tracks[i].artist for i in (1, 2, 3)] == ["Kayvos Live", "Live Magnor", "Anubix Live"]


def test_counter_a_dash_that_is_not_a_split():
    assert run(t(1, "O - Zona", "Silent")).tracks[1].artist == "O - Zona"


def test_counter_one_camelcase_outlier_never_wins():
    res = run(*[t(i, "Gotalo", f"T{i}") for i in range(1, 5)], t(5, "GotAlo", "X"))
    assert res.tracks[5].artist == "Gotalo"


def test_counter_lookalike_only_spelling_kept_as_written_with_a_doubt():
    res = run(t(1, "BLΛK NOIZ", "Mechanoid"))
    assert res.tracks[1].artist == "BLΛK NOIZ"
    row = next(a for a in res.acts if a["key"] == "blaknoiz")
    assert row["doubt"] == "U5"


def test_counter_letters_after_a_joiner():
    res = run(t(1, "Tzu~Jon", "A"), t(2, "AC/DC", "B"))
    assert (res.tracks[1].artist, res.tracks[2].artist) == ("Tzu~Jon", "AC/DC")


def test_counter_unlinked_duo_name_keeps_the_whole_folder():
    res = run(t(1, "Above & Beyondo", "A"), t(2, "Above & Beyondo", "B"))
    assert {res.tracks[1].folder, res.tracks[2].folder} == {"Above & Beyondo"}


def test_counter_two_spellings_without_a_two_thirds_majority_are_look():
    res = run(t(1, "Critic Fray", "A"), t(2, "Critic Fray", "B"), t(3, "CriticFray", "C"), t(4, "CriticFray", "D"))
    row = next(a for a in res.acts if a["key"] == fold("Critic Fray"))
    assert (row["status"], row["doubt"]) == ("look", "U7")
    assert len({r.artist for r in res.tracks.values()}) == 1


def test_counter_spotify_contradiction_keeps_the_local_credit_as_look():
    r = run(t(1, "COSMA VS GOTALO", "Bass", links=(Link("spotify", ("Cosma Noise",), "Bass"),)),
            t(2, "Cosma", "B"), t(3, "Gotalo", "C")).tracks[1]
    assert r.artist == "Cosma vs Gotalo" and r.status == "look"


def test_no_artist_anywhere_is_none_and_unknown_artist():
    r = run(t(1, "", "Lonely Title", folder="Unknown Artist/Unknown Album")).tracks[1]
    assert (r.status, r.artist, r.folder) == ("none", "Unknown Artist", "Unknown Artist")


def test_every_change_has_a_greek_reason():
    res = run(t(1, "[Prog] Kelvaro", "Arc (Original Mix)"), t(2, "GLASSY TIDES (Orvek vs Spirol)", "X"))
    for r in res.tracks.values():
        assert r.reason and any("Ͱ" <= c <= "Ͽ" for c in r.reason)

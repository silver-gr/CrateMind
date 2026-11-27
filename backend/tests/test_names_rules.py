"""«Καθαρισμός ονομάτων»: rule tests for shapes met while measuring stage 1 on a library (invented names only)."""
from __future__ import annotations

from app.services.names import Link, References, TrackInput, resolve


def t(i, artist, title, album="", folder="", **kw):
    return TrackInput(id=i, artist=artist, title=title, album=album, folder=folder, **kw)


def run(*tracks, refs=None):
    return resolve(list(tracks), refs or References(), [])


def test_track_number_in_the_artist_field():
    res = run(t(1, "4. Darqo", "Vah"), t(2, "02 Opticalo", "Life"), t(3, "1- Zaako", "Paso"))
    assert [res.tracks[i].artist for i in (1, 2, 3)] == ["Darqo", "Opticalo", "Zaako"]


def test_tempo_only_title_moves_the_artist_field_when_a_record_names_the_artist():
    r = run(t(1, "Carrot Sea", "192", bpm_grid=192.0,
              links=(Link("soundcloud", ("Velkro",), "Carrot Sea", "Some Uploads"),))).tracks[1]
    assert (r.artist, r.title, r.tempo_hint) == ("Velkro", "Carrot Sea", "192")


def test_tempo_only_title_with_no_artist_anywhere_is_open_u2():
    r = run(t(1, "Carrot Sea", "192", bpm_grid=192.0)).tracks[1]
    assert (r.status, r.open_code) == ("open", "U2")


def test_title_then_artist_with_a_linked_record_agreeing():
    r = run(t(1, "Psink Kaoz", "Divine Energo-Koktavo & Sheik Yuro",
              links=(Link("spotify", ("Koktavo", "Sheik Yuro"), "Divine Energo"),))).tracks[1]
    assert (r.artist, r.title) == ("Koktavo & Sheik Yuro", "Divine Energo")


def test_featured_credit_in_brackets():
    r = run(t(1, "Noctem Voz ( Ft Cojo )", "Night")).tracks[1]
    assert r.artist == "Noctem Voz ft Cojo"
    assert {a.role for a in r.acts} >= {"primary", "featured"}


def test_feat_bracket_in_the_title_lists_featured_acts():
    r = run(t(1, "Kayro Live", "Masala (Feat Sitar Xav and Sruthi)")).tracks[1]
    assert r.artist == "Kayro Live"
    assert {a.name for a in r.acts if a.role == "featured"} == {"Sitar Xav", "Sruthi"}


def test_own_name_glued_to_the_title_with_a_dash():
    res = run(t(1, "Neutralo (A)", "Neutralo-Go crazy!"), t(2, "Ranjo @", "Ranjo-Power Of Acid"))
    assert res.tracks[1].title == "Go crazy"
    assert (res.tracks[2].artist, res.tracks[2].title) == ("Ranjo", "Power Of Acid")


def test_head_of_a_title_found_by_the_file_name_is_not_kept_twice():
    r = run(t(1, "", "U-Reckon Feat. Zio-\"Lullaby\" 2012", file_name="U-Reckon Feat. Zio-_Lullaby_ 2012.mp3")).tracks[1]
    assert r.artist == "U-Reckon feat. Zio" and r.title == '"Lullaby" 2012'


def test_label_word_artist_with_a_soundcloud_publisher():
    r = run(t(1, "Parivo Records", "Nobody Listens (Free Download)",
              links=(Link("soundcloud", ("Neuro Twist",), "Nobody Listens", "Parivo Records"),))).tracks[1]
    assert (r.artist, r.title, r.status) == ("Neuro Twist", "Nobody Listens", "look")


def test_official_account_name_keeps_the_act_when_it_is_known():
    res = run(t(1, "Papo Stumpf Official", "Nirvo"), t(2, "Papo Stumpf", "Solo"), t(3, "Krankzo (Official)", "Yo"))
    assert res.tracks[1].artist == "Papo Stumpf"
    assert res.tracks[3].artist == "Krankzo"


def test_compilation_fronted_by_its_compiler():
    album = "Module Fight 2"
    tracks = [t(i, "Bionix", title, album, "Bionix/Module Fight 2") for i, title in (
        (1, "& Sepski - Eternal (180)"), (2, "Spiralo - Alternative (197)"), (3, "Labrot - Twin (185)"),
        (4, "Seyro - Hermes (207)"))]
    res = run(*tracks, t(5, "Spiralo", "Solo"), t(6, "Labrot", "Solo"))
    assert res.tracks[1].artist == "Bionix & Sepski"
    assert (res.tracks[2].artist, res.tracks[2].title) == ("Spiralo", "Alternative")
    assert res.tracks[4].artist == "Seyro"


def test_promo_and_technical_tails_leave_the_title():
    res = run(t(1, "Velkro", "Tribe - Official"), t(2, "Velkro", "Apolo 13 - YT"),
              t(3, "Velkro", "Hikuro - EP Trailer"), t(4, "Velkro", "Sails *fulltrck"),
              t(5, "Velkro", "Ghost Ship * FREE DOWNLOAD NOW"), t(6, "Velkro", "Odyn (180 bpm) Free Dowload/NO MASTER/"),
              t(7, "Velkro", "Rave Master"))
    assert [res.tracks[i].title for i in range(1, 8)] == ["Tribe", "Apolo 13", "Hikuro", "Sails", "Ghost Ship", "Odyn",
                                                          "Rave Master"]


def test_album_name_and_track_number_in_front_of_the_title():
    r = run(t(1, "Kooblo", "Horror Fud - 01 Kooblo - Mungle 2")).tracks[1]
    assert (r.artist, r.title) == ("Kooblo", "Mungle 2")


def test_a_key_and_tempo_artist_field_is_no_artist():
    r = run(t(1, "G# 145", "Jilaxo - Om Shanto")).tracks[1]
    assert (r.artist, r.title) == ("Jilaxo", "Om Shanto")

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
    assert res.tracks[1].title == "Go crazy!"  # names-4: a «!» glued to the last word is part of the title
    assert (res.tracks[2].artist, res.tracks[2].title) == ("Ranjo", "Power Of Acid")


def test_head_of_a_title_found_by_the_file_name_is_not_kept_twice():
    r = run(t(1, "", "U-Reckon Feat. Zio-\"Lullaby\" 2012", file_name="U-Reckon Feat. Zio-_Lullaby_ 2012.mp3")).tracks[1]
    assert r.artist == "U-Reckon feat. Zio" and r.title == "Lullaby 2012"  # names-3: quotes around the opening words go


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


# ---------------------------------------------------------------- ruleset names-3: casing (measured 2026-11-27)
def test_camelcase_with_a_two_letter_part_is_kept():
    res = run(t(1, "PsyToHo", "A"), t(2, "PsyToHo", "B"), t(3, "PSYTOHO", "C"), t(4, "RaRooto & Mucky", "D"),
              t(5, "KaYo", "E"), t(6, "DoHz", "F"))
    assert [res.tracks[i].artist for i in range(1, 6)] == ["PsyToHo", "PsyToHo", "PsyToHo", "RaRooto & Mucky", "Kayo"]
    assert res.tracks[6].artist == "Dohz"  # «Hz» has no vowel: not a CamelCase part


def test_generated_spelling_keeps_the_words_that_are_already_clean():
    assert run(t(1, "DLX_ZuluTones", "A")).tracks[1].artist == "Dlx ZuluTones"


def test_unsplit_join_word_keeps_its_lower_case():
    res = run(t(1, "Arnovo x Tryptor", "A"), t(2, "Kasatko and Namascoy", "B"),
              t(3, "Vlastor, George Zikoz and Natalie H.", "C"))
    assert [res.tracks[i].artist for i in (1, 2, 3)] == ["Arnovo x Tryptor", "Kasatko and Namascoy",
                                                         "Vlastor, George Zikoz and Natalie H."]


def test_lowercase_particle_written_in_the_library_is_kept():
    assert run(t(1, "Janniko van der Vogt", "A")).tracks[1].artist == "Janniko van der Vogt"


def test_spotify_breaks_a_tie_before_fewer_capitals():
    r = run(t(1, "GMZ", "A"), t(2, "Gmz", "B"), refs=References(spotify=(("GMZ", 4),))).tracks[2]
    assert r.artist == "GMZ"


def test_act_names_in_a_title_bracket_take_the_spelling_only_of_a_credited_act():
    res = run(t(1, "Janniko", "Switcho (TECHNO BOOTLEG)"), t(2, "Velkro", "Shine (NOXO Remix)"), t(3, "NOXO", "Solo"),
              t(4, "Velkro", "Glow (DIE SANDFRAU Remix)"), t(5, "Die Sandfrau", "Solo"))
    assert res.tracks[1].title == "Switcho (TECHNO BOOTLEG)"
    assert res.tracks[2].title == "Shine (Noxo Remix)"  # credited as an artist: its spelling, generated or not
    assert res.tracks[4].title == "Glow (Die Sandfrau Remix)"


def test_open_rows_are_not_recased_by_generated_spellings():
    r = run(t(1, "Ida Nado (VISIONARY Shamans", "Temple Of Dubs)")).tracks[1]
    assert (r.status, r.open_code) == ("open", "U8")
    assert r.artist == "Ida Nado (VISIONARY Shamans"


def test_weak_join_splits_when_one_part_is_a_strong_act():
    res = run(t(1, "MARCUSO x Lunawot", "A"), t(2, "Marcuso", "B"), t(3, "Marcuso", "C"),
              t(4, "Agresso Mood and Aeroquat", "D"), t(5, "Agresso Mood", "E"), t(6, "Agresso Mood", "F"),
              t(7, "Arnovo x Tryptor", "G"))
    r = res.tracks[1]
    assert (r.artist, r.folder, r.status) == ("Marcuso x Lunawot", "Marcuso", "look")
    assert (res.tracks[4].artist, res.tracks[4].folder) == ("Agresso Mood and Aeroquat", "Agresso Mood")
    assert res.tracks[7].folder == "Arnovo x Tryptor"  # neither part is known on its own: one act


# ---------------------------------------------------------------- ruleset names-3: numbers
def test_a_file_name_made_from_the_title_is_no_track_number():
    res = run(t(1, "Velkro", "7 Seas", file_name="7 Seas.mp3"),
              t(2, "Velkro", "7 Skies (Acquo Remix)", file_name="7 Skies (Acquo Remix).mp3"),
              t(3, "Velkro", "3 Rising", file_name="03 - Rising.mp3"))
    assert [res.tracks[i].title for i in (1, 2, 3)] == ["7 Seas", "7 Skies (Acquo Remix)", "Rising"]


def test_tempo_before_a_version_bracket_before_a_key_or_with_a_bracketed_bpm():
    res = run(t(1, "Marco", "Going Homo 234 (2019 Edit)", bpm_grid=234.0),
              t(2, "Jilo", "Sunno 140 Cmin", bpm_grid=140.0), t(3, "Balo", "Selfhypno 176(bpm)"),
              t(4, "Inno", "We are Godz 195 (Nyoto Remix) [195]", bpm_grid=195.0),
              t(5, "Marco", "Going Homo 234 (2019 Edit)", bpm_grid=150.0))
    assert [(res.tracks[i].title, res.tracks[i].tempo_hint) for i in range(1, 6)] == [
        ("Going Homo (2019 Edit)", "234"), ("Sunno", "140"), ("Selfhypno", "176"), ("We are Godz (Nyoto Remix)", "195"),
        ("Going Homo 234 (2019 Edit)", "")]


def test_a_number_dash_number_is_not_a_track_number():
    r = run(t(1, "Cosmo", "1 - 2 POLIZEO 190  FREE DOWNLOAD", bpm_grid=190.0)).tracks[1]
    assert r.title == "1 - 2 POLIZEO"


# ---------------------------------------------------------------- ruleset names-3: release, label and promo text in titles
def titles(*pairs, **kw):
    res = run(*[t(i + 1, a, ti, **kw) for i, (a, ti) in enumerate(pairs)])
    return [res.tracks[i + 1].title for i in range(len(pairs))]


def test_label_compilation_and_ep_tails_after_a_bracket():
    assert titles(("Uko", "Alquimo (Minimix) Sangomo Recs"), ("Superlo", "Infinito (Minimix) Sangomo Recs."),
                  ("Kralo", "Kranko (Original Mix) Hightech Therapo VA"), ("Kalo", "Unsolvo (Daksho RMX) Foresto Rec"),
                  ("Emerso", "Brain Rollo [Yatzo Rmx 2016] 207 Bpm - IN TIMO (EP)"),
                  ("Crono", "Cursed Soulo (190 bpm) Quantum Digito Rec., Compiled By Oxomo"),
                  ("Velkro", "Broken Records"), ("Velkro", "Record Breaker")) == [
        "Alquimo (Minimix)", "Infinito (Minimix)", "Kranko", "Unsolvo (Daksho RMX)", "Brain Rollo [Yatzo Rmx 2016]",
        "Cursed Soulo", "Broken Records", "Record Breaker"]


def test_compilation_and_release_notes_in_titles():
    assert titles(("Exa Melo", "MDMADDIKT (V/A VINAYAKO BonusTrack) FREE DOWNLOAD"),
                  ("HighOm", "Northern Whispo (190bpm) V/A VINAYAKO"),
                  ("Popko", "Neophobo - 195 (V/A FREAKY KNOBZ VOL 3.) FREE DOWNLOAD"),
                  ("Mentalo", "Beautiful Lusto (200)on V.A. Over 9000 by Electromoon Records"),
                  ("Lunato", 'California Dreamo [187] Out on Peyo Crew Label Album "Coming Soon"'),
                  ("Ranjo", "Power Of Acido (Demo) Out 9 july on Beatport !"),
                  ("Crono", "Diabolo Dance  158bpm(soon_out_on_horrordelic)"),
                  ("Insight Trippo", "Intro (150bpm) (Mastering By Vox Fabro) Full Album OUT SOON!!"),
                  ("Majoro & Realo", "Freak Showo (ReRelease on Majoro's Album 17/10)"),
                  ("Velkro", "Lights Out On Mars"), bpm_grid=195.0) == [
        "MDMADDIKT", "Northern Whispo", "Neophobo", "Beautiful Lusto", "California Dreamo", "Power Of Acido (Demo)",
        "Diabolo Dance", "Intro", "Freak Showo", "Lights Out On Mars"]


def test_mastering_notes_leave_the_title():
    assert titles(("Otolo", "Ritual (192)IMARAKO MASTER"), ("Hypero", "Dead Dreamo (202) [HyperAdmo MASTER]"),
                  ("Murmo", "Danza Sobro [240] Master By Papa Legbo"),
                  ("Planko", "Devil Instincto [325 - 450 - 522]  Master"),
                  ("Ranjo", "Piece Of Hearto (Ranjo Remix) MasterFinal"),
                  ("Holy Manu", "Shapes Of Consciouso [195bpm] AlpscoreMASTER)"),
                  ("Velkro", "Rave Master"), ("Velkro", "THE RAVE MASTER"), ("Velkro", "Master Blaster")) == [
        "Ritual", "Dead Dreamo", "Danza Sobro", "Devil Instincto [325 - 450 - 522]", "Piece Of Hearto (Ranjo Remix)",
        "Shapes Of Consciouso", "Rave Master", "THE RAVE MASTER", "Master Blaster"]


def test_preview_free_download_catalogue_single_and_extension_markers():
    assert titles(("Daydo", "DayDreamo 190 (prv)"), ("Crito", "Across The Oceano 200 PRV"),
                  ("Velkro", "Not Afraido [182] (Original Mix)*FREE-DL* #i_lost_the_project"),
                  ("Xenro", "OMNO [Single 2022]"), ("Dairo", "CYANO [TX049]"),
                  ("Ghosto", "Crossroado (Official Audio).mp3"), ("Shivo", "Shivo Tandavo ( PsyTrance )"),
                  ("Virtuo", "Fair Storo 178 Bpm 🔊 Hitech Psytrance 2017 🎶 - YouTube"), ("Biomeko", "Trailer"),
                  ("Velkro", "Lab Sample 1367"), ("Velkro", "Friends (Raw Snippet)"), bpm_grid=190.0) == [
        "DayDreamo", "Across The Oceano 200", "Not Afraido", "OMNO", "CYANO", "Crossroado", "Shivo Tandavo",
        "Fair Storo", "Trailer", "Lab Sample 1367", "Friends (Raw Snippet)"]


def test_bracket_spacing_and_dashes_in_titles():
    assert titles(("Neoko", "Get Up Stando (Bob Marlo Remix 200bpm)"), ("Rugro", "Not my Tempo - (Rugro Remix)"),
                  ("Systo", "India Cultura(Live Edit)[Free Download]"), ("Velkro", "Heart(s)"),
                  ("Voydo", "Nothing To Loso - 188BPM (Spiral Master )"), ("Urecko", '"Lullabo" 2012')) == [
        "Get Up Stando (Bob Marlo Remix)", "Not my Tempo (Rugro Remix)", "India Cultura (Live Edit)", "Heart(s)",
        "Nothing To Loso", "Lullabo 2012"]


def test_small_capital_letters_are_letters():
    r = run(t(1, "Pulsaro", "Rebirtho (Deado Remix)  | [ʀᴇsᴏɴ8 ᴍᴜsɪᴄ]")).tracks[1]
    assert r.title == "Rebirtho (Deado Remix)"


def test_a_title_tail_naming_the_chosen_artist_leaves():
    res = run(t(1, "Universo Records", "Raggahitecho Vol. 2 by Neokontro (OUT NOW)",
                links=(Link("soundcloud", ("Neokontro",), "x", "Universo Records"),)),
              t(2, "JaguarTreo [Merkabo Music]", "DMT by JaguarTreo"))
    assert res.tracks[1].artist == "Neokontro" and res.tracks[1].title == "Raggahitecho Vol. 2"
    assert (res.tracks[2].artist, res.tracks[2].title) == ("JaguarTreo", "DMT")


# ---------------------------------------------------------------- ruleset names-3: readings and structure
def test_a_credit_that_starts_with_a_join_word_is_cut_and_open():
    res = run(t(1, "and Apollo", "Next Lifo"), t(2, "vs. Vertsto", "Supermo (200)"), t(3, "VS ZUSMO ARIKO", "Evolo"),
              t(4, "w/Atroppo", "Way Of Shamo"))
    for i in range(1, 5):
        assert (res.tracks[i].status, res.tracks[i].open_code) == ("open", "U12"), i
    assert res.tracks[1].artist == "and Apollo"


def test_glued_dash_head_of_a_known_act():
    res = run(t(1, "", "Hyperplexo-Principal Deito [179] SAMPLE"), t(2, "Hyperplexo", "A"), t(3, "Hyperplexo", "B"),
              t(4, "Hyperplexo", "C"), t(5, "Velkro", "K-Freqo Night"), t(6, "", "Hi-Techo Dreams"))
    r = res.tracks[1]
    assert (r.artist, r.title, r.status) == ("Hyperplexo", "Principal Deito", "look")
    assert res.tracks[5].title == "K-Freqo Night"
    assert res.tracks[6].status == "none" and res.tracks[6].title == "Hi-Techo Dreams"


def test_wide_gap_and_underscore_heads():
    res = run(t(1, "", "Felo   Entropo 205 bpm"), t(2, "Felo", "A"), t(3, "Felo", "B"),
              t(4, "Virtuano", "Virtuano & Oxidakso_What's this smell??"), t(5, "Oxidakso", "C"),
              t(6, "", "Puristo_ Aura Spirito", links=(Link("soundcloud", (), "x", "Puristo"),)),
              t(7, "Velkro", "42°00_22.8N 21°24_29.8E"))
    assert (res.tracks[1].artist, res.tracks[1].title) == ("Felo", "Entropo")
    assert (res.tracks[4].artist, res.tracks[4].title) == ("Virtuano & Oxidakso", "What's this smell??")
    assert (res.tracks[6].artist, res.tracks[6].title) == ("Puristo", "Aura Spirito")
    assert res.tracks[7].title == "42°00_22.8N 21°24_29.8E"


def test_a_dash_version_waits_for_the_head():
    res = run(t(1, "4", "Kaikko - Africo Remix [192] (VA Modern Witcho Vol.2)"),
              t(2, "Gmo", "Juico - Module Viro - Rmx"), t(3, "Velkro", "Shine - Orbalo Remix"))
    assert (res.tracks[1].artist, res.tracks[1].title) == ("Kaikko", "Africo Remix")
    assert res.tracks[2].title == "Juico (Module Viro Rmx)"
    assert res.tracks[3].title == "Shine (Orbalo Remix)"


def test_the_artist_field_named_as_remixer_in_the_title_tail_stays_the_artist():
    res = run(t(1, "Gotalo", "198 MimoVex - Wildfiro Gotalo Remix (2026 edit)", bpm_grid=198.0), t(2, "Gotalo", "A"),
              t(3, "Mimo Vex", "B"), t(4, "Mimo Vex", "C"))
    r = res.tracks[1]
    assert (r.artist, r.title, r.notes.get("original")) == ("Gotalo", "Wildfiro (Gotalo Remix) (2026 edit)", ["Mimo Vex"])


def test_a_leading_intro_bracket_in_a_head_moves_to_the_title():
    album, folder = "VA Fynbo Forest", "Zedlo/VA Fynbo Forest"
    res = run(t(1, "ZDLKO", "(intro) Talismo - Disa's Dreamo [144]", album, folder),
              t(2, "ZDLKO", "Chillo - Smoko [100bpm]", album, folder), t(3, "ZDLKO", "Bolto - Rain", album, folder))
    assert (res.tracks[1].artist, res.tracks[1].title) == ("Talismo", "Disa's Dreamo (intro)")


def test_a_feat_bracket_heading_the_title_joins_the_credit():
    res = run(*[t(i, "Napro & Dyfo", ti, "Symbo EP", "Napro & Dyfo/Symbo EP") for i, ti in (
        (1, "(ft. Zelto, Onibo) - Starlinko"), (2, "Two"), (3, "Three"))], t(4, "Napro", "Solo"))
    r = res.tracks[1]
    assert (r.artist, r.title, r.folder) == ("Napro & Dyfo ft. Zelto, Onibo", "Starlinko", "Napro & Dyfo")


def test_a_feat_inside_a_bracket_is_no_member_list():
    r = run(t(1, "Afterhoro (TroyBo feat Diplo & Nina Sko)", "BOOTLEG")).tracks[1]
    assert not r.notes.get("members")
    assert r.status == "open"


def test_a_credit_bracket_already_in_the_credit_leaves_the_title():
    r = run(t(1, "", "Enter Your Mindo (vs Sonic Systo)",
              links=(Link("spotify", ("Yatzo", "Sonic Systo"), "Enter Your Mindo"),))).tracks[1]
    assert (r.artist, r.title) == ("Yatzo vs Sonic Systo", "Enter Your Mindo")


def test_a_version_bracket_alone_after_the_dash_names_the_artist():
    r = run(t(1, "", "Shantyro- (Munro Original Mix)")).tracks[1]
    assert (r.artist, r.title) == ("Munro", "Shantyro")


def test_a_title_field_that_is_only_a_remix_credit():
    res = run(t(1, "Requiem for a dreamo", "Slaysto Remix"), t(2, "Slaysto", "A"), t(3, "Slaysto", "B"),
              t(4, "Synapto Blendo", "(Nando Remix)"))
    r = res.tracks[1]
    assert (r.artist, r.title, r.status) == ("Slaysto", "Requiem for a dreamo (Slaysto Remix)", "look")
    assert res.tracks[4].status == "open"


def test_an_album_head_must_be_a_known_act_and_never_the_artist_field():
    res = run(t(1, "VA", "Magico Mantro", "Mantro - Soundo"), t(2, "VA", "Other Mantro", "Mantro - Soundo"),
              t(3, "INSANO AZYLO", "Meditato (Deado Mashup & Rmx)", "INSANO AZYLO - VA - MEDITATO"))
    assert res.tracks[1].status == "none"
    assert "N29" not in res.tracks[3].rules


def test_a_decorated_trailing_word_is_no_second_act():
    r = run(t(1, "Plankto •anomalisto•", "Abstract Poetro")).tracks[1]
    assert r.artist == "Plankto" and r.status == "look"


def test_two_acts_that_the_linked_record_lists_are_split():
    res = run(t(1, "Ghost Rido  Durso", "Crossroado (Official Audio).mp3",
                links=(Link("spotify", ("Ghost Rido", "Durso"), "Crossroado"),)),
              t(2, "Yatzo Fright Rato", "Activo", links=(Link("spotify", ("Yatzo", "Fright Rato"), "Activo"),)),
              t(3, "Yatzo", "Solo"))
    assert (res.tracks[1].artist, res.tracks[1].title) == ("Ghost Rido & Durso", "Crossroado")
    assert res.tracks[2].artist == "Yatzo & Fright Rato" and res.tracks[2].folder == "Yatzo"


def test_an_official_account_is_the_act_when_nothing_else_names_one():
    r = run(t(1, "", "Hijacko", links=(Link("soundcloud", ("Papo Stumpo Official",), "Hijacko", "Papo Stumpo Official"),))
            ).tracks[1]
    assert (r.artist, r.status) == ("Papo Stumpo", "look")


def test_a_name_wrapped_in_dashes_keeps_them():
    assert run(t(1, "K-Freqo & -Z-", "Soundless")).tracks[1].artist == "K-Freqo & -Z-"


def test_a_compilation_name_in_the_artist_field_is_no_artist():
    r = run(t(1, "V.A RETRO FUTURO V", "Part 2 - COMING SOON !")).tracks[1]
    assert r.status == "none"


def test_a_release_note_bracket_split_across_the_fields():
    res = run(t(1, "Initial Conditio [07", "Ethneomysto Vol. 2 - Mystic sound Records]",
                links=(Link("soundcloud", (), "x", "globulo"),)), t(2, "Globulo", "A"), t(3, "Globulo", "B"),
              t(4, "Crazy Timo (VA Extrasolo Planets", "Maniac Psycho Pro)"))
    assert (res.tracks[1].artist, res.tracks[1].title) == ("Globulo", "Initial Conditio")
    assert (res.tracks[4].status, res.tracks[4].title) == ("none", "Crazy Timo")


def test_r2_needs_a_title_side_act_that_is_not_also_a_title_and_stays_one_sided():
    refs = References(titles=(("evolvo", 2), ("infino", 3), ("quantumtrip", 1)))
    res = run(t(1, "Evolvo", "Infino"), t(2, "Infino", "A"), t(3, "Infino", "B"),
              t(4, "Quantum Trip", "Yatzo 183 bpm", bpm_grid=183.0), t(5, "Yatzo", "A"), t(6, "Yatzo", "B"), refs=refs)
    assert (res.tracks[1].artist, res.tracks[1].status) == ("Evolvo", "sure")
    assert (res.tracks[4].status, res.tracks[4].open_code) == ("open", "U1")  # one-sided: listed, not swapped


def test_an_account_that_fronts_other_albums_fronts_its_one_head_ep_too():
    comp = [t(i, "BioniForm", f"{h} - Track {i} (210)", "Module Combato 2", "BioniForm/Module Combato 2")
            for i, h in ((1, "Velkro"), (2, "Orbalo"), (3, "Kelvaro"))]
    ep = [t(i, "BioniForm", f"BioniSpirit - Song {i}", "EP PARALLELO", "BioniForm/EP PARALLELO") for i in (4, 5, 6)]
    res = run(*comp, *ep, t(7, "Velkro", "A"), t(8, "Orbalo", "B"), t(9, "Kelvaro", "C"), t(10, "BioniForm", "Solo"),
              t(11, "BioniForm", "Solo 2"), t(12, "BioniSpirit", "D"), refs=References(spotify=(("BioniForm", 2),)))
    for i in (4, 5, 6):
        assert (res.tracks[i].artist, res.tracks[i].status) == ("BioniSpirit", "look")


def test_a_version_bracket_artist_with_a_tempo_only_title_is_the_title():
    res = run(t(1, "Living Lifo, In The Nighto (RMX)", "286bpm - Free DL", bpm_grid=286.0),
              t(2, "Balago (Mushroom Brotho Tribute)", "195 FREE DOWNLOAD", bpm_grid=195.0))
    for i, title in ((1, "Living Lifo, In The Nighto (RMX)"), (2, "Balago (Mushroom Brotho Tribute)")):
        assert (res.tracks[i].status, res.tracks[i].title) == ("none", title)


# ---------------------------------------------------------------- ruleset names-4: release notes as parts of a title
def test_trailing_release_parts_leave_the_title_and_name_the_label_or_album():
    res = run(t(1, "Optico", "Twenty Fivo !! FREE DOWNLOAD !! Twenty Fivo EP 2016"),
              t(2, "Paranormo", "You And Mo (Atmo Remix)@PhantomoRec"),
              t(3, "Slato", "Ragged Daggo - EP - Trailer - OUT NOW (FREE DOWNLOAD)"),
              t(4, "Fullmo", "Barang Baiko Mexo Mix for YAPO REC. Preview"),
              t(5, "Funguo", "400 Dropo (Pixano Recordings)"), t(6, "Fictio", "Papillo l Out Now on Maharo Records"),
              t(7, "Uko Loomo", "Puito | Anthropo VA | Hekwo Records"),
              t(8, "Slido", "It's Just a Rido | Breathing Eartho | Woo-dog Recordings"),
              t(9, "Emulo", "Out Now Elemento EP - Shanti Planto"), t(10, "Kokto", "Perplexo of Infinito - Debut Album"),
              t(11, "Persianox", "Persian Friendo -VA Lost Civilo 2021(Ahooro Music)"),
              t(12, "Metahumo", "Bang Bango  _VA Breaking Techno _"), t(13, "Cosmo Wolfo", "Deep Feelo | @DoubSquo Records"),
              t(14, "Shadowo", "Insomnio Rec. VA_-_Phantom Tuno"),
              t(15, "Vasko", 'Dino 2.0 (Soon @"V.A. Shamanismo " [Popol Vuho Records])'))
    got = {i: res.tracks[i].title for i in res.tracks}
    assert got == {1: "Twenty Fivo", 2: "You And Mo (Atmo Remix)", 3: "Ragged Daggo", 4: "Barang Baiko Mexo Mix",
                   5: "400 Dropo", 6: "Papillo", 7: "Puito", 8: "It's Just a Rido", 9: "Shanti Planto",
                   10: "Perplexo of Infinito", 11: "Persian Friendo", 12: "Bang Bango", 13: "Deep Feelo",
                   14: "Phantom Tuno", 15: "Dino 2.0"}
    assert res.tracks[5].notes["label"] == "Pixano Recordings" and res.tracks[7].notes["label"] == "Hekwo Records"
    assert res.tracks[9].notes["album"] == "Elemento EP" and res.tracks[14].notes["label"] == "Insomnio Rec."
    assert all("D3" in res.tracks[i].rules for i in got)


def test_promo_technical_and_genre_brackets_leave_but_title_words_stay():
    assert titles(("Junxo", "Virtual Kisso(MV on Youtube)"), ("Spiro", "Jokes Aparto( lyrics in description) 220 bpm"),
                  ("Crono", "Bao Kao (DOWNLOAD LINK)"), ("Instro Core", "Gateo (New Single)(For New Tracks Visit Instro Core's Youtube Channel)"),
                  ("Techo Hitch", "No Chillo, Just Kill [192kb]"), ("Spiro", "Killing Down The Dayo 24bit ready to play!!! ;)"),
                  ("Phanero", "Soul Shreddo [228] FREE"), ("Zako", "Funk Masto (200Bpm) HITECH HARMONO VOL-1"),
                  ("Qawo", "Nostalgo (200bpm) Master by: Rasztec"), ("Maleo", "Spirito(Full Preview)Unrelease"),
                  ("Dreamo", "Galaxy's Childo [ downtempo / ambient / electronic ]"), ("Mandro", "Razro (Hybrid Hi-Tech)"),
                  ("Cybo", "Space Raco (220)(no-master)[FUNK]"), ("Maro", "Deep Into 205 Bpm  Hitech Dark Psytrance "),
                  ("Hilo", "Gayatro (with Sanskrit lyrics)"), ("Techo Hitch", "Mama Indio (Hybrid)"),
                  ("Velkro", "Nebulo - Psychedelic Trance"), ("Velkro", "R&B Nights (Ranjo &Ghosto Remix)"),
                  bpm_grid=205.0) == [
        "Virtual Kisso", "Jokes Aparto", "Bao Kao", "Gateo", "No Chillo, Just Kill", "Killing Down The Dayo",
        "Soul Shreddo", "Funk Masto", "Nostalgo", "Spirito", "Galaxy's Childo", "Razro", "Space Raco", "Deep Into",
        "Gayatro (with Sanskrit lyrics)", "Mama Indio (Hybrid)", "Nebulo - Psychedelic Trance",
        "R&B Nights (Ranjo & Ghosto Remix)"]


def test_a_tuning_in_hz_stays_in_the_title():
    assert titles(("Alien Chao", "Secret Codo (432Hz)"), ("Rajju Bobo", "Ecstatic Magico 432 Hz (Free DL)")) == [
        "Secret Codo (432Hz)", "Ecstatic Magico 432 Hz"]


def test_an_exclamation_mark_glued_to_the_title_stays_a_detached_one_before_promo_goes():
    assert titles(("Antimo", "H@zte a la V3rg@ P1nch3 P3rro!! (175 bpm)"), ("Zippo", "Electrifiyo!"),
                  ("Optico", "Life Is Simplo !! FREE DOWNLOAD!!"), ("Mandalo", "Welcome To The Showo ...NOW OUT!!")) == [
        "H@zte a la V3rg@ P1nch3 P3rro!!", "Electrifiyo!", "Life Is Simplo", "Welcome To The Showo"]


# ---------------------------------------------------------------- ruleset names-4: tempo and key
def test_tempo_and_key_together_leave_the_title_as_facts():
    res = run(t(1, "Dro Downs", "Full Powo (205D#)"), t(2, "Noovo", "Hitech Dramo / 200C#", bpm_grid=200.0),
              t(3, "Ajjo", "Ingraino (Lighto & Mano Rmx) 146A (Out Now !!)", bpm_grid=146.0),
              t(4, "Dzpo", "Sleepwalko (Free Download) B 146", bpm_grid=146.0),
              t(5, "Brainzo", 'Mechanic Bleepo (147G) "Reversible Records"'),
              t(6, "Jilo", "Unholo C# 145", bpm_grid=145.0), t(7, "Velkro", "Route 66 B", bpm_grid=140.0))
    got = [(res.tracks[i].title, res.tracks[i].tempo_hint, res.tracks[i].notes.get("key")) for i in range(1, 8)]
    assert got == [("Full Powo", "205", "D#"), ("Hitech Dramo", "200", "C#"),
                   ("Ingraino (Lighto & Mano Rmx)", "146", "A"), ("Sleepwalko", "146", "B"),
                   ("Mechanic Bleepo", "147", "G"), ("Unholo", "145", "C#"), ("Route 66 B", "", None)]


def test_ranges_lists_angles_glued_and_variable_tempos():
    res = run(t(1, "Impo", "Silence & Paino 173-200  (MASTERED BY KILLO)", bpm_analyzed=173.0),
              t(2, "Lenfo", "Spoiled Worm Juico 148 - 200", bpm_analyzed=148.0),
              t(3, "Kokto", "Enter the Voido [201-270-???] {demo sample}", bpm_grid=201.0),
              t(4, "Kokto", "Holy Mountaino 200/230/170/???", bpm_analyzed=200.0),
              t(5, "Sicko", "Who Cares For Titlo <180>", bpm_grid=180.0),
              t(6, "Sando", "kambo nahualo  (SANDO REMIX)220", bpm_grid=220.0),
              t(7, "Angro", "Perfect Happo (Ferro & Hypno Remix 180)", bpm_grid=180.0),
              t(8, "Parando", "What If Psycoro? (VARI_BPM)"),
              t(9, "Zeppo", "Hungarian Danco (145 - 160BPM Prog Trance)"),
              t(10, "Kopo", "Fuck The Ruleso!", bpm_grid=240.0), t(11, "Kopo", "240-250bpm - Preview", bpm_grid=240.0))
    got = [(res.tracks[i].title, res.tracks[i].tempo_hint) for i in range(1, 10)]
    assert got == [("Silence & Paino", "173"), ("Spoiled Worm Juico", "148"), ("Enter the Voido", "201"),
                   ("Holy Mountaino", "200"), ("Who Cares For Titlo", "180"), ("kambo nahualo (Sando REMIX)", "220"),
                   ("Perfect Happo (Ferro & Hypno Remix)", "180"), ("What If Psycoro?", ""),
                   ("Hungarian Danco", "145")]
    assert res.tracks[8].notes["tempo_note"] == "VARI BPM"


def test_a_number_after_a_preposition_belongs_to_the_title_and_is_stable():
    first = run(t(1, "Gotalo", "BELIEVE IN 200  200BPM", bpm_grid=200.0), t(2, "Worldo", "World 193", bpm_grid=193.0))
    assert [first.tracks[i].title for i in (1, 2)] == ["BELIEVE IN 200", "World"]
    again = run(t(1, "Gotalo", "BELIEVE IN 200", bpm_grid=200.0)).tracks[1]
    assert again.title == "BELIEVE IN 200"


def test_a_leading_number_that_matches_the_audio_is_a_tempo():
    res = run(t(1, "Velkro", "150 Desert Roado", bpm_grid=150.0), t(2, "Velkro", "177 BPM", bpm_grid=177.0),
              t(3, "Velkro", "150 Desert Roado", bpm_grid=120.0))
    assert (res.tracks[1].title, res.tracks[1].tempo_hint) == ("Desert Roado", "150")
    assert res.tracks[2].status == "open" and res.tracks[3].title == "150 Desert Roado"


def test_a_title_that_held_only_a_tempo_or_a_tempo_and_key_is_open():
    res = run(t(1, "Luzo", "[200]", bpm_grid=200.0), t(2, "Chemo", "145 E (PREVIEW SOFT MASTERING)", bpm_grid=145.0),
              t(3, "Iso", "209 (DL Below)", bpm_grid=209.0))
    for i in (1, 2, 3):
        assert (res.tracks[i].status, res.tracks[i].open_code) == ("open", "U2"), i
        assert res.tracks[i].tempo_hint, i


def test_a_tempo_or_key_in_the_artist_field_is_kept_as_a_fact():
    res = run(t(1, "G# 145", "Jilo - Om Shanto", bpm_grid=145.0), t(2, "Hyperdrivo 175", "Nightfall", bpm_analyzed=175.0),
              t(3, "280", "Babaji Meaning", bpm_grid=150.0), t(4, "Jilo", "Solo"))
    assert (res.tracks[1].artist, res.tracks[1].tempo_hint, res.tracks[1].notes.get("key")) == ("Jilo", "145", "G#")
    assert (res.tracks[2].artist, res.tracks[2].tempo_hint) == ("Hyperdrivo", "175")
    assert res.tracks[3].tempo_hint == ""


def test_the_tempo_after_a_rejoined_bracket_is_kept():
    r = run(t(1, "Killo-Sadhvo ( Bonus", "VA Interstellar Distracto )-220", bpm_analyzed=219.9,
              links=(Link("soundcloud", ("Killo",), "x", "Killo"),))).tracks[1]
    assert r.tempo_hint == "220"


def test_style_words_before_the_version_word_are_not_the_remixer():
    res = run(t(1, "Kaya Projo", "One Hundred Lighto - Groucho in Dub Remix"), t(2, "Bobbo", "R.a.M. 25 (Tribute Mix)"),
              t(3, "Ranjo", "Love Therapo (Ohno Limo Remix) - Re Edit 2018"),
              t(4, "Ranjo & Jilo", "Awayo (Henriko Camo Hi-Tech Remix)"))
    rem = {i: sorted(a.name for a in res.tracks[i].acts if a.role == "remixer") for i in range(1, 5)}
    assert rem == {1: ["Groucho"], 2: [], 3: ["Ohno Limo"], 4: ["Henriko Camo"]}

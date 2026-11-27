"""«Καθαρισμός ονομάτων»: rule tests for shapes met while measuring stage 1 on a library (invented names only)."""
from __future__ import annotations

from app.services.names import Decision, Link, References, TrackInput, resolve


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
    # names-4, the owner's answer 4: a 2-3 letter capital word inside a longer name keeps its capitals
    assert run(t(1, "DLX_ZuluTones", "A")).tracks[1].artist == "DLX ZuluTones"


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
    r = run(t(1, "Cosmu", "1 - 2 POLIZEO 190  FREE DOWNLOAD", bpm_grid=190.0)).tracks[1]
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
                  ("Xenro", "OMNO [Single 2022]"), ("Dairu", "CYANO [TX049]"),
                  ("Ghosto", "Crossroado (Official Audio).mp3"), ("Shivo", "Shivo Tandavo ( PsyTrance )"),
                  ("Virtuo", "Fair Storo 178 Bpm 🔊 Hitech Psytrance 2017 🎶 - YouTube"), ("Biomeko", "Trailer"),
                  ("Velkro", "Lab Sample 1367"), ("Velkro", "Friends (Raw Snippet)"), bpm_grid=190.0) == [
        "DayDreamo", "Across The Oceano 200", "Not Afraido", "OMNO", "CYANO", "Crossroado", "Shivo Tandavo",
        "Fair Storo", "Trailer", "Lab Sample 1367", "Friends"]  # names-7: «(Raw Snippet)» is a preview word


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
    r = run(t(1, "V.A RETRO VELURO V", "Part 2 - COMING SOON !")).tracks[1]
    assert r.status == "none"


def test_a_release_note_bracket_split_across_the_fields():
    res = run(t(1, "Initial Conditio [07", "Ethneomysto Vol. 2 - Mystic sound Records]",
                links=(Link("soundcloud", (), "x", "globulo"),)), t(2, "Globulo", "A"), t(3, "Globulo", "B"),
              t(4, "Crazy Timo (VA Extrasolo Planets", "Maniac Psycho Pro)"))
    assert (res.tracks[1].artist, res.tracks[1].title) == ("Globulo", "Initial Conditio")
    assert (res.tracks[4].status, res.tracks[4].title) == ("none", "Crazy Timo")


def test_r2_needs_a_title_side_act_that_is_not_also_a_title_and_stays_one_sided():
    refs = References(titles=(("evolvo", 2), ("infino", 3), ("quantartrip", 1)))
    res = run(t(1, "Evolvo", "Infino"), t(2, "Infino", "A"), t(3, "Infino", "B"),
              t(4, "Quantar Trip", "Yatzo 183 bpm", bpm_grid=183.0), t(5, "Yatzo", "A"), t(6, "Yatzo", "B"), refs=refs)
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
              t(11, "Persianux", "Persian Friendo -VA Lost Civilo 2021(Ahooro Music)"),
              t(12, "Metahumo", "Bang Bango  _VA Breaking Techno _"), t(13, "Cosmu Wolfo", "Deep Feelo | @DoubSquo Records"),
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
    # names-7: a range or list keeps every tempo; the version word goes with the re-spelled act in a capital bracket
    assert got == [("Silence & Paino", "173 | 200"), ("Spoiled Worm Juico", "148 | 200"), ("Enter the Voido", "201 | 270"),
                   ("Holy Mountaino", "200 | 230 | 170"), ("Who Cares For Titlo", "180"), ("kambo nahualo (Sando Remix)", "220"),
                   ("Perfect Happo (Ferro & Hypno Remix)", "180"), ("What If Psycoro?", ""),
                   ("Hungarian Danco", "145 | 160")]
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
    res = run(t(1, "Kayo Projo", "One Hundred Lighto - Groucho in Dub Remix"), t(2, "Bobbo", "R.a.M. 25 (Tribute Mix)"),
              t(3, "Ranjo", "Love Therapo (Ohno Limo Remix) - Re Edit 2018"),
              t(4, "Ranjo & Jilo", "Awayo (Henriko Camo Hi-Tech Remix)"))
    rem = {i: sorted(a.name for a in res.tracks[i].acts if a.role == "remixer") for i in range(1, 5)}
    assert rem == {1: ["Groucho"], 2: [], 3: ["Ohno Limo"], 4: ["Henriko Camo"]}


# ---------------------------------------------------------------- ruleset names-4: folders and list credits
def test_whole_credit_folder_only_for_name_joins_of_two_or_three_unknown_names():
    res = run(t(1, "Belto vs Yayano", "Beans"), t(2, "Luuno, X & Kozmo", "Shake"), t(3, "Arvo & Brino", "One"),
              t(4, "Arvo and Brino", "Two"), t(5, "Ceda, Dono, Eko, Fino", "Four"),
              t(6, "Gaso & Hino & Iko & Jono", "Five"))
    assert [res.tracks[i].folder for i in range(1, 7)] == ["Belto", "Luuno", "Arvo & Brino", "Arvo and Brino", "Ceda",
                                                           "Gaso"]


def test_a_solo_title_head_or_album_head_makes_a_name_known_alone():
    res = run(t(1, "Labelo Music", "Mapo Pandigo & Under Rooto - Storm", "Mapo Pandigo - Bio Sim", "L/Bio"),
              t(2, "Labelo Music", "Mapo Pandigo - Cave", "Mapo Pandigo - Bio Sim", "L/Bio"),
              t(3, "Labelo Music", "Mapo Pandigo & Jahvo - Tree", "Mapo Pandigo - Bio Sim", "L/Bio"))
    assert res.tracks[1].folder == "Mapo Pandigo"


def test_a_credit_with_the_act_set_of_an_album_credit_uses_that_folder():
    res = run(t(1, "Amoro & Siuo", "A", "Duo EP", "x/Duo EP"), t(2, "Amoro & Siuo", "B", "Duo EP", "x/Duo EP"),
              t(3, "Siuo & Amoro", "Single"), t(4, "Amoro", "Solo"), t(5, "Siuo", "Solo"))
    assert res.tracks[1].folder == "Amoro & Siuo" and res.tracks[3].folder == "Amoro & Siuo"
    assert "N12s" in res.tracks[3].rules


def test_a_spotify_entry_of_two_strong_solo_acts_is_two_acts():
    res = run(t(1, "Ranjo & Jilo", "Away"), t(2, "Ranjo", "A"), t(3, "Ranjo", "B"), t(4, "Jilo", "C"),
              t(5, "Abovo & Beyondo", "X"), refs=References(spotify=(("Ranjo & Jilo", 1), ("Abovo & Beyondo", 1))))
    assert res.tracks[1].folder == "Ranjo" and res.tracks[5].folder == "Abovo & Beyondo"


def test_a_folder_never_holds_a_free_bracket_a_quote_a_symbol_or_a_slash_between_names():
    res = run(t(1, "Maleo [The Endless Knot]", "Spirit"), t(2, "DJ Mandro “THE CHAMPAGNE”", "West"),
              t(3, "Spiralo/spirALTERO", "Unstoppable"), t(4, "AC/DC", "Thunder"), t(5, "Graco (DE)", "Electric"),
              t(6, "thomo[s]", "Lights"))
    assert [res.tracks[i].folder for i in range(1, 7)] == ["Maleo", "DJ Mandro", "Spiralo", "AC/DC", "Graco (DE)",
                                                           "Thomo[s]"]


def test_a_name_of_a_list_of_three_or_more_at_the_title_head_is_the_credit():
    lst = "Sexo, Siuo, Amoro, Lsmo, Croixo"
    res = run(t(1, lst, "Sexo - Dr Gonzo", "VA - Looney", "va/Looney"), t(2, lst, "Lsmo - Password", "VA - Looney", "va/Looney"),
              t(3, "Darko_Whispo", "Darko Whispo feat. Alpso & Narco -Esperanto"),
              t(4, "Reyo&Kjavo & Moglo", "Moglo - Earth (Reyo&Kjavo Remix)"))
    assert (res.tracks[1].artist, res.tracks[1].folder) == ("Sexo", "Sexo")
    assert res.tracks[2].artist == "Lsmo"
    assert res.tracks[3].artist == "Darko Whispo feat. Alpso, Narco" and res.tracks[3].title == "Esperanto"
    # names-7: «&» glued to letters on both sides is part of one name («Reyo&Kjavo»), as the remix bracket writes it
    assert res.tracks[4].artist == "Reyo&Kjavo & Moglo"
    assert [a.name for a in res.tracks[4].acts if a.role == "remixer"] == ["Reyo&Kjavo"]
    assert not any(s.rule == "R0" for s in res.tracks[4].trail)


# ---------------------------------------------------------------- ruleset names-4: readings
def test_a_cut_credit_takes_the_uploader_or_lists_the_one_library_partner():
    res = run(t(1, "& Conzo & Makumo", "Lost", links=(Link("soundcloud", (), "Lost", "Antonymo"),)),
              t(2, "Antonymo & Conzo", "A"), t(3, "Makumo & Antonymo", "B"),
              t(4, "& Vergo", "Bubble"), t(5, "Tengro & Vergo", "C"), t(6, "Vergo", "D"),
              t(7, "& Applo", "Dharma"), t(8, "Applo & Kopo", "E"), t(9, "Applo & Mindo", "F"))
    assert (res.tracks[1].artist, res.tracks[1].status) == ("Antonymo & Conzo & Makumo", "look")
    assert (res.tracks[4].status, res.tracks[4].open_code, res.tracks[4].artist) == ("open", "U12", "Vergo")
    assert any(o["code"] == "U12" and any("Tengro & Vergo" in x for x in o["options"]) for o in res.open_items)
    assert (res.tracks[7].artist, res.tracks[7].status) == ("Applo", "look")  # several partners: nothing to offer


def test_a_known_tag_act_against_a_known_head_act_shows_the_head_and_asks():
    base = [t(2, "Gotavo", "A"), t(3, "Gotavo", "B"), t(4, "Gotalo", "C"), t(5, "Gotalo", "D")]
    res = run(t(1, "Gotalo", "Gotavo - Mentalo"), *base)
    r = res.tracks[1]
    assert (r.artist, r.title, r.status, r.notes.get("tag_artist")) == ("Gotavo", "Mentalo", "look", "Gotalo")
    assert "A1h" in r.rules
    settled = run(t(1, "Gotalo", "Gotavo - Mentalo", links=(Link("spotify", ("Gotavo",), "Mentalo"),)), *base).tracks[1]
    # names-5: the owner's rule (the title's artist beats the uploader) explains every such track, the tag act noted
    assert settled.artist == "Gotavo" and "A1h" in settled.rules and settled.notes["tag_artist"] == "Gotalo"
    assert "δικός σου κανόνας" in settled.reason
    kept = resolve([t(1, "Gotalo", "Gotavo - Mentalo"), *base], References(),
                   [Decision("preference", "pref:tag_vs_head", "B")]).tracks[1]
    assert kept.artist == "Gotalo"


def test_the_artist_field_named_as_remixer_in_the_title_makes_the_head_the_original():
    res = run(t(1, "Rendo", "Headwo - Ariiek (Rendo rmx)"), t(2, "Martiano Arts", "ATIO - Sugar Drop (Maritano Arts Remix)"),
              t(3, "Mandro", "Luizo Lian - Tucum (Mandro, L3afo Remix)"))
    assert (res.tracks[1].title, res.tracks[1].notes["original"], res.tracks[1].status) == (
        "Ariiek (Rendo rmx)", ["Headwo"], "sure")
    assert (res.tracks[2].title, res.tracks[2].status) == ("Sugar Drop (Maritano Arts Remix)", "look")
    assert res.tracks[3].notes["original"] == ["Luizo Lian"]


def test_a_moved_field_that_opens_with_a_strong_act_names_the_original_artist():
    res = run(t(1, "Yatzo Brain Rolling", "MARCO Remix (195)", bpm_grid=195.0), t(2, "Yatzo", "A"), t(3, "Yatzo", "B"),
              t(4, "Marco", "C"))
    r = res.tracks[1]
    assert (r.artist, r.title, r.notes["original"]) == ("Marco", "Brain Rolling (Marco Remix)", ["Yatzo"])


def test_project_shapes_with_members():
    res = run(t(1, "Ticono", "Critical Choco (DJ Emoko and Ticono) - El Es Di"),
              t(2, "QAWO & Frenesi Herto (Latino Sauco)", "Cartoon"), t(3, "Supero (Kabo & Yasmo), Argono", "Overload"))
    assert (res.tracks[1].artist, res.tracks[1].title, res.tracks[1].status) == ("Critical Choco", "El Es Di", "look")
    assert res.tracks[1].notes["members"] == ["DJ Emoko", "Ticono"]
    assert (res.tracks[2].artist, res.tracks[2].status, res.tracks[2].folder) == ("Latino Sauco", "look", "Latino Sauco")
    assert res.tracks[3].artist == "Supero, Argono" and res.tracks[3].folder == "Supero"


def test_second_names_of_a_known_act_go_to_the_notes():
    res = run(t(1, "Conico Brazo (Psyko) & Futuvo", "Stairs"), t(2, "Conico Brazo", "A"),
              t(3, "Maleo [The Endless Knot]", "Spirit"), t(4, "Maleo", "B"),
              t(5, "Spiralo/spirALTERO", "Jokes"), t(6, "Spiralo", "C"),
              t(7, "🎹Yamako👹ヤマカシ", "Akumo"), t(8, "Twisted Kalo Free Like The Wind", "Pooja",
                                                  links=(Link("soundcloud", (), "Pooja", "twisted kalo"),)),
              t(9, "Twisted Kalo", "D"))
    got = {i: (res.tracks[i].artist, res.tracks[i].status) for i in (1, 3, 5, 7, 8)}
    assert got == {1: ("Conico Brazo & Futuvo", "look"), 3: ("Maleo", "look"), 5: ("Spiralo", "look"),
                   7: ("Yamako", "look"), 8: ("Twisted Kalo", "look")}
    assert res.tracks[5].notes["alias"] == ["spirALTERO"] and res.tracks[7].notes["alias"] == ["ヤマカシ"]


def test_a_compilation_album_or_a_compiled_by_title():
    res = run(t(1, "Abstro Sound", "WUBCO - Bloom [210]", "HiTech Lives [VA]"), t(2, "Wubco", "X"),
              t(3, "OVNI SHAMO 01", "Compiled by Kaayo & Amp Swampo"))
    assert (res.tracks[1].artist, res.tracks[1].title, res.tracks[1].status) == ("Wubco", "Bloom", "look")
    assert (res.tracks[3].status, res.tracks[3].open_code) == ("open", "U10")
    assert res.tracks[3].notes["compilers"] == ["Kaayo", "Amp Swampo"]


def test_unclear_credits_are_listed_not_guessed():
    res = run(t(1, "Shouto and Inner Como Meitei Sho", "Song - 185", bpm_grid=185.0), t(2, "Inner Como", "A"),
              t(3, "Inner Como", "B"), t(4, "Shouto", "C"), t(7, "Shouto", "D"),
              t(5, "Ingraino Insto, Daksino rmx", "Just a Ride remix"), t(6, "DMZ _ 5MEo", "Conversation"),
              t(8, "Ingraino Insto", "E"))
    assert (res.tracks[1].status, res.tracks[1].open_code) == ("open", "U6")
    assert (res.tracks[5].artist, res.tracks[5].title, res.tracks[5].status) == (
        "Ingraino Insto", "Just a Ride (Daksino Remix)", "look")
    assert (res.tracks[6].artist, res.tracks[6].status) == ("DMZ 5MEo", "look")


def test_the_rest_of_a_credit_at_the_end_of_a_title():
    res = run(t(1, "Kayro Live", "Soul Expanso -Vs Kodo"), t(2, "ProHo", "Hedwig's -Pro Ho & Jokro & Vigeno"))
    assert (res.tracks[1].artist, res.tracks[1].title) == ("Kayro Live vs Kodo", "Soul Expanso")
    assert (res.tracks[2].artist, res.tracks[2].title) == ("ProHo & Jokro & Vigeno", "Hedwig's")


def test_own_head_with_dj_or_written_in_another_script():
    res = run(t(1, "Mandro", "dj mandro - the sound"), t(2, "Kapsodos Filomenos", "Καψωδός Φιλομένος - Κορυφή"),
              t(3, "รครt๏к๏", "Sastoko-Regreciones"))
    assert [res.tracks[i].title for i in (1, 2, 3)] == ["the sound", "Κορυφή", "Regreciones"]
    assert res.tracks[3].artist == "Sastoko"  # the fancy-text letters fold to Latin; the Latin spelling is shown


# ---------------------------------------------------------------- ruleset names-4: spelling
def test_look_alike_letters_and_similar_names():
    killo = [t(i, "Killatko", "T") for i in range(2, 5)]
    res = run(t(1, "KillatΔko", "Summer Jam"), *killo, t(5, "EVƏRNOISO", "Eyes"), t(6, "Evernoiso", "F"),
              t(7, "Sekorkso", "Game"), *[t(i, "Sekorsko", "G") for i in range(8, 11)])
    assert (res.tracks[1].artist, res.tracks[1].status) == ("Killatko", "look") and "C5" in res.tracks[1].rules
    assert res.tracks[5].artist == "Evernoiso"
    assert res.tracks[7].artist == "Sekorkso" and res.tracks[7].status == "look" and "N19s" in res.tracks[7].rules


def test_casing_details():
    res = run(t(1, "kdd & modusmago", "Celestial"), t(2, "ΔukuFo/bill leo", "X"), t(3, "TrypOphObio", "Nostalgic"),
              t(4, "BionicFormo", "A"), t(5, "BionicFormo", "B"))
    assert res.tracks[1].artist == "Kdd & Modusmago"
    assert res.tracks[2].artist == "ΔukuFo/Bill Leo"
    assert (res.tracks[3].artist, res.tracks[3].status) == ("TrypOphObio", "look")
    assert res.tracks[4].status == "sure"


# ---------------------------------------------------------------- ruleset names-4: explanations
def test_every_changed_field_has_a_rule_and_a_greek_reason():
    res = run(t(1, "Cosmu Vs Gotalo", "Dance"), t(2, "Velkro", "Song", previous_artist="Velkro & Orbo",
                                                   previous_source_artist="spotify"),
              t(3, "", "Lonely", folder="Unknown Artist/Unknown Album"), t(4, "Velkro ", "Song  Two"))
    assert "N15w" in res.tracks[1].rules and "μικρά" in res.tracks[1].reason
    assert "R0" in res.tracks[2].rules and "Spotify" in res.tracks[2].reason
    assert res.tracks[3].status == "none" and res.tracks[3].reason
    assert res.tracks[4].reason  # spacing only: the D2 text is printed


def test_a_known_act_with_a_title_of_only_a_tempo_has_no_title():
    res = run(t(1, "Chemo Drivo", "145 E (PREVIEW)", bpm_grid=145.0), t(2, "Chemo Drivo", "A"), t(3, "Chemo Drivo", "B"))
    assert (res.tracks[1].status, res.tracks[1].open_code, res.tracks[1].artist) == ("open", "U13", "Chemo Drivo")


def test_a_label_presents_an_act():
    r = run(t(1, "AstroFono présente : OVNO Y", "Abduxo"), t(2, "Ovno Y", "Solo")).tracks[1]
    assert (r.artist, r.status, r.notes["label"]) == ("Ovno Y", "look", "AstroFono")
    # names-5: a presented name that is no known act (a series or a compilation) names no act: open U10, as written
    r = run(t(1, "AstroFono présente : OVNO X", "Abduxo")).tracks[1]
    assert (r.artist, r.status, r.open_code) == ("AstroFono présente : OVNO X", "open", "U10")


def test_a_tempo_between_the_title_and_the_rest_of_the_credit():
    r = run(t(1, "KETO.", "Gucci Gango 203 Keto Vs Liquido E.T. _ PRV", bpm_analyzed=203.0)).tracks[1]
    assert (r.artist, r.title, r.tempo_hint) == ("Keto vs Liquido E.T.", "Gucci Gango", "203")


def test_release_notes_keep_what_they_name():
    res = run(t(1, "Fictio", "Papillo l Out Now on Mahareto Records"),
              t(2, "Instro Core", "Gateo (New Single)(For New Tracks Visit Instro Core's Youtube Channel)"),
              t(3, "Slato", "Ragged Daggo - EP - Trailer"))
    assert res.tracks[1].notes["label"] == "Mahareto Records"
    assert res.tracks[2].title == "Gateo"
    assert res.tracks[3].notes["album"] == "Ragged Daggo EP"


# ---------------------------------------------------------------- ruleset names-5: title junk and release notes
def test_video_promo_and_premiere_brackets_and_separators_leave_the_title():
    res = run(t(1, "Astrio", "Sonico Specio - Brokeno Love  [Video Clip / 8K]"),
              t(2, "Turbo Kevo", "TAINTO LOVE (OFFICIAL VISUALIZER)"),
              t(3, "Gaddo", "Vanillo Soul [Aquatico Collective Premiere]"),
              t(4, "Hybro Machines", "Psychokillo FREE DOWNLOAD > COMPRAR"),
              t(5, "Acido Sphere", "Indiano Spirit (Original Mix)[FREE DL AU] Clique Comprar"),
              t(6, "Synthexo", "Embraco Flaws (Original Mix) *10K FREE DOWNLOAD*"),
              t(7, "Hentai Xando", "in heat. <3"), t(8, "Kayo Mo", "Fello (Orginal Mix)"))
    assert [res.tracks[i].title for i in range(1, 9)] == [
        "Sonico Specio - Brokeno Love", "TAINTO LOVE", "Vanillo Soul", "Psychokillo", "Indiano Spirit", "Embraco Flaws",
        "in heat.", "Fello"]


def test_labels_after_out_now_released_by_and_at_signs_are_kept_as_notes():
    res = run(t(1, "Poxo", "Peaceo  >> Out Now >> Bluo Tunes"), t(2, "Acquo", "Acrosso Skies****(released by Minuso32rec)****"),
              t(3, "Fungo Funk", "Grato Funk @ Sango Recs."), t(4, "Pulso", "CRONO | OUT NOW V.A   M O N T E 2024"))
    assert [(res.tracks[i].title, res.tracks[i].notes.get("label")) for i in (1, 2, 3)] == [
        ("Peaceo", "Bluo Tunes"), ("Acrosso Skies", "Minuso32rec"), ("Grato Funk", "Sango Recs.")]
    assert res.tracks[4].title == "CRONO" and res.tracks[4].notes["album"].startswith("V.A")


def test_album_notes_keep_only_the_release_name():
    res = run(t(1, "Instro Core", "Gateo (New Single)(For New Tracks Visit Instro Core's Youtube Channel)"),
              t(2, "Forbo", "Incarno (COSMU MYTHO VA) Compiled by Anubo"), t(3, "Dropo", "Dancino In Streets (Out soon...)"),
              t(4, "Lunato", "Califo Dreaming [187] Out on Peyo Crew Label Album \"Coming Soon\"", bpm_grid=187.0),
              t(5, "Slato", "Raggo Daggo - EP - Trailer"))
    assert "album" not in res.tracks[1].notes and res.tracks[1].title == "Gateo"
    assert (res.tracks[2].notes["album"], res.tracks[2].notes["compilers"]) == ("COSMU MYTHO VA", ["Anubo"])
    assert "album" not in res.tracks[3].notes
    assert res.tracks[4].notes["label"] == "Peyo Crew Label"
    assert res.tracks[5].notes["album"] == "Raggo Daggo EP"


def test_a_title_that_is_only_a_release_note_held_no_title():
    r = run(t(1, "Mado Karo", "Released on album 'Whispo In The Darko'",
              links=(Link("soundcloud", (), "Mado Karo - Released on album 'Whispo In The Darko'", "Lunato Insom"),))).tracks[1]
    assert (r.artist, r.title, r.status, r.notes["album"]) == ("Lunato Insom", "Mado Karo", "look", "Whispo In The Darko")
    assert "N21s" in r.rules and "«Lunato Insom»" in r.reason  # the account is named


def test_tempo_in_a_demo_bracket_or_glued_to_a_clip_marker():
    res = run(t(1, "Astro Logo", "The World of Maro (demo 207)", bpm_grid=207.0),
              t(2, "Astro Logo", "No Namo 200~clip", bpm_grid=200.0))
    assert (res.tracks[1].title, res.tracks[1].tempo_hint) == ("The World of Maro (demo)", "207")
    assert (res.tracks[2].title, res.tracks[2].tempo_hint) == ("No Namo", "200")


def test_a_whole_bracket_goes_or_nothing_and_volumes_and_glued_master_tails_are_notes():
    res = run(t(1, "Ymbo", "Acapo Gold (-6db no master)"), t(2, "Applo", "Dharmo [CRAZO LESSONS VOL.3]"),
              t(3, "Sastok", "Regreco -Master infernalo"), t(4, "Rawo", "Master Plugo"))
    assert res.tracks[1].title == "Acapo Gold" and res.tracks[1].status != "open"
    assert (res.tracks[2].title, res.tracks[2].notes["album"]) == ("Dharmo", "CRAZO LESSONS VOL.3")
    assert res.tracks[3].title == "Regreco" and res.tracks[4].title == "Master Plugo"


def test_a_version_word_alone_after_a_dash_goes_in_brackets():
    res = run(t(1, "Angro Luna", "Moono Riders - 226 - Demo", bpm_grid=226.0), t(2, "Furio", "Funko It! Damn! Mash - Up"),
              t(3, "Killo", "Solaro Agents (EP) -> Promo Mix"), t(4, "Velko", "Multo - Dimensional"))
    assert [res.tracks[i].title for i in range(1, 5)] == ["Moono Riders (Demo)", "Funko It! Damn! (Mash-Up)",
                                                         "Solaro Agents (EP) (Promo Mix)", "Multo - Dimensional"]


def test_a_year_at_the_end_of_a_title_is_kept_and_asked():
    res = run(t(1, "Snapdro", "Leviatho Mix - 2020"), t(2, "Marco", "GO Flowo [2022]"), t(3, "Ranjo", "Love (Re Edit 2018)"),
              t(4, "Velko", "Coffeo (Updated 2023)"), t(5, "Velko", "1991"), t(6, "Velko", "Greco 2020 158", bpm_grid=74.0))
    for i in (1, 2):
        assert res.tracks[i].status == "look" and "D3y" in res.tracks[i].rules
    assert [res.tracks[i].title for i in (1, 2)] == ["Leviatho Mix - 2020", "GO Flowo [2022]"]
    assert not any("D3y" in res.tracks[i].rules for i in (3, 4, 5, 6))


def test_the_uploaders_initials_in_a_final_bracket_are_a_note():
    r = run(t(1, "Ramaro", "Synthetico Sektor 188 BPM - [MxM]", bpm_grid=188.0,
              links=(Link("soundcloud", (), "Ramaro - Synthetico Sektor", "Mangeko Musico"),))).tracks[1]
    assert (r.title, r.status, r.notes["label"]) == ("Synthetico Sektor", "look", "Mangeko Musico")


# ---------------------------------------------------------------- ruleset names-5: artist fields
def test_spaced_letters_crew_brackets_and_kaomoji():
    res = run(t(1, "R h a ú m o [ Katao | Strupo Freak Crew ]", "NN"), t(2, "blushoʕ ꈍᴥꈍʔ", "absence."),
              t(3, "EVƏRNOISO", "Eyes"))
    assert (res.tracks[1].artist, res.tracks[1].folder) == ("Rhaúmo", "Rhaúmo")
    assert res.tracks[1].notes["tag"] == ["Katao | Strupo Freak Crew"] and "N0s" in res.tracks[1].rules
    assert res.tracks[2].artist == "Blusho" and res.tracks[3].artist == "Evərnoiso"


def test_a_glued_slash_list_of_the_account_is_one_act_with_other_names():
    res = run(t(1, "Spiro/spirALTO", "Unstop", links=(Link("soundcloud", ("Spiro",), "Unstop", "Spiro/Magico/spirALTO"),)),
              t(2, "Δuko/Culto Crasho/bill leo", "Δ Tributo To Techno", links=(
                  Link("soundcloud", (), "Δ Tributo To Techno", "Δuko/Culto Crasho/bill leo"),)),
              t(3, "Jilo/Kleyo/Parro Nebo", "Mystiqo", links=(
                  Link("soundcloud", ("Jilo",), "Jilo, Parro Nebo, Kleyo - Mystiqo", "Jilo"),)),
              t(4, "Kleyo", "A"), t(5, "Parro Nebo", "B"), t(6, "Jilo", "C"))
    assert (res.tracks[1].artist, res.tracks[1].notes["alias"]) == ("Spiro", ["spirALTO"])
    assert res.tracks[2].artist == "Δuko" and res.tracks[2].title == "Tributo To Techno"
    assert res.tracks[3].artist == "Jilo / Kleyo / Parro Nebo"


def test_a_label_presenting_a_series_and_a_credit_of_space_joined_acts():
    res = run(t(1, "Atrio Tengo Ajjo", "Rift"), *[t(i, n, "X") for i, n in ((2, "Atrio"), (3, "Atrio"), (4, "Tengo"),
                                                                        (5, "Tengo"), (6, "Ajjo"), (7, "Ajjo"))])
    assert (res.tracks[1].artist, res.tracks[1].status, res.tracks[1].folder) == ("Atrio & Tengo & Ajjo", "look", "Atrio")


def test_a_name_cut_at_its_hyphen_across_the_two_fields_is_joined_back():
    res = run(t(1, "Ketko X K", "Freqo Interstellar"), t(2, "K-Freqo", "A"), t(3, "K-Freqo", "B"), t(4, "Ketko", "C"),
              t(5, "Cirquo & V", "Lamo - Orbo"), t(6, "Q&V", "Tango"), t(7, "Modulo Viro, R2", "Lamino - Beat"),
              t(8, "SI", "MOONO VS SIMPLO - MONSTRO", links=(Link("soundcloud", (), "SI - MOONO", "Si-Moono Official"),)))
    assert (res.tracks[1].artist, res.tracks[1].title, res.tracks[1].status) == ("Ketko x K-Freqo", "Interstellar", "look")
    assert (res.tracks[5].artist, res.tracks[5].title) == ("Cirquo & V-Lamo", "Orbo")
    assert res.tracks[6].artist == "Q&V"  # names-7: «&» glued on both sides is one name
    assert res.tracks[7].title == "Lamino - Beat"
    assert (res.tracks[8].artist, res.tracks[8].title) == ("Si-moono vs Simplo", "MONSTRO")  # generated: lower after a hyphen


def test_short_capital_parts_are_flattened_and_asked():
    res = run(t(1, "MarcY, Saivo", "Trip"), t(2, "KDrewo", "Last"), t(3, "Synthexo & LevelUPO", "Inner"))
    assert [res.tracks[i].artist for i in (1, 2, 3)] == ["Marcy, Saivo", "Kdrewo", "Synthexo & Levelupo"]
    assert all("N2c" in res.tracks[i].rules and res.tracks[i].status == "look" for i in (1, 2, 3))
    assert {a["doubt"] for a in res.acts if a["key"] in ("marcy", "kdrewo", "levelupo")} == {"U5c"}
    assert not any(o["kind"] == "spelling" and o["scope"] in ("act:marcy", "act:kdrewo") for o in res.open_items)


# ---------------------------------------------------------------- ruleset names-5: readings
def test_a_title_credit_with_one_strong_act_swaps_with_a_title_like_artist_field():
    res = run(t(1, "Mystico Wonder", "OREMO & YUKO"), t(2, "Oremo", "A"), t(3, "Oremo", "B"),
              t(4, "02 Ceremono Of Relo", "OREMO"), t(5, "Yebo, Darko Noto", "Soundo & Silo"), t(6, "Soundo", "C"),
              t(7, "Soundo", "D"), t(8, "Holo Madness", "Ricko & Madnesso OUT NOW!!"))
    assert (res.tracks[1].artist, res.tracks[1].title, res.tracks[1].status) == ("Oremo & Yuko", "Mystico Wonder", "look")
    assert (res.tracks[4].artist, res.tracks[4].title) == ("Oremo", "Ceremono Of Relo")
    assert (res.tracks[5].artist, res.tracks[5].title) == ("Yebo, Darko Noto", "Soundo & Silo")
    assert res.tracks[8].artist == "Holo Madness"


def test_the_own_act_at_the_end_of_a_title_leaves_it():
    res = run(t(1, "Davo Starf", "Big Chillo_Davo Starf (Whitebo Remix)"), t(2, "Davo Starf", "Soma Dreamo - Davo Starf"),
              t(3, "KaYo", "KAYO_202bpm trip_EP Modern Primo", bpm_grid=202.0))
    assert [res.tracks[i].title for i in (1, 2, 3)] == ["Big Chillo (Whitebo Remix)", "Soma Dreamo", "trip"]
    assert res.tracks[3].notes["album"] == "EP Modern Primo"


def test_a_title_tail_that_is_the_uploading_account_is_the_artist():
    r = run(t(1, "2", "Digito Wave - Fasto Line", links=(Link("soundcloud", (), "2 - Digito Wave - Fasto Line", "Fasto Line"),))
            ).tracks[1]
    assert (r.artist, r.title, r.status) == ("Fasto Line", "Digito Wave", "look") and "A1ru" in r.rules


def test_a_cut_credit_whose_soundcloud_title_is_cut_the_same_way_takes_the_account():
    r = run(t(1, "& MinDelvo", "D=4 - Epsilo", links=(Link("soundcloud", (), "& MinDelvo - D=4 - Epsilo", "Orango Buto"),)),
            t(2, "MinDelvo", "A")).tracks[1]
    assert (r.artist, r.status) == ("Orango Buto & MinDelvo", "look") and "A2fs" in r.rules


def test_a_known_act_glued_at_the_head_under_another_known_act():
    res = run(t(1, "Divino Mantro", "Critico Freako-Coppo Suit"), t(2, "Critico Freako", "A"), t(3, "Critico Freako", "B"),
              t(4, "Divino Mantro", "C"))
    r = res.tracks[1]
    assert (r.artist, r.title, r.status, r.notes["tag_artist"]) == ("Critico Freako", "Coppo Suit", "look", "Divino Mantro")
    assert "A1h" in r.rules


def test_mix_names_are_remixers_only_when_they_are_acts():
    res = run(t(1, "Pranao", "Breako Civo [Back To Eartho Mix]"), t(2, "Kopo", "Catao (Album Preview Mix)"),
              t(3, "Mando", "Miro (Full Version)"), t(4, "Davo", "Bigo (Whitebo Remix)"), t(5, "Davo", "Smallo (Kelvo Mix)"),
              t(6, "Kelvo", "Solo"))
    roles = {i: {a.name for a in res.tracks[i].acts if a.role == "remixer"} for i in range(1, 6)}
    assert roles == {1: set(), 2: set(), 3: set(), 4: {"Whitebo"}, 5: {"Kelvo"}}
    assert "N10r" in res.tracks[4].rules and "N10r" not in res.tracks[1].rules


def test_whole_credit_folders_are_asked_and_known_alone_counts_accounts_and_solo_tracks():
    res = run(t(1, "Hermo & Cygno", "Meat"), t(2, "ALFO & Munro", "Disaster", links=(Link("soundcloud", ("ALFO",), "D", "ALFO"),)),
              t(3, "", "Shantyro- (Munro Original Mix)"))
    assert (res.tracks[1].folder, res.tracks[1].status) == ("Hermo & Cygno", "look") and "N25q" in res.tracks[1].rules
    assert res.tracks[2].folder == "Alfo"


# ---------------------------------------------------------------- ruleset names-5: spelling and explanations
def test_similar_names_with_the_dj_or_a_featured_name_are_listed():
    res = run(t(1, "Antmill & The Hermo", "S"), t(2, "Tengo & Hermo", "A"), t(3, "DJ Mandro", "W"),
              *[t(i, "Mandro", "X") for i in range(4, 7)], t(7, "Alieno feat. Spaceshimpo", "L"),
              *[t(i, "SpaceChimpo", "Y") for i in range(8, 11)])
    assert all("N19s" in res.tracks[i].rules and res.tracks[i].status == "look" for i in (1, 2, 3, 7))


def test_every_change_says_why_names_5():
    res = run(t(1, "Black Out Recordo", "Marco & Sephro`s Paradox - Explosio (240Bpm)", "Marco - Harmo", "B/H", bpm_grid=240.0),
              t(2, "Black Out Recordo", "Velko - Two", "Marco - Harmo", "B/H"), t(3, "Velko", "Solo"),
              t(4, "4. Darqo", "Vah", previous_artist="Darqo", previous_source_artist="scanner"),
              t(5, "Trimo (Sonic Loom Musico)", "Neuro", previous_artist="TRIMO", previous_source_artist="scanner"),
              t(6, "Audio, Arco, Darko", "Infinito Collo - Wormo", "Infinito Collo - Space", "D/I"),
              t(7, "Audio, Arco, Darko", "Infinito Collo - Stars", "Infinito Collo - Space", "D/I"))
    assert "D0" in res.tracks[1].rules
    assert "A3a" in res.tracks[4].rules and "ονόματος καλλιτέχνη" in res.tracks[4].reason
    assert "R0" in res.tracks[5].rules and "«TRIMO»" in res.tracks[5].reason
    assert res.tracks[6].notes["tag_artist"] == "Audio, Arco, Darko" and "N15" not in res.tracks[6].rules
    assert "N24s" in run(t(8, "Velko", "Song", folder="Downloads/x")).tracks[8].rules


# ---------------------------------------------------------------- ruleset names-6
def test_join_word_e_splits_only_with_the_evidence_of_and():
    res = run(t(1, "Lunaro E Vespo", "Song"), *[t(i, "Lunaro", f"L{i}") for i in (2, 3)],
              *[t(i, "Vespo", f"V{i}") for i in (4, 5)], t(6, "Tempo E Lumo", "Quiet"))
    assert (res.tracks[1].artist, res.tracks[1].folder) == ("Lunaro e Vespo", "Lunaro")
    assert [a.name for a in res.tracks[1].acts if a.role in ("primary", "collaborator")] == ["Lunaro", "Vespo"]
    assert res.tracks[6].artist == "Tempo E Lumo"  # no part is a known act: one name


def test_a_tied_vote_keeps_short_capitals_by_answer_3():
    res = run(t(1, "QOR", "A"), t(2, "QOR", "B"), t(3, "Qor", "C"), t(4, "Qor", "D"))
    assert {res.tracks[i].artist for i in (1, 2, 3, 4)} == {"QOR"}
    assert "C2k" in res.tracks[3].rules and "απάντησή σου 3" in res.tracks[3].reason


def test_a_title_never_shouts_more_than_today():
    sp = (Link("spotify", ("Velkro",), "Infino"),)
    res = run(t(1, "Velkro", "INFINO", links=sp, previous_title="Infino", previous_source_title="spotify"),
              t(2, "Velkro", "GALAXA OF CHAOS", previous_title="Galaxa of Chaos", previous_source_title="scanner"),
              t(3, "Velkro", "LOUD ONE"))
    assert [res.tracks[i].title for i in (1, 2, 3)] == ["Infino", "Galaxa of Chaos", "LOUD ONE"]
    assert "N30" in res.tracks[1].rules and "Spotify" in res.tracks[1].reason and "R0" not in res.tracks[1].rules


def test_nothing_that_leaves_a_title_vanishes():
    res = run(t(1, "Zarvo", "Moon Drift (Preview)"), t(2, "Zarvo", "Moon Rise (Free Download)"),
              t(3, "Zarvo", "Moon Fall (Kelvo Records)"), t(4, "Zarvo", "Moon Set (Mastered By Brenox)"),
              t(5, "Zarvo", "Sun Up (Out Now on Drumvo Records)"), t(6, "Zarvo", "Moon Rox [Drumvo]"),
              t(7, "Zarvo", "Sun Down - EP Trailer"))
    r = res.tracks
    assert (r[1].title, r[1].notes["preview"], r[1].status) == ("Moon Drift", ["Preview"], "sure")
    assert "D3p" in r[1].rules and "προεπισκόπηση" in r[1].reason
    assert (r[2].title, r[2].notes["removed"]) == ("Moon Rise", ["Free Download"])
    assert (r[3].title, r[3].notes["label"]) == ("Moon Fall", "Kelvo Records")
    assert (r[4].title, r[4].notes["removed"], r[4].status) == ("Moon Set", ["Mastered By Brenox"], "look")
    assert "D3c" in r[4].rules
    assert (r[6].title, r[6].notes["label"]) == ("Moon Rox", "Drumvo") and "D3l" in r[6].rules
    assert r[7].title == "Sun Down" and r[7].notes["preview"] == ["EP Trailer"]
    # a bracket the library knows as no label stays
    assert run(t(8, "Zarvo", "Moon Rox [Drumvo]")).tracks[8].title == "Moon Rox [Drumvo]"


def test_every_step_has_a_true_sentence_names_6():
    from app.services.names.explain import text_of
    res = run(t(1, "Velo", "Velo Song !"), t(2, "Zarvo", "Dusk (DRUMVO Remix)"), *[t(i, "Drumvo", "X") for i in (3, 4)],
              t(5, "Velo", "Song(2021 Remake)"))
    assert "D3" not in res.tracks[1].rules and "D2" in res.tracks[1].rules and "«!»" in res.tracks[1].reason
    assert "«DRUMVO»" in res.tracks[2].reason and "«Drumvo»" in res.tracks[2].reason
    for r in res.tracks.values():
        for s in r.trail:
            assert text_of(s) and text_of(s) in r.reason, (r.id, s)


def test_loose_track_folders_are_the_callers_setting():
    tracks = [t(1, "Velo", "A", "Same Album", "[Loosey] Trance"), t(2, "Mira", "B", "Same Album", "[Loosey] Trance")]
    assert resolve(tracks, References(), [])  # no word is built in: the folder is an ordinary one
    grouped = resolve(tracks, References(), [])
    loose = resolve(tracks, References(loose_folders=("loosey",)), [])
    assert any(a["tracks"] == [1, 2] for a in grouped.albums) and not loose.albums


# ---------------------------------------------------------------- ruleset names-7: the owner's answers as data
def answered(*pairs):
    return [Decision("preference", scope, letter) for scope, letter in pairs]


def test_casing_answers_keep_the_styling_the_artist_chose_and_defaults_stay():
    tracks = [t(1, "VelX", "A"), t(2, "KoRu", "B"), t(3, "YMBQ", "C"), t(4, "COSMU", "D"), t(5, "ZaKaPSyQ", "E"),
              t(6, "kiiRaTo", "F")]
    plain = resolve(tracks, References(), [])
    assert [plain.tracks[i].artist for i in range(1, 7)] == ["Velx", "Koru", "Ymbq", "Cosmu", "Zakapsyq", "Kiirato"]
    owner = resolve(tracks, References(), answered(("pref:short_part_capitals", "B"), ("pref:alternating_case", "B"),
                                                   ("pref:y_only_capitals", "B"), ("pref:stylised_capitals", "A")))
    # names written all in capitals still take the first-capital rule; a styled word starting in lower case gets a
    # capital first letter only
    assert [owner.tracks[i].artist for i in range(1, 7)] == ["VelX", "KoRu", "YMBQ", "Cosmu", "ZaKaPSyQ", "KiiRaTo"]
    assert "N2c" not in owner.tracks[1].rules and owner.tracks[1].status == "sure"


def test_an_answer_the_engine_does_not_act_on_leaves_the_default():
    res = resolve([t(1, "VelX", "A")], References(), answered(("pref:short_part_capitals", "maybe")))
    assert res.tracks[1].artist == "Velx" and "N2c" in res.tracks[1].rules


def test_answered_pattern_rows_settle_their_look_and_say_so():
    tracks = [t(1, "Zarvo", "Lullabo 2012"), t(2, "Velo", "Rise", links=(Link("spotify", ("Velo", "Orbo"), "Rise"),))]
    open_ = resolve(tracks, References(), [])
    assert [open_.tracks[i].status for i in (1, 2)] == ["look", "look"]
    done = resolve(tracks, References(), answered(("pref:year_at_title_end", "A"),
                                                  ("pref:file_credit_over_spotify", "A")))
    assert [done.tracks[i].status for i in (1, 2)] == ["sure", "sure"]
    assert done.tracks[1].title == "Lullabo 2012" and "δική σου απάντηση" in done.tracks[1].reason
    assert "N23diff" in done.tracks[2].rules


def test_pair_answers_merge_same_names_and_never_ask_different_ones_again():
    base = [t(i, "Zarvoon", f"T{i}") for i in range(2, 6)] + [t(i, "Mirelo", f"M{i}") for i in range(6, 10)]
    tracks = [t(1, "Zarvon", "Solo"), t(10, "Mireli", "Other")] + base
    asked = resolve(tracks, References(), [])
    assert "N19s" in asked.tracks[1].rules and "N19s" in asked.tracks[10].rules
    res = resolve(tracks, References(), [Decision("same_act", "pair:zarvon|zarvoon", "yes", provisional=True),
                                         Decision("same_act", "pair:mireli|mirelo", "no")])
    r = res.tracks[1]
    assert (r.artist, r.folder, r.status) == ("Zarvoon", "Zarvoon", "look") and "N19h" in r.rules
    assert "προσωρινή" in r.reason
    assert res.tracks[10].artist == "Mireli" and "N19s" not in res.tracks[10].rules
    sure = resolve(tracks, References(), [Decision("same_act", "pair:zarvon|zarvoon", "yes")]).tracks[1]
    assert sure.status == "sure" and sure.artist == "Zarvoon"


def test_label_names_leave_the_artist_as_the_label_fact():
    acts = [t(i, "Velkro", f"S{i}") for i in (2, 3)]
    res = run(t(1, "Lumo Records", "Velkro - Tide"), t(4, "Zarvo (Lumo Records)", "Dawn"), *acts)
    assert (res.tracks[1].artist, res.tracks[1].notes["label"]) == ("Velkro", "Lumo Records")
    assert (res.tracks[4].artist, res.tracks[4].notes["label"]) == ("Zarvo", "Lumo Records")
    assert "D3a" in res.tracks[1].rules and "«Lumo Records»" in res.tracks[1].reason


def test_a_not_act_answer_makes_a_channel_a_label():
    tracks = [t(1, "Univo Psy", "Velkro - Tide"), t(2, "Velkro", "A"), t(3, "Velkro", "B")]
    res = resolve(tracks, References(), [Decision("not_act", "name:univopsy", "label")])
    assert res.tracks[1].artist == "Velkro" and res.tracks[1].notes["label"] == "Univo Psy"
    pattern = resolve([t(1, "QX Music", "Song", links=(Link("soundcloud", (), "Song", "Velkro"),))], References(),
                      [Decision("not_act", "name:*music", "label")])
    assert pattern.tracks[1].notes.get("label") == "QX Music"  # written with its capitals


def test_kept_notes_are_whole_phrases_and_facts_carry_no_promo():
    res = run(t(1, "Velo", "Active Meditato (190)(no-master)", bpm_grid=190.0), t(2, "Velo", "Fiat Luxo [24]"),
              t(3, "Velo", "Loopbacko [BMSX 2019] | Full Track!"), t(4, "Velo", "Angry Nerdo (VA RENEWED FORESTO) by ABSOLVO"),
              t(5, "Velo", "What Happens Aftero (Original Mix)OUT NOW ON ALIENO RECORDS"),
              t(6, "Velo", "Beautiful Lusto (200)on V.A. Over 9000 by Electromoon Records", bpm_grid=200.0),
              t(7, "Velo", "creamy screamo(buy https://velo.bandcamp.com/album/unreleased-2013-2019)"),
              t(8, "Velo", "Monko Prayer 158-160 BPM"), t(9, "Velo", "By Your Braino #152", bpm_analyzed=152.0))
    r = res.tracks
    assert (r[1].title, r[1].notes["removed"]) == ("Active Meditato", ["no-master"])
    assert (r[2].title, r[2].notes["removed"]) == ("Fiat Luxo", ["24"])
    assert r[3].notes["removed"][0] == "BMSX 2019"
    assert r[4].title == "Angry Nerdo" and "by ABSOLVO" in r[4].notes["removed"]
    assert r[5].notes["label"] == "ALIENO RECORDS"
    assert (r[6].notes["label"], r[6].notes["album"]) == ("Electromoon Records", "V.A. Over 9000")
    assert "album" not in r[7].notes and r[7].notes["removed"] == ["buy https://velo.bandcamp.com/album/unreleased-2013-2019"]
    assert r[8].tempo_hint == "158 | 160"
    assert (r[9].title, r[9].tempo_hint) == ("By Your Braino", "152")


def test_r0_says_what_the_tag_writes_only_when_it_shows_it():
    r = run(t(1, "Holo, Luno, & Popo", "Song", previous_artist="Holo, Luno, & Popo",
              previous_source_artist="scanner")).tracks[1]
    assert r.artist == "Holo, Luno & Popo" and "R0" in r.rules
    assert "όπως διαβάζεται από το tag του αρχείου («Holo, Luno, & Popo»)" in r.reason
    assert "ό,τι γράφει το tag" not in r.reason


def test_acronyms_and_version_words_in_quieted_titles():
    res = run(t(1, "Bumblo", "4K Deepo", previous_title="4k Deepo"), t(2, "Creedo", "PUSH UPO (ROSE WELLO REMIX)"),
              *[t(i, "Rose Wello", f"X{i}") for i in (3, 4)],
              t(5, "Astro", "DMT", previous_title="Dmt", links=(Link("spotify", ("Astro",), "Dmt"),
                                                                 Link("soundcloud", (), "Astro - DMT", "Astro"))),
              t(6, "Astro", "WORLD WIDE", previous_title="World Wide"))
    assert res.tracks[1].title == "4K Deepo"
    assert res.tracks[2].title == "PUSH UPO (Rose Wello Remix)"
    assert res.tracks[5].title == "DMT"  # SoundCloud writes it in capitals too
    assert res.tracks[6].title == "World Wide"  # a shouting title is still quieted


# ---------------------------------------------------------------- ruleset names-8: the round-4 check's conditions
OWNER_CASING = (("pref:short_part_capitals", "B"), ("pref:alternating_case", "B"), ("pref:stylised_capitals", "A"))


def test_styling_the_artist_wrote_is_never_flattened_without_a_source():
    from app.services.names import spelling as SP
    v = SP.Votes()
    for n in ["QeloX"] * 3 + ["Qelox"] * 2:
        v.seen(n)  # written so by album-name heads only, no artist field
    c = SP.choose(v, SP.Counter(), SP.Counter(), style=SP.Style(short_part=True, alternating=True, asked=""))
    assert (c.spelling, c.rule) == ("QeloX", "C2t")
    tracks = [t(1, "vRonta", "A"), t(2, "SaroFenta", "B", album="One"), t(3, "Sarofenta", "C", album="Two")]
    plain = resolve(tracks, References(), [])
    assert [plain.tracks[i].artist for i in (1, 2)] == ["Vronta", "Sarofenta"]
    owner = resolve(tracks, References(), answered(*OWNER_CASING))
    assert [owner.tracks[i].artist for i in (1, 2, 3)] == ["vRonta", "SaroFenta", "SaroFenta"]
    assert "C2s" in owner.tracks[3].rules and "κεφαλαία μέσα στη λέξη" in owner.tracks[3].reason
    # a reference that writes the plain spelling still breaks the tie
    spot = resolve(tracks, References(spotify=(("Sarofenta", 2),)), answered(*OWNER_CASING))
    assert spot.tracks[2].artist == "Sarofenta"


def test_a_skeleton_tie_goes_to_the_soundcloud_publisher_not_to_letter_order():
    tracks = [t(1, "Möru", "A", album="One"), t(2, "Moru", "B", album="Two")]
    res = resolve(tracks, References(sc_publisher=(("Möru", 1),)), answered(*OWNER_CASING))
    assert [res.tracks[i].artist for i in (1, 2)] == ["Möru", "Möru"]


def test_a_label_named_by_a_pattern_leaves_a_credit_with_other_acts():
    music = [Decision("not_act", "name:*music", "label")]
    res = resolve([t(1, "Velo Music & Saro Fenta", "Tide"), t(2, "KRV & Orbo Music", "Dawn")], References(), music)
    r1, r2 = res.tracks[1], res.tracks[2]
    assert (r1.artist, r1.folder, r1.notes["label"]) == ("Saro Fenta", "Saro Fenta", "Velo Music")
    assert (r2.artist, r2.folder, r2.notes["label"]) == ("KRV", "KRV", "Orbo Music")
    assert "N9l" in r1.rules and "«Velo Music»" in r1.reason
    plain = resolve([t(1, "Velo Music & Saro Fenta", "Tide")], References(), [])
    assert plain.tracks[1].artist == "Velo Music & Saro Fenta"  # no answer: nothing leaves


def test_promo_words_leave_a_version_bracket_and_the_version_stays():
    res = run(t(1, "Velo", "Moon Gate (Out Now Remix)"), t(2, "Velo", "Moon Gate (Free Download Saro Edit)"),
              t(3, "Velo", "Moon Gate (Preview Mix)"))
    assert res.tracks[1].title == "Moon Gate (Remix)" and res.tracks[1].notes["removed"] == ["Out Now"]
    assert "D3v" in res.tracks[1].rules
    assert res.tracks[2].title == "Moon Gate (Saro Edit)"
    assert res.tracks[3].notes.get("preview") == ["Preview Mix"]  # a preview word says what the file is


def test_label_and_album_facts_hold_the_name_only():
    res = run(t(1, "Velo", "Sonoro (Saro Remix)*By: Orbo Record*"),
              t(2, "Velo", "Lagrimo 180+ BPM ★FREE DOWNLOAD★  by Orbo Mov "),
              t(3, "Velo & Saro", "Shadow Gate [EP Shadow Moon Out Now On Orbo Records]"),
              t(4, "Velo", "Foreign Gate [202] (V.A. Hyperio - Orbopro)"),
              t(5, "Velo", 'Dreamo [187] Out on Orbo Crew Label Album "Coming Soon"'))
    r = res.tracks
    assert r[1].notes["label"] == "Orbo Record"
    assert r[2].notes["label"] == "Orbo Mov"
    assert (r[3].notes["album"], r[3].notes["label"]) == ("EP Shadow Moon", "Orbo Records")
    assert "D3c" not in r[3].rules and "removed" not in r[3].notes
    assert (r[4].notes["album"], r[4].notes["label"]) == ("V.A. Hyperio", "Orbopro")
    assert r[5].notes["label"] == "Orbo Crew Label" and r[5].notes["removed"] == ["Album Coming Soon"]


def test_glued_own_name_wrapping_quotes_and_a_dropped_g():
    res = run(t(1, "VeloMoon", "VeloMoon Lucento 206bpm"), t(2, "Velo", "Velo Garden"), t(3, "Saro", "'Minkaro'"),
              t(4, "Saro", "Nanodroppo's Song"),
              t(5, "Saro", "Movin", links=(Link("spotify", ("Saro",), "Movin'"),)))
    assert res.tracks[1].title == "Lucento" and "A1own" in res.tracks[1].rules
    assert res.tracks[2].title == "Velo Garden"  # a plain name may belong to the title
    assert res.tracks[3].title == "Minkaro" and "D2w" in res.tracks[3].rules
    assert res.tracks[4].title == "Nanodroppo's Song"
    assert res.tracks[5].title == "Movin'" and "N31" in res.tracks[5].rules


def test_answered_reading_patterns_are_sure():
    tracks = [t(1, "", "Tide", links=(Link("soundcloud", (), "Tide", "Velkro"),))]
    assert resolve(tracks, References(), []).tracks[1].status == "look"
    done = resolve(tracks, References(), answered(("pref:uploader_as_artist", "A")))
    assert (done.tracks[1].artist, done.tracks[1].status) == ("Velkro", "sure")

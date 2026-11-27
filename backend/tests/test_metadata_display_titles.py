"""Display title cleanup preserves meaningful text and metadata provenance."""
from pathlib import Path

import pytest

from app.services.metadata_reader import display_artist_hints, display_title_hints, infer_tags_from_filename


@pytest.mark.parametrize(("title", "expected", "bpm"), [
    ("The Healing Frequency / RELEASED SOON", "The Healing Frequency", None),
    ("Vision On Brutality [200] unmastered", "Vision On Brutality", 200),
    ("Bella Ciao 180 Released on Hipnotic Tribe Rec.", "Bella Ciao", 180),
    ("Cybernetics [200] (Robot’s EP )", "Cybernetics", 200),
    ("Edit) Released on Modern Witches (Hypnotic Tribe)", "Edit", None),
    ("AFRICA 192 (RMX - Edit) Released on Modern Witches (Hypnotic Tribe)", "AFRICA (RMX - Edit)", 192),
    ("Eternals [190] Inprocess", "Eternals", 190),
    ("Eur Zuria ~ IN BANDCAMP", "Eur Zuria", None),
    ("Eur Zuria ~ (168 BPM) IN BANDCAMP", "Eur Zuria", 168),
    ("Illusion Of Diversity [174] SOOn on Kamayura Rec", "Illusion Of Diversity", 174),
    ("Lenta Released on Zeak Records", "Lenta", None),
    ("Lentas (191bpm) Released on Zeakon Records", "Lentas", 191),
    ("Digital Jungle Master16", "Digital Jungle", None),
    ("Emotional Transfer [180] 24bit", "Emotional Transfer", 180),
    ("Kaikkialla & AlpsCore - Phatty (200) Soon on STZ - Records", "Kaikkialla & AlpsCore - Phatty", 200),
    ("3266 The Sumerian [190] Soon On STZ - Records", "3266 The Sumerian", 190),
    ("Horizon [180] (Label Records Remix) Out Now", "Horizon (Label Records Remix)", 180),
    ("Horizon (Sangoma Records Edit) [170]", "Horizon (Sangoma Records Edit)", 170),
    ("Horizon (Label Records VIP)", "Horizon (Label Records VIP)", None),
    ("Horizon (Label Records Live Version)", "Horizon (Label Records Live Version)", None),
    ("Horizon (Label Records Extended)", "Horizon (Label Records Extended)", None),
    ("Horizon (Released on Mars Remix)", "Horizon (Released on Mars Remix)", None),
    ("Horizon (Bandcamp Preview Remix)", "Horizon (Bandcamp Preview Remix)", None),
    ("Horizon (180 BPM Records Remix) [170]", "Horizon (180 BPM Records Remix)", 170),
    ("Horizon (Project [180] Remix)", "Horizon (Project [180] Remix)", None),
    ("Violinos [188 BPM DEMO]", "Violinos", 188),
    ("Violinos (188 BPM demo)", "Violinos", 188),
    ("Horizon [💀 +170 BPM 💀]", "Horizon", 170),
    ("Horizon [Movement II 170 BPM]", "Horizon [Movement II]", 170),
    ("Horizon (Demo)", "Horizon (Demo)", None),
    ("Horizon [Free Download - Thanks for 5K Follower]", "Horizon", None),
    ("Horizon [Free Download - Thanks for 5K Follower] (Original Mix)", "Horizon", None),
    ("Horizon [Free Download Remix]", "Horizon [Free Download Remix]", None),
    ("Horizon [Previewer]", "Horizon [Previewer]", None),
    ("Traveling. 195 Out Soon on V/A VINAYAKA", "Traveling.", 195),
    ("Horizon 180 (160 BPM) Released on Label Records", "Horizon 180", 160),
    ("Route66", "Route66", None),
    ("1999 Released on Label Records", "1999", None),
    ("Summer of 2000", "Summer of 2000", None),
    ("180 Degrees Released on Label Records", "180 Degrees", None),
    ("District 180", "District 180", None),
    ("Route 66 Released on Label Records", "Route 66", None),
    ("180 Released on Label Records", "180", None),
    ("Horizon 180 (Original Mix)", "Horizon 180", None),
    ("Master16", "Master16", None),
    ("Previewer", "Previewer", None),
    ("Song Preview II", "Song Preview II", None),
])
def test_display_title_cleanup(title, expected, bpm):
    assert display_title_hints(title) == (expected, bpm)


# Display rules D0-D11 (.omc/research/next-ideas-2026-11-27/title-cleaning.md). Each rule has rows that must change
# and rows that must not; the BPM is what display_title_hints returned before the rules existed.
@pytest.mark.parametrize(("title", "expected", "bpm"), [
    # D0: characters stored without their top plane bit.
    ("Elipsy ", "Elipsy", None),
    ("Nebula Drift | 홊홐홏 홉홊홒", "Nebula Drift | OUT NOW", None),
    ("화해", "화해", None),  # Korean: the two syllables map to two different maths styles
    ("호흡", "호흡", None),  # the second syllable would be a Greek maths letter
    ("해", "해", None),  # a single syllable is never a maths word
    ("하하", "하하", None),  # nor one repeated syllable
    ("하하하", "하하하", None),
    ("허허", "허허", None),
    ("하하 소리", "하하 소리", None),  # other Hangul in the field: it is Korean
    # D1: decorations, unless they sit between two letters; a lone @ ~ * only at either end.
    ("ૐ Deep Origins ૐ", "Deep Origins", None),
    ("Lost Signal 🔎", "Lost Signal", None),
    ("Dance ૐ(Hitech/Darkpsy)ૐ", "Dance (Hitech/Darkpsy)", None),
    ("Signals ◉ Orbit vs Arc", "Signals - Orbit vs Arc", None),  # a spaced run between two words keeps them apart
    ("Lumen ∞ Orb", "Lumen - Orb", None),
    ("tryptamine ~", "tryptamine", None),
    ("Retrotown (Edit) 💀💀", "Retrotown (Edit)", None),
    ("Ko☢ra", "Ko☢ra", None),
    ("F♯ Minor Dream", "F♯ Minor Dream", None),
    ("Song @ Club", "Song @ Club", None),
    # D2: empty brackets and orphan separators.
    ("At The End { }", "At The End", None),
    ("Ecstasy Of Gold //", "Ecstasy Of Gold", None),
    ("Heartbeat-A //", "Heartbeat-A", None),
    ("Blood Moon (EP) Promo Mix ->", "Blood Moon (EP) Promo Mix", None),
    ("Namek Trip ( ) NO MASTER", "Namek Trip - NO MASTER", None),  # never glued to what follows
    ("Sunny [ ] 140 Cmin", "Sunny - 140 Cmin", None),
    ("( ) Opening", "Opening", None),
    ("Ghost Ship * NOW", "Ghost Ship * NOW", None),  # a star inside the title stays
    ("Embrace Your Flaws (Original Mix) *10K", "Embrace Your Flaws *10K", None),
    ("Song *OUT NOW*", "Song *OUT NOW", None),  # the end star went before the rules too
    ("Lost * #i lost the project", "Lost * #i lost the project", None),
    ("Mechanoid [170] ( ) ☢", "Mechanoid", 170),
    ("AC/DC Tribute", "AC/DC Tribute", None),
    ("Heartbeat-A", "Heartbeat-A", None),
    ("Who Knows?", "Who Knows?", None),
    # D3: misspelt watermarks, chart positions, "on <store>" at the end; never the whole title.
    ("Calabi Dream (FREE DOWLOAD)", "Calabi Dream", None),
    ("Drown (Exa Remix) [FREE DOWNLAOD!]", "Drown (Exa Remix)", None),
    ("ૐ Space Origins ૐ [190] Free Dowload", "Space Origins", 190),
    ("Welcome | ! [Top #17 Beatport]", "Welcome", None),
    ("Catalunya | Top #50 Beatport", "Catalunya", None),
    ("Run In The Dark [#20 on Beatport Top 100 Psy-Trance]", "Run In The Dark", None),
    ("Mantra (Hi Profile rmx) #No.12 BEATPORT Top 100", "Mantra (Hi Profile rmx)", None),  # never "…BEATPORT Top"
    ("The Only Risk Beatport Top #1 Releases", "The Only Risk", None),
    ("Acid Power (Demo) Out 9 july on Beatport", "Acid Power (Demo) Out 9 july", None),
    ("(FREE DOWLOAD)", "(FREE DOWLOAD)", None),
    ("Free Dowload Theme (VIP)", "Free Dowload Theme (VIP)", None),
    ("Odyn ( ) Free Dowload/NO MASTER/", "Odyn /NO MASTER/", None),  # no dash left before the separator
    ("Horizon - Free Download", "Horizon", None),
    ("Horizon [Free Download Remix]", "Horizon [Free Download Remix]", None),
    # D4: "(Original Mix)" goes.
    ("Shampoo Bottle (Original Mix)", "Shampoo Bottle", None),
    ("Flames (original mix)", "Flames", None),
    ("Its In Your Hands [Demo] [original mix]", "Its In Your Hands [Demo]", None),
    ("The Fabric of Reality - Original Mix", "The Fabric of Reality", None),
    ("Krank (Original Mix) Hightech Therapy VA", "Krank - Hightech Therapy VA", None),
    ("Energy Spot (Original Mix) //", "Energy Spot", None),
    ("Ascara [182] (Original Mix)", "Ascara", 182),
    ("Shampoo Bottle (Original Mix) (175 BPM)", "Shampoo Bottle", 175),
    ("(Original Mix)", "(Original Mix)", None),
    ("Original Sin", "Original Sin", None),
    ("Horizon (Extended Mix)", "Horizon (Extended Mix)", None),
    ("Mixtape (Original Mixtape)", "Mixtape (Original Mixtape)", None),
    # D5: "Title - X Remix" reads "Title (X Remix)".
    ("Desert Rider - Jilax Remix", "Desert Rider (Jilax Remix)", None),
    ("Desert Rider - Jilax Remix [180]", "Desert Rider (Jilax Remix)", 180),
    ("Rebirth - Deadhand Remix (200bpm) //", "Rebirth (Deadhand Remix)", 200),
    ("Module Virus - Rmx", "Module Virus (Rmx)", None),
    ("Alive With You - '21 Edit", "Alive With You ('21 Edit)", None),
    ("Scientific Mutation - First Cut Version", "Scientific Mutation (First Cut Version)", None),
    ("Dreams - Part II", "Dreams - Part II", None),
    ("Song - Remix (Live)", "Song - Remix (Live)", None),
    # D8: an acute accent typed for an apostrophe.
    ("It ́s Now", "It's Now", None),
    ("Well... At Least I ́ve Tried", "Well... At Least I've Tried", None),
    ("Nik O´Leary Theme", "Nik O'Leary Theme", None),
    ("Café del Mar", "Café del Mar", None),
    ("Renée", "Renée", None),
    # The dropped rule D7 (a number equal to the BPM) stays dropped: numbers in titles are kept.
    ("Believe in 200 ", "Believe in 200", None),
    ("Deep Origins ૐ 190 ૐ", "Deep Origins - 190", None),
    ("Unholy Trinity (193) ૐ", "Unholy Trinity (193)", None),
    ("Route 66", "Route 66", None),
    ("Nightcall (Area 88)", "Nightcall (Area 88)", None),
    ("Believe in 200", "Believe in 200", None),
    ("Ketama 188", "Ketama 188", None),
])
def test_display_rules_for_titles(title, expected, bpm):
    assert display_title_hints(title) == (expected, bpm)
    # The rules run after the tempo is read: the hint never depends on them.
    assert display_title_hints(title, tidy=False)[1] == bpm


@pytest.mark.parametrize(("artist", "expected"), [
    # D0
    ("퐍퐎퐕퐀", "NOVA"),
    ("퐍퐎퐕퐀 ퟐ", "NOVA 2"),
    (" Zarkon", "Zarkon"),
    ("화해", "화해"),
    # D10: genre words wrapped round the artist.
    ("[HiTech Darkpsy Psytrance] Kokoro", "Kokoro"),
    ("[Hi-Tech/Dark Psy] Babalu", "Babalu"),
    ("PSY-TRANCE ◉ Green Hill", "Green Hill"),
    ("Hitech Darkpsy Trance: Mimic vs Noise", "Mimic vs Noise"),
    ("Nebulon (PSYTRANCE)", "Nebulon"),
    (" [Hitech Psytrance] Supersonix", "Supersonix"),
    ("Goa Gil", "Goa Gil"),
    ("Progressive Brothers", "Progressive Brothers"),
    ("Trance Wax", "Trance Wax"),
    ("Forest Bamp & Mapa", "Forest Bamp & Mapa"),
    ("[Psytrance]", "[Psytrance]"),
    ("[Entrance] Xola", "[Entrance] Xola"),  # genre words only as whole words
    ("[Goal] Keeper", "[Goal] Keeper"),
    ("[Forester] Band", "[Forester] Band"),
    # D1
    ("Ranjo @", "Ranjo"),
    ("∞ Kovaty ∞", "Kovaty"),
    ("KoRs ♒️", "KoRs"),
    ("TiM 3Zo ● ─╤╦︻", "TiM 3Zo"),
    ("🙏🏼 Stryke & Max", "Stryke & Max"),
    ("Plankto •anomaly•", "Plankto anomaly"),  # judged doubtful in the spec's sample, kept
    ("ձռց☢ռε", "ձռց☢ռε"),
    ("Kalo Venta • Yama", "Kalo Venta, Yama"),  # two names stay two names
    ("Hux Bel ◉ Grun", "Hux Bel, Grun"),
    ("Omen Vat ▱ Euryth", "Omen Vat, Euryth"),
    ("DJ 🅰🅲🅸🅳", "DJ 🅰🅲🅸🅳"),  # enclosed letters are letters
    ("🅰🅲🅸🅳 Trip", "🅰🅲🅸🅳 Trip"),
    ("Hy3®!dbe@T", "Hy3®!dbe@T"),
    ("Who Knows?, Mr. Nobody & Jilax", "Who Knows?, Mr. Nobody & Jilax"),
    # D2
    ("PeaSoup (ૐ)", "PeaSoup"),
    ("Orbit ( )", "Orbit"),
    ("Orbit ( ) Lane", "Orbit, Lane"),
    # D11: a trailing "(… Records)" chunk names the label.
    ("Moriko (Orbita Records)", "Moriko"),
    ("Kaiza & Nuri (Sola Records)", "Kaiza & Nuri"),
    ("Dancer [Astra Recordings]", "Dancer"),
    ("Otolu (Sadhu & Imaraka)", "Otolu (Sadhu & Imaraka)"),
    ("Neutron (A)", "Neutron (A)"),
    ("Sangoma Records", "Sangoma Records"),
    ("(Sola Records)", "(Sola Records)"),
    # D8
    ("Ivan ́s Garden", "Ivan's Garden"),
    ("Nik O´Leary", "Nik O'Leary"),
    ("Renée Fox", "Renée Fox"),  # a decomposed accent is a letter, not an apostrophe
    # D9
    ("NEONFORM, YUXI  ", "NEONFORM, YUXI"),
    ("Kai   Ra", "Kai Ra"),
    ("", ""),
])
def test_display_rules_for_artists(artist, expected):
    assert display_artist_hints(artist) == expected


def test_scanner_retains_display_only_promo_and_technical_suffixes():
    result = infer_tags_from_filename(Path("Artist - Digital Jungle Master16.mp3"))
    assert result == {"artist": "Artist", "title": "Digital Jungle Master16"}

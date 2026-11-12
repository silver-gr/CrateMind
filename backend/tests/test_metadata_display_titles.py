"""Display title cleanup preserves meaningful text and metadata provenance."""
from pathlib import Path

import pytest

from app.services.metadata_reader import display_title_hints, infer_tags_from_filename


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
    ("Horizon [Free Download - Thanks for 5K Follower] (Original Mix)", "Horizon (Original Mix)", None),
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
    ("Horizon 180 (Original Mix)", "Horizon 180 (Original Mix)", None),
    ("Master16", "Master16", None),
    ("Previewer", "Previewer", None),
    ("Song Preview II", "Song Preview II", None),
])
def test_display_title_cleanup(title, expected, bpm):
    assert display_title_hints(title) == (expected, bpm)


def test_scanner_retains_display_only_promo_and_technical_suffixes():
    result = infer_tags_from_filename(Path("Artist - Digital Jungle Master16.mp3"))
    assert result == {"artist": "Artist", "title": "Digital Jungle Master16"}

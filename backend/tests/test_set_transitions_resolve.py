"""Set-transition resolver: tempo-match rate, the Auto preset rules and the preset table."""
from __future__ import annotations

import json
from pathlib import Path

import pytest

from app.services import set_transitions as st
from app.services.set_transitions import PairInput, ProfileHints

PRESETS_JSON = (
    Path(__file__).resolve().parents[2] / "frontend" / "src" / "lib" / "transitions" / "presets.json"
)


def _in_range(rate: float) -> bool:
    return abs(rate - 1) <= st.MAX_RATE_DEVIATION


def _pair(from_bpm=140.0, to_bpm=141.0, from_key="9A", to_key="9A", from_profile=None,
          to_profile=None) -> PairInput:
    return PairInput(from_bpm=from_bpm, to_bpm=to_bpm, from_key=from_key, to_key=to_key,
                     from_profile=from_profile, to_profile=to_profile)


def _hints(role=None, cut_into=None, cut_out_of=None) -> ProfileHints:
    return ProfileHints(transition_role=role, can_cut_into=cut_into, can_cut_out_of=cut_out_of)


# --- tempo_match_rate: the incoming deck's rate, from/to folded into [0.7071, 1.4142) ---

def test_rate_folds_octaves():
    assert st.tempo_match_rate(80, 160) == 1.0
    assert st.tempo_match_rate(160, 80) == 1.0


def test_rate_values_and_range():
    assert st.tempo_match_rate(140, 147) == pytest.approx(0.9524, abs=1e-4)
    assert _in_range(st.tempo_match_rate(140, 147))
    assert st.tempo_match_rate(140, 120) == pytest.approx(1.1667, abs=1e-4)
    assert not _in_range(st.tempo_match_rate(140, 120))
    assert st.tempo_match_rate(120, 140) == pytest.approx(0.8571, abs=1e-4)
    assert _in_range(st.tempo_match_rate(120, 140))  # 0.857 is inside the ±0.16 pitch range


def test_rate_boundaries_both_directions():
    assert st.tempo_match_rate(140, 121) == pytest.approx(1.157, abs=1e-3)
    assert _in_range(st.tempo_match_rate(140, 121))
    assert st.tempo_match_rate(140, 120.5) == pytest.approx(1.1618, abs=1e-4)
    assert not _in_range(st.tempo_match_rate(140, 120.5))
    # Mirrored direction: the same quantity (from/to), so its boundary sits at rate 0.84.
    assert _in_range(st.tempo_match_rate(121, 140))
    assert _in_range(st.tempo_match_rate(120.5, 140))
    assert st.tempo_match_rate(118, 140) == pytest.approx(0.8429, abs=1e-4)
    assert _in_range(st.tempo_match_rate(118, 140))
    assert st.tempo_match_rate(117.7, 140) == pytest.approx(0.8407, abs=1e-4)
    assert _in_range(st.tempo_match_rate(117.7, 140))
    assert st.tempo_match_rate(117.5, 140) == pytest.approx(0.8393, abs=1e-4)
    assert not _in_range(st.tempo_match_rate(117.5, 140))


def test_rate_fold_bounds():
    for a, b in [(70, 99), (99, 70), (60, 180), (200, 66), (128, 128)]:
        r = st.tempo_match_rate(a, b)
        assert 0.7071 <= r < 1.4143


def test_rate_rejects_non_positive():
    with pytest.raises(ValueError):
        st.tempo_match_rate(0, 120)
    with pytest.raises(ValueError):
        st.tempo_match_rate(120, -1)
    with pytest.raises(ValueError):  # the ratio underflows to 0.0; folding it would never end
        st.tempo_match_rate(5e-324, 140)


# --- resolve_auto ---

def test_same_key_close_bpm_blends():
    r = st.resolve_auto(_pair(140, 141, "9A", "9A"))
    assert (r.preset, r.bars, r.tempo_match) == ("blend", 8, True)
    assert {"same_key", "bpm_close"} <= set(r.reasons)
    assert (r.volume_curve, r.eq_curve, r.filter_curve, r.loop_beats) == (
        "overlap", "three_band", "none", None)


def test_adjacent_and_relative_keys_blend():
    assert "adjacent_key" in st.resolve_auto(_pair(140, 141, "9A", "10A")).reasons
    r = st.resolve_auto(_pair(140, 141, "9A", "9B"))
    assert r.preset == "blend"
    assert "relative_key" in r.reasons


def test_out_of_range_bpm_slams():
    r = st.resolve_auto(_pair(98, 160))
    assert (r.preset, r.bars, r.tempo_match) == ("slam", 1, False)
    assert "bpm_out_of_range" in r.reasons


def test_near_octave_pair_keeps_tempo_match():
    r = st.resolve_auto(_pair(80, 160))
    assert r.tempo_match is True
    assert r.preset == "blend"


def test_key_clash_fades():
    r = st.resolve_auto(_pair(140, 142, "9A", "3B"))
    assert (r.preset, r.bars, r.tempo_match) == ("fade", 4, True)
    assert "key_clash" in r.reasons


def test_unknown_key_fades():
    r = st.resolve_auto(_pair(140, 141, None, "9A"))
    assert r.preset == "fade"
    assert "key_unknown" in r.reasons


def test_good_key_far_bpm_afterglow():
    r = st.resolve_auto(_pair(140, 147, "9A", "9A"))
    assert (r.preset, r.bars) == ("afterglow", 8)
    assert {"same_key", "bpm_far"} <= set(r.reasons)


def test_dramatic_cut_profile_slams():
    r = st.resolve_auto(_pair(140, 142, "9A", "3B", from_profile=_hints("dramatic_cut")))
    assert (r.preset, r.bars, r.tempo_match) == ("slam", 1, True)
    assert "profile_cut" in r.reasons


def test_safe_blend_profile_overrides_key_clash():
    r = st.resolve_auto(_pair(140, 142, "9A", "3B", to_profile=_hints("peak,safe_blend")))
    assert (r.preset, r.bars) == ("blend", 8)
    assert "profile_blend" in r.reasons


def test_profile_roles_match_case_insensitively():
    r = st.resolve_auto(_pair(140, 142, "9A", "3B", to_profile=_hints(" Peak, Safe_Blend ")))
    assert (r.preset, "profile_blend" in r.reasons) == ("blend", True)
    r = st.resolve_auto(_pair(140, 142, "9A", "3B", from_profile=_hints("DRAMATIC_CUT")))
    assert r.preset == "slam"


def test_can_cut_flags_never_force_a_slam():
    r = st.resolve_auto(_pair(140, 141, "9A", "9A", from_profile=_hints(cut_out_of=True)))
    assert r.preset == "blend"
    assert "profile_cut" not in r.reasons


def test_can_cut_flags_annotate_a_chosen_slam():
    r = st.resolve_auto(_pair(98, 160, to_profile=_hints(cut_into=True)))
    assert r.preset == "slam"
    assert {"bpm_out_of_range", "profile_cut"} <= set(r.reasons)


def test_missing_bpm_fades_without_tempo_match():
    for pair in (_pair(None, 140), _pair(140, None), _pair(0, 140)):
        r = st.resolve_auto(pair)
        assert (r.preset, r.bars, r.tempo_match) == ("fade", 4, False)
        assert "bpm_unknown" in r.reasons


def test_reasons_are_known_codes():
    pairs = [_pair(), _pair(98, 160), _pair(140, 142, "9A", "3B"), _pair(None, None, None, None),
             _pair(140, 142, "9A", "3B", from_profile=_hints("dramatic_cut", True, True))]
    for pair in pairs:
        assert set(st.resolve_auto(pair).reasons) <= set(st.REASON_CODES)


# --- materialise and the preset table ---

def test_materialise_none_has_zero_bars():
    r = st.materialise("none")
    assert r.bars == 0
    assert r.reasons == ()


def test_materialise_named_preset():
    r = st.materialise("surge")
    assert (r.preset, r.volume_curve, r.eq_curve, r.filter_curve, r.bars, r.loop_beats) == (
        "surge", "overlap", "bass_swap_start", "hpf_in", 4, 4)


def test_materialise_rejects_auto_and_unknown():
    for name in ("auto", "custom", "bogus"):
        with pytest.raises(ValueError):
            st.materialise(name)


def test_preset_specs_are_valid():
    assert set(st.PRESETS) == {"fade", "rise", "blend", "wave", "melt", "slam", "dissolve",
                               "surge", "afterglow", "none"}
    for name, spec in st.PRESETS.items():
        assert st.BARS_MIN <= spec.bars <= st.BARS_MAX or (name == "none" and spec.bars == 0)
        assert spec.loop_beats is None or (spec.loop_beats in st.LOOP_BEATS
                                           and spec.loop_beats <= 4 * spec.bars)
    combos = [(s.volume, s.eq, s.filter, s.loop_beats) for s in st.PRESETS.values()]
    assert len(combos) == len(set(combos)), "presets must be distinguishable by curves + loop"


def test_preset_table_matches_frontend_fixture():
    """presets.json shape: {name: {volume_curve, eq_curve, filter_curve, bars, loop_beats}}."""
    if not PRESETS_JSON.is_file():
        pytest.skip("frontend/src/lib/transitions/presets.json not present yet")
    data = json.loads(PRESETS_JSON.read_text(encoding="utf-8"))
    expected = {
        name: {"volume_curve": s.volume, "eq_curve": s.eq, "filter_curve": s.filter,
               "bars": s.bars, "loop_beats": s.loop_beats}
        for name, s in st.PRESETS.items()
    }
    assert set(data) == set(expected)
    for name, fields in expected.items():
        assert {k: data[name].get(k) for k in fields} == fields, name

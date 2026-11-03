"""The BPM consensus helpers live in a DSP-free module the desktop API can import."""
from __future__ import annotations

import subprocess
import sys
from pathlib import Path

import pytest

BACKEND = Path(__file__).resolve().parents[1]
MOVED_NAMES = (
    "HALF_TEMPO_THRESHOLD",
    "_corrected_bpm",
    "bpm_disagreement",
    "_octave_adjusted",
    "bpm_consensus",
    "_refresh_consensus",
)
FORBIDDEN = ("scipy", "librosa", "essentia", "app.services.audio_analysis")


def test_consensus_module_imports_without_dsp():
    code = (
        "import app.services.bpm_consensus, sys\n"
        f"loaded = [name for name in {FORBIDDEN!r} if name in sys.modules]\n"
        "print(','.join(loaded))\n"
    )
    result = subprocess.run(
        [sys.executable, "-c", code],
        cwd=BACKEND,
        capture_output=True,
        text=True,
        stdin=subprocess.DEVNULL,
        check=True,
    )
    assert result.stdout.strip() == ""


@pytest.mark.parametrize("name", MOVED_NAMES)
def test_audio_analysis_reexports_the_same_objects(name):
    from app.services import audio_analysis as aa
    from app.services import bpm_consensus as bc

    assert getattr(aa, name) is getattr(bc, name)

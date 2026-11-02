"""Synthetic numerical checks for the measured six-filter colour model."""
import colorsys

import numpy as np
import pytest

from app.services import waveform_color as wc
from app.services import waveform_detail as wd


def test_filter_knots_use_rounded_bins_and_square_root_ramps():
    # At 44.1 kHz: [80,100,200,450] Hz -> bins [1,1,2,5].
    assert wc.FILTERS.shape == (256, 6)
    assert wc.FILTERS[:6, 1] == pytest.approx([0, 1.7, 1.7 * np.sqrt(3 / 4),
                                                            1.7 * np.sqrt(2 / 4), 1.7 * .5, 0])
    assert wc.FILTERS[:3, 0] == pytest.approx([3, 0, 0])
    # Fourth filter has no plateau: [1500,1700,1700,3700] -> [17,20,20,43].
    assert wc.FILTERS[17:21, 3] == pytest.approx([.6, 1.2 * np.sqrt(.5),
                                                               1.2 * np.sqrt(.75), 1.2 * np.sqrt(23 / 24)])
    assert wc.FILTERS[43, 3] == 0


def test_each_filter_retains_its_measured_hue():
    rgb = wc.mix_colors(np.eye(6))
    expected = np.array([colorsys.hsv_to_rgb(hue, 1, 1) for hue in (.99, 0, .36, .44, .64, .66)])
    np.testing.assert_allclose(rgb, expected, atol=1e-12)
    mixed = wc.mix_colors(np.array([[1, 1, 0, 0, 0, 0]]))[0]
    # Red wraps around the unit circle, rather than turning cyan halfway across it.
    assert mixed[0] > .99 and mixed[1] < .04 and mixed[2] < .04


def test_brightness_piecewise_thresholds_and_gray_floor():
    db = np.array([-100, -50, -43, -36, -22.5, -9, 0])
    assert wc.brightness(10 ** (db / 20)) == pytest.approx([0, 0, .1, .2, .6, 1, 1])
    assert wc.brightness(np.array([0, np.nan, np.inf])).tolist() == [0, 0, 0]
    quiet = np.full((1, 2, 512), .001)
    np.testing.assert_allclose(wc.analyze(quiet), .2, atol=1e-12)


def test_colour_fft_uses_periodic_hamming_mean_channel_magnitude_and_full_frame_rms():
    t = np.arange(512) / 44100
    samples = .2 * np.sin(2 * np.pi * 1000 * t)
    frames = np.stack([samples, -samples])[None, :, :]
    actual = wc.analyze(frames)[0]
    window = .54 - .46 * np.cos(2 * np.pi * np.arange(512) / 512)
    spectrum = np.abs(np.fft.rfft(samples * window))[:256]
    scores = spectrum @ wc.FILTERS
    scores = scores / scores.max()
    weights = scores ** 1.5
    angles = 2 * np.pi * np.array([.99, 0, .36, .44, .64, .66])
    x, y = weights @ np.cos(angles), weights @ np.sin(angles)
    h = np.arctan2(y, x) / (2 * np.pi) % 1
    saturation = .3 + .7 * np.hypot(x, y) / weights.sum()
    hue = np.array(colorsys.hsv_to_rgb(h, saturation, 1))
    rms = np.sqrt(np.mean(samples ** 2))
    db = 20 * np.log10(rms)
    brightness = np.clip(.2 + .8 * (db + 36) / 27, 0, 1)
    np.testing.assert_allclose(actual, brightness * hue + .2 * (1 - brightness), atol=1e-12)


def test_synthetic_tones_have_red_green_and_blue_colours():
    t = np.arange(512) / 44100
    for frequency, dominant in [(50, 0), (800, 1), (9000, 2)]:
        tone = .8 * np.sin(2 * np.pi * frequency * t)
        colour = wc.analyze(np.tile(tone, (1, 2, 1)))[0]
        assert np.argmax(colour) == dominant
        assert np.ptp(colour) > .4


def test_nearest_colour_frame_alignment_includes_prepad_and_clamps_edges():
    rng = np.random.default_rng(14)
    samples = rng.normal(0, .1, (1027, 2)).astype(np.float32)
    analyzer = wd._Analyzer()
    analyzer.feed(samples)
    _, actual = analyzer.finish()
    padded = np.pad(samples, ((128, 512), (0, 0)))
    frames = np.stack([padded[start:start + 512].T for start in range(0, 1027, 256)])
    colours = wc.analyze(frames)
    # Centres 20,60,100,140,180,220,260 -> source indices 0,0,0,0,0,0,1.
    indices = np.clip(np.floor((np.arange(len(actual)) * 40 + 20 - 128) / 256 + .5).astype(int),
                      0, len(colours) - 1)
    assert indices[:7].tolist() == [0, 0, 0, 0, 0, 0, 1]
    np.testing.assert_allclose(actual[:, 2:], colours[indices], atol=1e-12)

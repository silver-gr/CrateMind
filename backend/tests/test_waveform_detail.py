import hashlib
import json
import shutil
import struct
import wave
from pathlib import Path

import numpy as np
import pytest

from app.services import waveform as wf
from app.services import waveform_detail as wd

FIX = Path(__file__).parent / 'fixtures' / 'waveform_detail'
PLANES = ('rms', 'peak', 'red', 'green', 'blue')
needs_ffmpeg = pytest.mark.skipif(not shutil.which('ffmpeg'), reason='ffmpeg required')


def audio(path, samples):
    with wave.open(str(path), 'wb') as w:
        w.setnchannels(2)
        w.setsampwidth(2)
        w.setframerate(wf.RATE)
        w.writeframes((np.clip(samples, -1, 1) * 32767).astype('<i2').tobytes())


def parse(blob):
    magic, version, reserved, rate, hop, win, frames, duration, digest = struct.unpack_from('<4sHHIIIId16s', blob)
    assert len(blob) == 48 + 5 * frames
    planes = np.frombuffer(blob, np.uint8, offset=48).reshape(5, frames)
    return dict(magic=magic, version=version, reserved=reserved, sample_rate=rate, hop=hop, win=win,
                frames=frames, duration=duration, digest=digest, **dict(zip(PLANES, planes)))


def analyze(samples, cuts=()):
    analyzer = wd._Analyzer()
    for block in np.split(samples, cuts):
        analyzer.feed(block.astype(np.float32))
    count, values = analyzer.finish()
    assert count == wd.frame_count(len(samples))
    return values, wd._quantize(values)


@pytest.fixture
def cache(tmp_path, monkeypatch):
    target = tmp_path / 'cache'
    target.mkdir()
    monkeypatch.setattr(wf, '_cache_dir', lambda: target)
    monkeypatch.setattr(wd, '_cache_dir', lambda: target)
    return target


def test_golden_fixture_roundtrip():
    expected = json.loads((FIX / 'golden.json').read_text())
    blob = (FIX / 'golden.bin').read_bytes()
    header = parse(blob)
    assert (header['magic'], header['version'], header['reserved']) == (b'CMWD', 2, 0)
    for key in ('sample_rate', 'hop', 'win', 'frames', 'duration'):
        assert header[key] == expected[key]
    assert header['digest'].hex() == expected['digest_hex']
    assert len(blob) == expected['byte_length']
    for key in PLANES:
        assert header[key].tolist() == expected[key]
    planes = np.array([expected[key] for key in PLANES], np.uint8)
    assert wd.encode(8, expected['duration'], header['digest'], planes) == blob
    assert wd.HEADER.size == 48


def test_frame_count_covers_every_sample():
    assert [wd.frame_count(n) for n in (0, 1, 39, 40, 41, 80, 81)] == [0, 1, 1, 1, 2, 2, 3]


def test_separate_lock_pool():
    assert wd._DETAIL_LOCKS is not wf._LOCKS
    assert not {id(x) for x in wd._DETAIL_LOCKS} & {id(x) for x in wf._LOCKS}


def test_sparse_click_in_sixty_seconds_survives_and_uses_linear_rms():
    samples = np.zeros((60 * wf.RATE, 2), np.float32)
    samples[30 * wf.RATE + 17] = .8
    values, planes = analyze(samples)
    index = (30 * wf.RATE + 17) // 40
    assert np.count_nonzero(planes[1]) == 1
    assert planes[1, index] == 255
    assert planes[0, index] == int(255 / np.sqrt(40))
    assert values[index, :2] == pytest.approx([.8 / np.sqrt(40), .8])


@pytest.mark.parametrize('length', [1, 39, 40, 41, 255, 256, 257, 81921])
def test_first_and_last_samples_survive(length):
    samples = np.zeros((length, 2), np.float32)
    samples[0] = .5
    samples[-1] = .75
    values, planes = analyze(samples)
    assert planes[1, 0] > 0 and planes[1, -1] > 0
    assert np.all(values[:, 0] <= values[:, 1] + 1e-7)
    assert np.all(planes[0] <= planes[1])


def test_chunk_boundaries_preserve_envelopes_and_colours():
    rng = np.random.default_rng(73)
    samples = rng.normal(0, .13, (20003, 2)).astype(np.float32)
    samples[[0, 39, 40, 255, 256, 511, 512, -1]] = [.8, -.8]
    whole, whole_planes = analyze(samples)
    split, split_planes = analyze(samples, [1, 39, 40, 41, 127, 128, 255, 256, 257, 511, 512, 8191, 8192])
    np.testing.assert_array_equal(split, whole)
    np.testing.assert_array_equal(split_planes, whole_planes)
    assert np.all(split[:, 0] <= split[:, 1] + 1e-7)


@pytest.mark.parametrize('length', [0, 1, 39, 40, 41, 255, 256, 257, 81921])
def test_quantized_finalization_matches_raw_analysis_across_chunks(length):
    rng = np.random.default_rng(23)
    samples = rng.normal(0, .03, (length, 2)).astype(np.float32)
    if length:
        samples[-1] = [.8, -.8]  # the reference peak is in the final chunk
    _, expected = analyze(samples)
    analyzer = wd._Analyzer()
    boundaries = [edge for edge in (1, 39, 40, 41, 127, 128, 255, 256, 257, 511, 512, 81919, 81920)
                  if edge < length]
    for chunk in np.split(samples, boundaries):
        analyzer.feed(chunk)
    frames, actual = analyzer.finish_quantized()
    assert frames == wd.frame_count(length)
    assert actual.dtype == np.uint8 and actual.shape == (5, frames)
    np.testing.assert_array_equal(actual, expected)


def test_quantized_finalization_bounds_colour_mapping_temporaries(monkeypatch):
    samples = np.full(((wd.CHUNK_FRAMES + 3) * wd.HOP, 2), .05, np.float32)
    analyzer = wd._Analyzer()
    analyzer.feed(samples)
    arange = np.arange

    def bounded_arange(count, *args, **kwargs):
        assert count <= wd.CHUNK_FRAMES
        return arange(count, *args, **kwargs)

    monkeypatch.setattr(wd.np, 'arange', bounded_arange)
    monkeypatch.setattr(analyzer, 'finish', lambda: pytest.fail('production must not expand raw five-plane values'))
    frames, planes = analyzer.finish_quantized()
    assert frames == wd.CHUNK_FRAMES + 3
    assert np.all(planes[:2] == 255)


def test_per_channel_envelopes_and_colours_do_not_cancel():
    t = np.arange(wf.RATE) / wf.RATE
    tone = .5 * np.sin(2 * np.pi * 1000 * t)
    both, both_planes = analyze(np.column_stack([tone, tone]))
    inverted, inverted_planes = analyze(np.column_stack([tone, -tone]))
    one, _ = analyze(np.column_stack([tone, 0 * tone]))
    np.testing.assert_array_equal(inverted, both)
    np.testing.assert_array_equal(inverted_planes, both_planes)
    assert both[10:-10, 0].mean() == pytest.approx(.5 / np.sqrt(2), rel=.02)
    np.testing.assert_allclose(one[:, :2], both[:, :2] / 2)
    assert np.ptp(inverted_planes[2:, 20:-20].mean(axis=1)) > 40


def test_envelope_scale_is_linear_and_track_max_is_not_percentile_clipped():
    samples = np.full((4000, 2), .8, np.float32)
    samples[2000:] = .08
    values, planes = analyze(samples)
    assert np.all(planes[:2, :50] == 255)
    assert np.all(planes[:2, 50:] == 25)
    values[7, :2] = [.9, 1.0]
    scaled = wd._quantize(values)
    assert scaled[1, 7] == 255
    assert scaled[1, 8] == 204
    assert scaled[0, 7] == 229


def test_quiet_floor_and_silence():
    _, quiet = analyze(np.full((400, 2), .001, np.float32))
    assert np.all(quiet[:2] == 25)
    _, silence = analyze(np.zeros((400, 2), np.float32))
    assert np.all(silence[:2] == 0)
    assert np.all(silence[2:] == 51)  # dark gray is independent of envelope normalization
    empty, planes = analyze(np.zeros((0, 2), np.float32))
    assert empty.shape == (0, 5) and planes.shape == (5, 0)


@needs_ffmpeg
def test_decode_contract_and_sample_count(tmp_path, cache, monkeypatch):
    samples = np.zeros((wf.RATE + 1, 2), np.float32)
    samples[0] = .8
    samples[-1] = .4
    path = tmp_path / 'edges.wav'
    audio(path, samples)
    monkeypatch.setattr(wd._Analyzer, 'finish', lambda self: pytest.fail('decoder must use compact finalization'))
    etag, blob = wd.get_or_compute_detail(1, str(path))
    detail = parse(blob)
    assert (detail['version'], detail['sample_rate'], detail['hop'], detail['win']) == (2, 44100, 40, 40)
    assert detail['frames'] == wd.frame_count(len(samples))
    assert detail['duration'] == pytest.approx(len(samples) / wf.RATE)
    assert detail['peak'][0] == 255 and detail['peak'][-1] > 100
    assert etag == '"' + detail['digest'].hex() + '"'


@needs_ffmpeg
def test_cache_signature_corruption_and_v1_invalidation(tmp_path, cache, monkeypatch):
    path = tmp_path / 'c.wav'
    audio(path, np.full((8192, 2), .25))
    legacy = cache / '3-detail-v1.bin'
    legacy.write_bytes(b'old cached bytes')
    calls = []
    original = wd._decode
    monkeypatch.setattr(wd, '_decode', lambda *args: (calls.append(1), original(*args))[1])
    first = wd.get_or_compute_detail(3, str(path))
    current = cache / '3-detail-v2.bin'
    assert current.is_file() and legacy.read_bytes() == b'old cached bytes'
    assert wd.get_or_compute_detail(3, str(path)) == first and len(calls) == 1
    audio(path, np.full((8193, 2), .5))
    second = wd.get_or_compute_detail(3, str(path))
    assert second[0] != first[0] and len(calls) == 2
    for broken in (second[1][:-1], b'junk'):
        current.write_bytes(broken)
        assert wd.get_or_compute_detail(3, str(path)) == second
    assert len(calls) == 4
    path.unlink()
    assert wd.get_or_compute_detail(3, str(path)) is None


def test_size_limit_rejects_oversized_payload():
    assert not wd._valid(b'\0' * (wd.MAX_BYTES + 1), b'\0' * 16)


@needs_ffmpeg
def test_route_etag_304_and_cache_headers(client, tmp_path):
    from tests.test_audio import _add_track
    from tests.conftest import make_wav
    wav = make_wav(tmp_path / 'song.wav', seconds=1.0, freq_seed=4)
    tid = _add_track(str(wav), 'wav')
    signature = wf._signature(wav)
    old_raw = json.dumps({**signature, 'detail': 1, 'win': 1024, 'hop': 294, 'rate': wf.RATE}, sort_keys=True)
    old_etag = '"' + hashlib.sha256(old_raw.encode()).digest()[:16].hex() + '"'
    response = client.get(f'/api/tracks/{tid}/waveform/detail', headers={'If-None-Match': old_etag})
    assert response.status_code == 200 and response.headers['content-type'] == 'application/octet-stream'
    assert response.headers['cache-control'] and parse(response.content)['version'] == 2
    etag = response.headers['etag']
    assert etag != old_etag
    current = client.get(f'/api/tracks/{tid}/waveform/detail', headers={'If-None-Match': etag})
    assert current.status_code == 304 and current.content == b'' and current.headers['etag'] == etag
    assert client.get('/api/tracks/99999/waveform/detail').status_code == 404

import json, shutil, struct, wave
from pathlib import Path
import numpy as np
import pytest
from app.services import waveform as wf
from app.services import waveform_detail as wd

FIX = Path(__file__).parent / 'fixtures' / 'waveform_detail'
needs_ffmpeg = pytest.mark.skipif(not shutil.which('ffmpeg'), reason='ffmpeg required')


def audio(path, samples):
    with wave.open(str(path), 'wb') as w:
        w.setnchannels(2); w.setsampwidth(2); w.setframerate(wf.RATE)
        w.writeframes((np.clip(samples, -1, 1) * 32767).astype('<i2').tobytes())


def parse(blob):
    magic, version, reserved, rate, hop, win, frames, duration, digest = struct.unpack_from('<4sHHIIIId16s', blob)
    assert len(blob) == 48 + 4 * frames
    p = np.frombuffer(blob, np.uint8, offset=48).reshape(4, frames)
    return dict(magic=magic, version=version, reserved=reserved, sample_rate=rate, hop=hop, win=win,
                frames=frames, duration=duration, digest=digest, full=p[0], low=p[1], mid=p[2], high=p[3])


@pytest.fixture
def cache(tmp_path, monkeypatch):
    target = tmp_path / 'cache'; target.mkdir()
    monkeypatch.setattr(wf, '_cache_dir', lambda: target)
    monkeypatch.setattr(wd, '_cache_dir', lambda: target)
    return target


def test_golden_fixture_roundtrip():
    expected = json.loads((FIX / 'golden.json').read_text())
    blob = (FIX / 'golden.bin').read_bytes()
    h = parse(blob)
    assert (h['magic'], h['version'], h['reserved']) == (b'CMWD', 1, 0)
    for k in ('sample_rate', 'hop', 'win', 'frames', 'duration'):
        assert h[k] == expected[k]
    assert h['digest'].hex() == expected['digest_hex'] and len(blob) == expected['byte_length']
    for k in ('full', 'low', 'mid', 'high'):
        assert h[k].tolist() == expected[k]
    planes = np.array([expected[k] for k in ('full', 'low', 'mid', 'high')], np.uint8)
    assert wd.encode(8, expected['duration'], h['digest'], planes) == blob
    assert wd.HEADER.size == 48


def test_frame_count_covers_tail():
    assert wd.frame_count(0) == 0 and wd.frame_count(1) == 1 and wd.frame_count(1024) == 1
    assert wd.frame_count(1025) == 2 and wd.frame_count(1024 + 294) == 2 and wd.frame_count(1024 + 295) == 3


def test_separate_lock_pool():
    assert wd._DETAIL_LOCKS is not wf._LOCKS
    assert not {id(x) for x in wd._DETAIL_LOCKS} & {id(x) for x in wf._LOCKS}


def test_bands_are_per_channel_and_unit_calibrated():
    t = np.arange(wf.RATE) / wf.RATE
    tone = .5 * np.sin(2 * np.pi * 1000 * t)

    def run(left, right):
        a = wd._Analyzer(); a.feed(np.column_stack([left, right]).astype(np.float32))
        return a.finish()[1][10:-10].mean(axis=0)  # full, low, mid, high

    both = run(tone, tone)
    assert both[0] == pytest.approx(.5 / np.sqrt(2), rel=.02)
    assert both[2] == pytest.approx(both[0], rel=.02) and both[1] < .01 * both[0] and both[3] < .01 * both[0]
    assert run(tone, -tone)[0] == pytest.approx(both[0], rel=.01)  # inverted stereo must not cancel
    assert run(tone, 0 * tone)[0] == pytest.approx(both[0] / 2, rel=.02)  # RMS averaged, not summed


@needs_ffmpeg
def test_sines_land_in_low_mid_high_with_shared_scale(tmp_path, cache):
    t = np.arange(wf.RATE) / wf.RATE
    mono = np.concatenate([.8 * np.sin(2 * np.pi * f * t) for f in (100, 1000, 6000)])
    path = tmp_path / 'sines.wav'; audio(path, np.column_stack([mono, mono]))
    etag, blob = wd.get_or_compute_detail(1, str(path))
    d = parse(blob)
    assert d['frames'] == wd.frame_count(3 * wf.RATE) and d['duration'] == pytest.approx(3.0)
    assert (d['sample_rate'], d['hop'], d['win']) == (44100, 294, 1024)
    per = d['frames'] // 3
    for i, band in enumerate(('low', 'mid', 'high')):
        sl = slice(i * per + 15, (i + 1) * per - 15)
        means = {b: float(d[b][sl].mean()) for b in ('low', 'mid', 'high')}
        assert max(means, key=means.get) == band
        assert means[band] > 200 and max(v for b, v in means.items() if b != band) < .5 * means[band]
        assert abs(means[band] - float(d['full'][sl].mean())) < 3  # one scale across arrays
    assert d['full'].max() >= 250
    assert etag == '"' + d['digest'].hex() + '"'


@needs_ffmpeg
def test_quiet_band_is_smaller_on_the_shared_scale(tmp_path, cache):
    t = np.arange(wf.RATE * 2) / wf.RATE
    tone = np.where(t < 1, .8 * np.sin(2 * np.pi * 1000 * t), .08 * np.sin(2 * np.pi * 100 * t))
    path = tmp_path / 'level.wav'; audio(path, np.column_stack([tone, tone]))
    d = parse(wd.get_or_compute_detail(2, str(path))[1])
    # 100 Hz tone is 10x quieter in amplitude -> sqrt(.1) of the loud mid level.
    assert d['mid'][50:100].mean() > 240
    assert d['low'][-100:-50].mean() == pytest.approx(255 * np.sqrt(.1), abs=12)


@needs_ffmpeg
def test_cache_signature_and_corruption(tmp_path, cache, monkeypatch):
    path = tmp_path / 'c.wav'; audio(path, np.full((8192, 2), .25))
    calls = []; original = wd._decode
    monkeypatch.setattr(wd, '_decode', lambda *a: (calls.append(1), original(*a))[1])
    a = wd.get_or_compute_detail(3, str(path))
    assert (cache / '3-detail-v1.bin').is_file()
    assert wd.get_or_compute_detail(3, str(path)) == a and len(calls) == 1
    audio(path, np.full((8193, 2), .5))
    b = wd.get_or_compute_detail(3, str(path))
    assert b[0] != a[0] and len(calls) == 2
    (cache / '3-detail-v1.bin').write_bytes(b[1][:-1])
    assert wd.get_or_compute_detail(3, str(path)) == b and len(calls) == 3
    (cache / '3-detail-v1.bin').write_bytes(b'junk')
    assert wd.get_or_compute_detail(3, str(path)) == b and len(calls) == 4
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
    r = client.get(f'/api/tracks/{tid}/waveform/detail')
    assert r.status_code == 200 and r.headers['content-type'] == 'application/octet-stream'
    assert r.headers['cache-control'] and parse(r.content)['frames'] > 0
    etag = r.headers['etag']
    r2 = client.get(f'/api/tracks/{tid}/waveform/detail', headers={'If-None-Match': etag})
    assert r2.status_code == 304 and r2.content == b'' and r2.headers['etag'] == etag
    assert client.get(f'/api/tracks/{tid}/waveform/detail', headers={'If-None-Match': '"x"'}).status_code == 200
    assert client.get('/api/tracks/99999/waveform/detail').status_code == 404

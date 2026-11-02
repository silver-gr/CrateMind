"""Signed-PCM raster tests using generated samples and private temporary audio."""
import asyncio
import io
import math
import shutil
import struct
import subprocess
import sys
import threading
import time
import wave

import numpy as np
import pytest

from app.services import waveform_density as density


def reference(pcm, rate, pps, width, height, dpr):
    pcm = np.asarray(pcm)
    if pcm.ndim == 1:
        pcm = pcm[:, None]
    effective = int(min(height, (100 / .7) * dpr))
    padding = int((height - effective) / 2)
    kernel = np.ones(math.ceil(1.2 * dpr))
    if len(kernel) > 2:
        kernel[0] = kernel[-1] = .75
        kernel[len(kernel) // 2] = 1.5
    result = np.zeros((height, width), np.uint8)
    for column in range(width):
        lo = math.floor(column * rate / pps + .5)
        hi = min(len(pcm), math.floor((column + 1) * rate / pps + .5))
        block = pcm[lo:hi]
        n = len(block)
        if not n:
            continue
        hist = [0] * effective
        for frame in block:
            for sample in frame:
                row = int(np.clip(np.clip(sample, -1, 1) * (.7 * effective / 2) + effective / 2,
                                  1, effective - 2))
                hist[row] += 1
        occupied = [i for i, count in enumerate(hist) if count]
        first, last = occupied[0], occupied[-1]
        for k, weight in enumerate(kernel):
            x = column + k - len(kernel) // 2
            if not 0 <= x < width:
                continue
            for row in range(first, last + 1):
                a = min(255, 70 * (min(n, max(.3, hist[row])) *
                                      (10 * (last - first + 1) / (n * dpr))) ** .25)
                contribution = int(a * weight)
                y = height - 1 - (padding + row)
                old = int(result[y, x])
                result[y, x] = min(255, int((old ** 2.2 + contribution ** 2.2) ** (1 / 2.2)))
    return result


def raster(samples, *, rate=80, pps=16, width=16, height=40, dpr=1, tile=0, splits=()):
    geometry = density.Geometry(tile, pps, height, dpr)
    renderer = density.Raster(geometry, width=width, sample_rate=rate)
    begin, end = renderer.start_sample, renderer.end_sample
    relevant = samples[begin:end]
    for block in np.split(relevant, [cut for cut in splits if cut < len(relevant)]):
        renderer.feed(block)
    return renderer.finish()


@pytest.mark.parametrize('dpr', [.5, 1, 2, 3, 8])
@pytest.mark.parametrize('height', [2, 40, 300])
def test_exact_scalar_reference_for_signed_stereo_and_kernel(dpr, height):
    rng = np.random.default_rng(19)
    pcm = rng.uniform(-1.3, 1.3, (137, 2))
    actual = raster(pcm, height=height, dpr=dpr, width=32, splits=(1, 3, 17, 80, 129))
    expected = reference(pcm, 80, 16, 32, height, dpr)
    np.testing.assert_array_equal(actual, expected)


def test_equal_peak_and_rms_with_different_histograms_produce_different_alpha():
    a = np.array([1, -1, 1, -1, 0, 0, 0, 0])[:, None]
    b = np.array([1, -1, math.sqrt(.5), -math.sqrt(.5), math.sqrt(.5), -math.sqrt(.5), 0, 0])[:, None]
    assert np.max(np.abs(a)) == np.max(np.abs(b))
    assert np.mean(a * a) == pytest.approx(np.mean(b * b))
    first = raster(a, rate=128, width=1)
    second = raster(b, rate=128, width=1)
    assert np.count_nonzero(first != second) == 5


def test_signed_asymmetry_phase_safety_silence_and_absent_frames():
    positive = np.full((80, 1), .8)
    negative = -positive
    up = raster(positive)
    down = raster(negative)
    assert np.flatnonzero(up[:, 0])[0] < 20
    assert np.flatnonzero(down[:, 0])[0] > 20
    opposite = raster(np.column_stack([positive[:, 0], negative[:, 0]]))
    assert np.count_nonzero(opposite[:, 0]) > 10
    silence = raster(np.zeros((5, 2)))
    assert np.flatnonzero(silence[:, 0]).tolist() == [19]
    assert silence[19, 0] == 124 and np.count_nonzero(silence[:, 1:]) == 0
    assert not raster(np.zeros((0, 2))).any()


@pytest.mark.parametrize('dpr', [1, 2, 3, 8])
def test_streaming_chunks_and_adjacent_tile_halos_match_contiguous_raster(dpr):
    rng = np.random.default_rng(11)
    pcm = rng.normal(0, .3, (900, 2))
    full = raster(pcm, width=96, pps=17.3, dpr=dpr)
    joined = np.concatenate([raster(pcm, width=32, tile=tile, pps=17.3, dpr=dpr, splits=(1, 39, 127))
                             for tile in range(3)], axis=1)
    np.testing.assert_array_equal(joined, full)


@pytest.mark.parametrize('values', [(-1, 128, 40, 1), (0, 15, 40, 1), (0, float('nan'), 40, 1),
                                    (0, float('inf'), 40, 1), (0, 128, 1, 1), (0, 128, 1025, 1),
                                    (0, 128, 40, .4), (0, 128, 40, 9), (10**12, 128, 40, 1),
                                    (10**400, 128, 40, 1)])
def test_geometry_rejects_unbounded_requests(values):
    with pytest.raises(ValueError):
        density.Geometry(*values)


def test_header_is_exact_and_geometry_changes_source_request_digest(tmp_path):
    path = tmp_path / 'source.wav'
    path.write_bytes(b'synthetic bytes only')
    geometry = density.Geometry(2, 128, 40, 2)
    first = density.density_etag(str(path), geometry)
    assert first != density.density_etag(str(path), density.Geometry(2, 129, 40, 2))
    alpha = np.zeros((40, 2048), np.uint8)
    blob = density.encode(geometry, bytes.fromhex(first.strip('"')), alpha)
    header = struct.unpack_from('<4sHHIIddd16s', blob)
    assert density.HEADER.size == 56 and len(blob) == 56 + 40 * 2048
    assert header[:8] == (b'CMDN', 1, 0, 2048, 40, 32, 128, 2)
    path.write_bytes(b'changed synthetic bytes')
    assert first != density.density_etag(str(path), geometry)


def test_admission_busy_cancel_timeout_and_source_change_release_slots(tmp_path, monkeypatch):
    path = tmp_path / 'source.wav'
    path.write_bytes(b'synthetic')
    geometry = density.Geometry(0, 128, 40, 1)
    event = threading.Event()
    event.set()
    with pytest.raises(density.DensityCancelled):
        density.render_density(str(path), geometry, cancel_event=event)
    with pytest.raises(TimeoutError):
        density.render_density(str(path), geometry, deadline=time.monotonic() - 1)
    assert density.ADMISSION.acquire(False) and density.ADMISSION.acquire(False)
    try:
        with pytest.raises(density.DensityBusy):
            density.render_density(str(path), geometry)
    finally:
        density.ADMISSION.release()
        density.ADMISSION.release()
    def changed(*args, **kwargs):
        path.write_bytes(b'changed')
    monkeypatch.setattr(density, '_decode_into', changed)
    with pytest.raises(density.DensityChanged):
        density.render_density(str(path), geometry)
    assert density.ADMISSION.acquire(False) and density.ADMISSION.acquire(False)
    density.ADMISSION.release()
    density.ADMISSION.release()


@pytest.mark.skipif(not shutil.which('ffmpeg'), reason='ffmpeg required')
@pytest.mark.parametrize('channels', [1, 2])
@pytest.mark.parametrize('sample_rate', [8000, 44100])
def test_decode_is_read_only_and_seeking_matches_origin(tmp_path, channels, sample_rate):
    path = tmp_path / 'synthetic.wav'
    mono = np.sin(np.arange(sample_rate * 8) * .17) * .5
    pcm = mono if channels == 1 else np.column_stack([mono, -.3 * mono])
    with wave.open(str(path), 'wb') as out:
        out.setnchannels(channels)
        out.setsampwidth(2)
        out.setframerate(sample_rate)
        out.writeframes((pcm * 32767).astype('<i2').tobytes())
    before = path.read_bytes(), path.stat().st_mtime_ns
    geometry = density.Geometry(2, 1000.5, 40, 2)
    etag, blob = density.render_density(str(path), geometry)
    alpha = np.frombuffer(blob, np.uint8, offset=56).reshape(40, 2048)
    full = subprocess.run([shutil.which('ffmpeg'), '-nostdin', '-v', 'error', '-i', str(path),
                           '-map', '0:a:0', '-ar', '44100', '-f', 'f32le', '-'],
                          capture_output=True, check=True, timeout=5)
    actual_pcm = np.frombuffer(full.stdout, '<f4').reshape(-1, channels)
    expected = raster(actual_pcm, rate=44100, pps=1000.5, width=2048, tile=2, height=40, dpr=2)
    np.testing.assert_array_equal(alpha, expected)
    assert path.read_bytes() == before[0] and path.stat().st_mtime_ns == before[1]
    assert etag == '"' + blob[40:56].hex() + '"'


def test_route_density_geometry_busy_etag_and_stale_detail(client, tmp_path, monkeypatch):
    from tests.test_audio import _add_track
    from tests.conftest import make_wav
    from app.services.waveform_detail import detail_etag
    path = make_wav(tmp_path / 'fixture.wav', seconds=.1)
    tid = _add_track(str(path), 'wav')
    monkeypatch.setattr(density, '_decode_into', lambda *a, **k: None)
    url = f'/api/tracks/{tid}/waveform/density'
    response = client.get(url, params={'pixels_per_second': 128, 'height': 40, 'dpr': 2})
    assert response.status_code == 200 and len(response.content) == 56 + 2048 * 40
    assert response.headers['cache-control'] == 'private, no-cache'
    assert client.get(url, headers={'If-None-Match': response.headers['etag']},
                      params={'height': 40, 'dpr': 2}).status_code == 304
    for params in ({'tile_index': -1}, {'pixels_per_second': 'nan'}, {'pixels_per_second': 'inf'},
                   {'pixels_per_second': 8193}, {'height': 1025}, {'dpr': .4}, {'tile_index': 10**12}):
        assert client.get(url, params=params).status_code == 422
    assert client.get(url, params={'detail_digest': '0' * 32}).status_code == 409
    assert client.get(url, params={'detail_digest': detail_etag(str(path)).strip('"')}).status_code == 200
    assert density.ADMISSION.acquire(False) and density.ADMISSION.acquire(False)
    try:
        assert client.get(url).status_code == 503
    finally:
        density.ADMISSION.release()
        density.ADMISSION.release()
    assert client.get('/api/tracks/999999/waveform/density').status_code == 404


@pytest.mark.parametrize('payload', [b'', b'RIFF' + b'\0' * 8,
    b'RIFF' + b'\0' * 4 + b'WAVE' + b'JUNK' + struct.pack('<I', 1000000)])
def test_invalid_or_oversized_wav_headers_are_rejected(payload):
    with pytest.raises(density.DensityUnavailable):
        density._wav_channels(io.BytesIO(payload))


@pytest.mark.parametrize('cancel', [False, True])
def test_blocked_decoder_timeout_and_cancel_reap_child_and_release_slots(tmp_path, monkeypatch, cancel):
    from app.services.media_tools import ToolRunner
    path = tmp_path / 'source.wav'
    path.write_bytes(b'synthetic')
    runner = ToolRunner()
    original = runner.process
    header = struct.pack('<4sI4s4sIHHIIHH4sI', b'RIFF', 0xffffffff, b'WAVE', b'fmt ', 16,
                         3, 2, 44100, 44100 * 8, 8, 32, b'data', 0xffffffff)
    script = ("import sys,time;sys.stdout.buffer.write(bytes.fromhex('" + header.hex() +
              "'));sys.stdout.buffer.flush();time.sleep(30)")
    monkeypatch.setattr(runner, 'process', lambda command, **kwargs:
                        original([sys.executable, '-c', script], **kwargs))
    monkeypatch.setattr(density, 'media_tools', runner)
    monkeypatch.setattr(density.shutil, 'which', lambda name: sys.executable)
    event = threading.Event()
    timer = threading.Timer(.08, event.set) if cancel else None
    if timer:
        timer.start()
    try:
        with pytest.raises(density.DensityCancelled if cancel else TimeoutError):
            density.render_density(str(path), density.Geometry(0, 128, 40, 1), cancel_event=event,
                                   deadline=time.monotonic() + (3 if cancel else .08))
    finally:
        if timer:
            timer.cancel()
    assert not runner._children
    assert density.ADMISSION.acquire(False) and density.ADMISSION.acquire(False)
    density.ADMISSION.release()
    density.ADMISSION.release()


@pytest.mark.parametrize('disconnect', [False, True])
def test_async_route_cancellation_reaches_worker_and_releases_admission(tmp_path, monkeypatch, disconnect):
    from fastapi import HTTPException
    from types import SimpleNamespace
    from app.api.tracks import get_track_waveform_density
    path = tmp_path / 'source.wav'
    path.write_bytes(b'synthetic')
    entered, done = threading.Event(), threading.Event()
    def slow_worker(*args, cancel_event, **kwargs):
        try:
            entered.set()
            assert cancel_event.wait(2)
            raise density.DensityCancelled('Η εργασία ακυρώθηκε.')
        finally:
            done.set()
            density.ADMISSION.release()
    monkeypatch.setattr(density, 'render_density', slow_worker)
    class Request:
        headers = {}
        async def is_disconnected(self):
            return disconnect and entered.is_set()
    class Session:
        def get(self, *args):
            return SimpleNamespace(absolute_path=str(path))
    async def scenario():
        task = asyncio.create_task(get_track_waveform_density(
            1, Request(), 0, 128, 40, 1, None, Session()))
        if disconnect:
            with pytest.raises(HTTPException) as error:
                await task
            assert error.value.status_code == 499
        else:
            for _ in range(100):
                if entered.is_set():
                    break
                await asyncio.sleep(.005)
            assert entered.is_set()
            task.cancel()
            with pytest.raises(asyncio.CancelledError):
                await task
    asyncio.run(scenario())
    assert done.is_set()
    assert density.ADMISSION.acquire(False) and density.ADMISSION.acquire(False)
    density.ADMISSION.release()
    density.ADMISSION.release()


@pytest.mark.skipif(not shutil.which('ffmpeg'), reason='ffmpeg required')
def test_mapped_logical_source_reuses_detail_digest_without_resolving_physical_path(client, tmp_path, monkeypatch):
    import json
    from app.config import get_settings
    from app.services import library_paths
    from tests.conftest import make_wav
    from tests.test_audio import _add_track

    local_root = tmp_path / 'device-audio'
    path = make_wav(local_root / 'synthetic.wav', seconds=.1, freq_seed=9)
    logical_path = '/density-regression-origin/synthetic.wav'
    mappings = tmp_path / 'density-mappings.json'
    mappings.write_text(json.dumps({'version': 1, 'library_roots': [{
        'root_key': 'density-generated-library', 'logical_prefix': '/density-regression-origin',
        'logical_flavor': 'posix', 'local_prefix': str(local_root), 'enabled': True,
    }]}))
    monkeypatch.setattr(get_settings(), 'path_mappings_file', str(mappings))
    assert library_paths.resolve_source_path(logical_path) == path
    with pytest.raises(library_paths.PathResolutionError):
        library_paths.resolve_source_path(str(path))
    original = path.read_bytes(), path.stat().st_mtime_ns
    tid = _add_track(logical_path, 'wav')
    detail = client.get(f'/api/tracks/{tid}/waveform/detail')
    assert detail.status_code == 200
    digest = detail.content[32:48].hex()
    response = client.get(f'/api/tracks/{tid}/waveform/density', params={
        'detail_digest': digest, 'pixels_per_second': 128, 'height': 40, 'dpr': 2,
    })
    assert response.status_code == 200, response.text
    assert response.content[:4] == b'CMDN'
    assert np.frombuffer(response.content, np.uint8, offset=56).any()
    assert client.get(f'/api/tracks/{tid}/waveform/density', params={
        'detail_digest': '0' * 32,
    }).status_code == 409
    assert (path.read_bytes(), path.stat().st_mtime_ns) == original

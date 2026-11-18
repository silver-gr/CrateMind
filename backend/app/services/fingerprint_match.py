"""Same-recording detection from stored Chromaprint fingerprints (NumPy only, no libchromaprint).

`decode` reads fpcalc's compressed fingerprint (a port of chromaprint's FingerprintDecompressor). `same_audio_pairs`
finds tracks whose fingerprints line up with few differing bits: an inverted index of exact sub-fingerprint values
proposes candidates, and each candidate is scored at its best time shift. fpcalc fingerprints the first 120 s, so a
preview cut from the start of a track matches the full track; one cut from the middle does not.

Measured on the user's library (2026-11-18, `.omc/research/duplicate-audit-2026-11-18`): copies and previews of one
recording differ in at most ~10% of bits, while different psytrance tracks that merely sound alike differ in 12-20%.
"""
from __future__ import annotations

import base64

import numpy as np

ITEM_SECONDS = 4096 / 3 / 11025        # one sub-fingerprint ≈ 0.124 s
MAX_BIT_ERROR = 0.10                   # same recording at or below this share of differing bits
MIN_OVERLAP_SECONDS = 40.0
_MIN_SHARED_VALUES = 20                # exact sub-fingerprint values two tracks must share to be compared at all
_MAX_VALUE_TRACKS = 40                 # a value shared by more tracks (silence, a common kick) proposes nothing
_POPCOUNT = np.array([bin(i).count("1") for i in range(256)], dtype=np.uint8)


def _unpack(data: bytes, width: int) -> np.ndarray:
    """Little-endian packed `width`-bit integers (chromaprint's UnpackInt3Array / UnpackInt5Array)."""
    bits = np.unpackbits(np.frombuffer(data, dtype=np.uint8), bitorder="little")
    count = len(bits) // width
    return (bits[: count * width].reshape(count, width).astype(np.int64) << np.arange(width)).sum(axis=1)


def decode(fingerprint: str) -> np.ndarray:
    """fpcalc's compressed, URL-safe base64 fingerprint -> its sub-fingerprints (uint32). Raises ValueError."""
    raw = base64.urlsafe_b64decode(fingerprint + "=" * (-len(fingerprint) % 4))
    if len(raw) < 4:
        raise ValueError("fingerprint too short")
    count = int.from_bytes(raw[1:4], "big")
    if count == 0:
        return np.zeros(0, dtype=np.uint32)
    normal = _unpack(raw[4:], 3)
    ends = np.flatnonzero(normal == 0)
    if len(ends) < count:
        raise ValueError("fingerprint truncated")
    normal = normal[: ends[count - 1] + 1]
    exceptional = np.flatnonzero(normal == 7)
    if len(exceptional):
        start = 4 + (len(normal) * 3 + 7) // 8
        extra = _unpack(raw[start:], 5)
        if len(extra) < len(exceptional):
            raise ValueError("fingerprint truncated")
        normal = normal.copy()
        normal[exceptional] += extra[: len(exceptional)]
    # Each sub-fingerprint is a run of bit-position deltas ended by a 0; positions restart at every run.
    run = np.concatenate(([0], np.cumsum(normal == 0)[:-1]))
    totals = np.cumsum(normal)
    starts = np.concatenate(([0], totals[np.flatnonzero(normal == 0)][:-1]))
    position = totals - starts[run]
    bits = np.where(normal > 0, np.left_shift(np.int64(1), np.maximum(position - 1, 0)), 0)
    xored = np.bincount(run, weights=bits.astype(np.float64), minlength=count).astype(np.uint64).astype(np.uint32)
    return np.bitwise_xor.accumulate(xored)


def _bit_error(a: np.ndarray, b: np.ndarray, shift: int) -> tuple[float, int]:
    lo, hi = max(0, shift), min(len(a), len(b) + shift)
    if hi <= lo:
        return 1.0, 0
    diff = (a[lo:hi] ^ b[lo - shift:hi - shift]).view(np.uint8)
    return float(_POPCOUNT[diff].sum()) / (32 * (hi - lo)), hi - lo


def _best_alignment(a: np.ndarray, b: np.ndarray) -> tuple[float, int]:
    """(bit error rate, overlapping sub-fingerprints) at the shift most exact values agree on."""
    order = np.argsort(a, kind="stable")
    ordered = a[order]
    left, right = np.searchsorted(ordered, b, "left"), np.searchsorted(ordered, b, "right")
    counts = right - left
    total = int(counts.sum())
    if total == 0:
        return 1.0, 0
    ends = np.cumsum(counts)
    in_a = order[np.repeat(left, counts) + np.arange(total) - np.repeat(ends - counts, counts)]
    shifts, votes = np.unique(in_a - np.repeat(np.arange(len(b)), counts), return_counts=True)
    best = (1.0, 0)
    for shift in shifts[np.argsort(-votes, kind="stable")[:5]].tolist():
        error, overlap = _bit_error(a, b, shift)
        if overlap >= 40 and error < best[0]:
            best = (error, overlap)
    return best


def same_audio_pairs(fingerprints: dict[int, np.ndarray]) -> list[tuple[int, int, float, float]]:
    """Track pairs with the same recording: (a, b, bit error rate, overlap in seconds), a < b."""
    ids = sorted(t for t, fp in fingerprints.items() if len(fp))
    if len(ids) < 2:
        return []
    uniques = [np.unique(fingerprints[t]) for t in ids]
    values = np.concatenate(uniques)
    owner = np.repeat(np.arange(len(ids), dtype=np.int64), [len(u) for u in uniques])
    order = np.argsort(values, kind="stable")
    values, owner = values[order], owner[order]
    starts = np.r_[0, np.flatnonzero(np.diff(values)) + 1]
    sizes = np.diff(np.r_[starts, len(values)])
    keys = []
    n = len(ids)
    for size in range(2, _MAX_VALUE_TRACKS + 1):         # every value shared by `size` tracks at once
        groups = starts[sizes == size]
        if not len(groups):
            continue
        members = owner[groups[:, None] + np.arange(size)]
        i, j = np.triu_indices(size, 1)
        low, high = np.minimum(members[:, i], members[:, j]), np.maximum(members[:, i], members[:, j])
        keys.append((low * n + high).ravel())
    if not keys:
        return []
    pair_keys, shared = np.unique(np.concatenate(keys), return_counts=True)
    found = []
    for key in pair_keys[shared >= _MIN_SHARED_VALUES].tolist():
        a, b = ids[key // n], ids[key % n]
        error, overlap = _best_alignment(fingerprints[a], fingerprints[b])
        if error <= MAX_BIT_ERROR and overlap * ITEM_SECONDS >= MIN_OVERLAP_SECONDS:
            found.append((a, b, error, overlap * ITEM_SECONDS))
    return found

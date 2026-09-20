# Waveform v2 verification

44.1 kHz stereo float decoding, streamed in bounded PCM blocks. Separate sample-peak and RMS envelopes in 1024-sample windows (23.22ms), capped at 32768 returned points while retaining peak transients. Silence is zero. No mono phase cancellation or window-by-window normalization. Source path/size/mtime and engine version invalidate disk caches. Atomic cache writes and striped locks prevent partial or simultaneous recomputation. Frontend keys cached data by track modification timestamp.

Canvas renders one bar per four CSS pixels with a one-pixel gap (reduced after visual feedback), capped at available samples. Peak silhouette and RMS body are distinct; playback redraw uses cached layers and does not regenerate the waveform. Source audio is unchanged.

| Track | Duration | Previous points | New points | First v2 call | Cached v2 call |
|---|---:|---:|---:|---:|---:|
| SPACE ALCHEMIST — MARINHEIRO [193 BPM] | 417.8s | 160 | 17995 | 0.435s | 0.0068s |
| KiLLATK vs BioChronic — We're Not Aliens | 515.0s | 160 | 22180 | 0.421s | 0.0077s |
| StadiumX — Wonderland (PhaZed Rmx) | 382.5s | 160 | 16473 | 0.377s | 0.0059s |

Timings are a three-track spot check, including decoding, on the same machine; OS cache and concurrent work are uncontrolled. First-call files did not have a v2 disk cache.

Validation: 12 backend waveform/audio tests passed, including 8kHz content, opposite-phase stereo, exact silence, final-sample impulse, RMS versus peaks, resolution cap, cache hits, changed/deleted source and legacy cache invalidation. Frontend build passed. Browser checks confirmed one bar/4 CSS pixels, Retina resolution, responsive resizing and stable seek/buffering dimensions. Both fixture and live-API browser checks passed after restart; the live API returned version 2 with 16473 peaks and RMS points for track 4194.

Activation complete: user authorized restart and started the backend. Live endpoint and canvas verified. Interrupted analysis job 56 marked error (last recorded progress 4781/4781), preserving its saved track results.

Visual comparison: comparison.png. Raw old/new envelopes and timings are alongside this report. Old data uses per-track normalized low-band peaks; new data uses linear full-band amplitudes.

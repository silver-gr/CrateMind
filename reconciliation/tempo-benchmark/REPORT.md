# Three-track BPM benchmark

Read-only benchmark of three 60-second sections starting at 30, 120 and 210 seconds. Reference tempos were supplied by the user from djay/title evidence and were not provided to the analyzers. They are reference values, not independently established ground truth.

The existing rule is unchanged: double raw estimates below 109 BPM; otherwise retain them. No catalog or source audio changes. This benchmark covers BPM only, not key.

| Track | Reference | Stored librosa v1 | Refined librosa | Essentia degara | Essentia multifeature |
|---|---:|---:|---:|---:|---:|
| We're Not Aliens | 190 | 191.4 | 194.44 | 189.98 | 189.98 |
| MARINHEIRO [193 BPM] | 193 | 191.4 | 194.67 | 192.68 | 192.68 |
| All Is Mind ૐ 190 ૐ | 190 | 191.4 | 129.4 | 189.95 | 189.98 |

Values are medians of the three sections, except the stored baseline, which came from the prior first-120-second implementation. This is not a same-window baseline comparison.

## Interpretation

- Essentia wins this small sample: both modes have median errors under 0.33 BPM and all nine segment estimates are within 0.5 BPM of the supplied references.
- Multifeature did not show a decisive accuracy advantage over degara here; it provides confidence, while degara confidence is undefined and recorded as null.
- The proposed librosa refinement uses hop_length=128 and measures tempo across 16 tracked beat intervals. This particular refinement is not suitable for adoption: beat tracking drifts and sometimes selects another rhythmic pulse. This does not establish that all librosa approaches are inferior.
- All three tracks are flagged for engine disagreement using an explicit benchmark threshold of >1 BPM between engine medians. No production flags were updated.
- Agreement between the two Essentia modes should not count as two independent engine votes.
- Do not floor estimates before doubling. Essentia estimates near 95 and 96.5 retain the distinctions needed for 190 and 193.

## Timing

Timing covers analysis only, excluding ffmpeg decoding and network/database reads; it is a single-run measurement, not a performance benchmark. First librosa call includes initialization/JIT overhead.
- librosa_refined: median 0.714s per 60-second section; range 0.690–13.585s.
- essentia_degara: median 0.126s per 60-second section; range 0.121–0.174s.
- essentia_multifeature: median 0.406s per 60-second section; range 0.384–0.496s.

## Recommendation

Prefer evaluating Essentia as the primary BPM engine on a broader psytrance sample, retaining the current doubling rule and storing source-specific estimates. These three tracks alone are insufficient to justify a library-wide replacement or to assess key accuracy. The benchmark does not change the production analyzer.

Reproduce from repository root: `backend/.venv/bin/python reconciliation/tempo-benchmark/benchmark.py`. Package versions are recorded in `environment.json`; segment-level results are in `results.json`.

# 210 BPM benchmark

First ten distinct tracks in the supplied screenshot, in display order. Duplicate copies were excluded; the available first Soul Burn copy was used, not the missing file. The Calabi Yau track is titled “bpm” in the catalog. All ten use 210 BPM as the user-supplied reference.

Three 60-second sections per file, starting at 30, 120 and 210 seconds. The analyzers received no expected tempo or title hints. The existing doubling rule (<109 BPM) remains unchanged. No catalog values, flags, settings or audio files were updated.

| Track | Refined librosa | Essentia degara | Essentia multifeature |
|---|---:|---:|---:|
| From An Other World (210Bpm) | 213.25 | 209.63 | 209.4 |
| Idiophatic [210] | 210.33 | 209.97 | 210.0 |
| bpm | 210.67 | 208.85 | 209.22 |
| Echoes (210) | 210.0 | 209.82 | 210.04 |
| Soul Burn (210) | 210.13 | 209.05 | 210.0 |
| Supersymmetry | 210.13 | 209.97 | 209.97 |
| Out Of My Comfort Zone [210] | 215.68 | 209.59 | 209.97 |
| Assimilation (210) | 214.22 | 209.96 | 209.96 |
| No Comment (210Bpm) | 213.39 | 209.96 | 210.0 |
| Cyber Optics [210] | 210.07 | 210.04 | 210.0 |

Values above are medians across sections.

## Accuracy against the 210 reference

| Engine | Mean absolute error (track medians) | Track medians within 1 BPM | Sections within 1 BPM | Median seconds/section |
|---|---:|---:|---:|---:|
| librosa_refined | 1.787 | 6/10 | 15/30 | 0.668 |
| essentia_degara | 0.324 | 9/10 | 25/30 | 0.122 |
| essentia_multifeature | 0.152 | 10/10 | 29/30 | 0.392 |

Timings exclude ffmpeg decoding and include first-call initialization in the relevant first sample. Single run; not a controlled speed benchmark.

## Key extraction (exploratory, no verified reference keys)

Essentia KeyExtractor uses its installed defaults at 44100 Hz. Strength is an algorithm score, not a calibrated probability of correctness. Different sections can produce different keys. Existing catalog keys are shown only as comparison values, not ground truth.

| Track | Existing catalog key | Essentia keys across sections |
|---|---|---|
| From An Other World (210Bpm) | F major | C major (3/3) |
| Idiophatic [210] | A major | D minor (1/3); F major (1/3); Eb minor (1/3) |
| bpm | C# minor | C# major (2/3); D minor (1/3) |
| Echoes (210) | A major | B minor (2/3); D major (1/3) |
| Soul Burn (210) | E major | A minor (2/3); A major (1/3) |
| Supersymmetry | C# minor | C# minor (2/3); Ab minor (1/3) |
| Out Of My Comfort Zone [210] | E minor | Ab major (2/3); Ab minor (1/3) |
| Assimilation (210) | A major | Ab major (1/3); Bb minor (2/3) |
| No Comment (210Bpm) | C# minor | C major (2/3); B major (1/3) |
| Cyber Optics [210] | C# minor | C major (3/3) |

## Limits and provenance

- Experimental refined librosa uses hop_length=128 and 16-beat span timing. This is one candidate implementation, not a benchmark of every librosa technique.
- Essentia methods share implementation components; agreement is not two independent engine votes.
- The 210 BPM references come from the user/catalog/title context, not an independently annotated beat grid.
- Engine disagreement/review flags in results.json are benchmark-only: >1 BPM between engine medians, or >1 BPM error against the supplied reference.
- BPM findings do not establish key accuracy. Verify keys against trusted manual or djay references before adopting them.
- Scripts: ../benchmark_210.py and ../report_210.py. Versions: ../environment.json. All segment values and runtime measurements: results.json.

# Independent 100-track BPM benchmark

Frozen sample: 100 of 421 eligible tracks, seed 20260920. Title-based references were never passed to either engine. No catalog values, audio files, settings or default analyzers were changed.

## Selection

- Accepted standalone three-digit numbers followed by BPM (case-insensitive, with or without space), or enclosed in parentheses/brackets. Attached letters/digits/underscore, decimals, and conflicting title values were rejected or held.
- Held unavailable audio, files shorter than 270 seconds, and references outside 135–250 BPM. Duplicate artist/title copies were excluded.
- Sample spans 140–250 BPM. The unchanged Essentia maximum is 240: the 250 BPM case is retained and reported, not silently dropped.
- Full accepted sample and held cases with reasons: selection.json. Existing track metadata was not used as a reference when it disagreed with the title.

## Protocol

Three 60-second sections per track at offsets 30, 120 and 210 seconds. New librosa-onset estimator: 22050 Hz, hop_length=128; clipped positive onset flux, overlap-normalized autocorrelation, grid search 135–250 BPM in 0.02 BPM steps, weighted periodicity over 24 beat multiples. No beat-pick regression or title hint. Essentia: 44100 Hz, degara and multifeature, minTempo=60 and maxTempo=240. Every raw BPM below 109 is doubled; no flooring or forced integer snapping.

Results are evaluated against title claims, not manually annotated beat grids. This is one candidate librosa refinement, not all possible librosa algorithms. The stored librosa v1 values are retained in results.json but were measured using a different window; they are not a controlled same-window baseline.

## Results

| Engine | Mean absolute error | Median absolute error | Tracks ±0.5 BPM | Tracks ±1 BPM | Sections ±1 BPM |
|---|---:|---:|---:|---:|---:|
| librosa_refined | 0.061 | 0.0 | 99/100 | 99/100 | 295/300 |
| essentia_degara | 14.039 | 0.365 | 55/100 | 59/100 | 174/300 |
| essentia_multifeature | 9.7 | 0.135 | 65/100 | 68/100 | 196/300 |

## Half-time diagnostic (no correction applied)

Counted only when the reported tempo is wrong by >1 BPM but doubling it would be within 1 BPM of the title reference. This uses the reference for diagnosis only and does not change output values.

- librosa_refined: 0 half-time cases: 
- essentia_degara: 8 half-time cases: 892, 891, 3501, 4681, 3958, 4623, 1260, 4843
- essentia_multifeature: 8 half-time cases: 892, 891, 3501, 4681, 3958, 4623, 1260, 4843

## Individual results

| ID | Track | Title BPM | Refined librosa | Degara | Multifeature |
|---|---|---:|---:|---:|---:|
| 3622 | The Hippy Trail to Goa [170] | 170 | 170.0 | 172.27 | 172.27 |
| 4062 | Eye Light (186) | 186 | 186.0 | 185.94 | 185.94 |
| 4758 | Desert Blooming (206 bpm) | 206 | 206.0 | 205.61 | 206.0 |
| 1726 | The New Era Take Two (191Bpm) | 191 | 191.0 | 190.87 | 191.0 |
| 892 | Soul Shredder [228] FREE | 228 | 228.0 | 113.82 | 113.96 |
| 2665 | Yamakas i-Akumu-210Bpm | 210 | 210.0 | 209.96 | 209.96 |
| 2511 | FRAGMENTS [178 BPM] | 178 | 178.0 | 177.84 | 178.0 |
| 2251 | Destruction Bitch [175BPM] | 175 | 175.0 | 172.27 | 172.27 |
| 1704 | Blood Line (202Bpm) | 202 | 202.0 | 134.72 | 201.69 |
| 2582 | License to Thrill (182) | 182 | 182.0 | 182.0 | 184.57 |
| 5138 | Mushrooms & Cloud (194) | 194 | 194.0 | 193.99 | 193.99 |
| 67 | UNDEFINED GAPS [195 BPM] | 195 | 195.02 | 129.98 | 195.02 |
| 891 | Magnetic Massacre [220] | 220 | 219.92 | 109.92 | 109.99 |
| 4842 | Singularity of Frequencies (175Bpm) | 175 | 175.02 | 172.27 | 172.27 |
| 1767 | MORNING WIPE [186 BPM] | 186 | 186.0 | 185.96 | 185.96 |
| 3106 | Ritual (192)IMARAKA MASTER | 192 | 192.0 | 192.02 | 192.02 |
| 2862 | Kasandnetik (186bpm) | 186 | 185.98 | 186.05 | 186.05 |
| 2474 | Eternal Core (191) | 191 | 190.98 | 190.95 | 191.0 |
| 824 | Autophagy [165] | 165 | 165.0 | 164.77 | 165.01 |
| 431 | So Damn Tough (Feat. VG)(Mad Scientist Rmx) [200] | 200 | 199.98 | 199.85 | 199.96 |
| 1264 | Elements [198] | 198 | 198.0 | 197.99 | 198.01 |
| 1711 | The New Psychedelic Era (200Bpm) | 200 | 199.98 | 198.97 | 199.24 |
| 2549 | Psychonauts Theory (200 Bpm) (Trisulam Tribe Records) | 200 | 199.98 | 200.04 | 200.0 |
| 1262 | Lunar Dreams [206] | 206 | 205.98 | 206.0 | 206.0 |
| 2428 | Cryptographic | 154 | 154.0 | 153.9 | 153.9 |
| 3012 | Mayas Chants (164) | 164 | 164.06 | 163.78 | 163.98 |
| 2915 | Spiral Stares (195BPM) on ZT | 195 | 195.02 | 195.01 | 194.97 |
| 3501 | Nago [230] | 230 | 229.98 | 114.7 | 114.83 |
| 1428 | 3D Alien [190] | 190 | 190.0 | 189.77 | 189.94 |
| 1936 | STAR FACTORY 2.0 [182] | 182 | 182.0 | 184.57 | 184.57 |
| 4681 | Lethal Poison (220) | 220 | 219.92 | 110.03 | 110.01 |
| 4374 | Looping Universe [194] | 194 | 194.0 | 193.98 | 193.99 |
| 3177 | Kiss Me (200) | 200 | 200.0 | 199.77 | 199.99 |
| 3015 | Apocalypse (198) | 198 | 198.0 | 197.63 | 197.89 |
| 2307 | BOVERIA [195 BPM] | 195 | 195.02 | 130.0 | 195.06 |
| 2859 | Love in The Air [178] | 178 | 177.98 | 118.48 | 178.15 |
| 1551 | Shiva Tandava Stotram [160] | 160 | 159.98 | 161.5 | 161.5 |
| 3310 | 👹Akumu-210Bpm👹 | 210 | 210.0 | 209.96 | 209.96 |
| 2540 | Hyper Dimensions (175) | 175 | 175.02 | 172.27 | 172.27 |
| 3958 | Starfire [222] | 222 | 222.02 | 110.99 | 110.99 |
| 1427 | Pairidaeza [200] | 200 | 200.0 | 199.8 | 199.87 |
| 129 | EXIT VECTOR | 186 | 186.0 | 186.05 | 186.01 |
| 1031 | Peter on Crack [214] | 214 | 213.98 | 213.94 | 213.98 |
| 5034 | Signal (170bpm) | 170 | 170.0 | 172.27 | 172.27 |
| 2618 | キル来攻 [175] | 175 | 175.0 | 172.27 | 172.27 |
| 3539 | Se Essa Rua Fosse Minha [180BPM] | 180 | 179.96 | 178.21 | 179.71 |
| 4623 | Perfect Happiness [220] | 220 | 219.92 | 109.95 | 109.96 |
| 3267 | Shri Mahant Managaland Puri (190 BPM ) | 190 | 190.0 | 189.85 | 189.86 |
| 3706 | Pine [175] | 175 | 175.0 | 172.27 | 172.27 |
| 553 | Africa [192] | 192 | 192.0 | 192.02 | 192.02 |
| 4617 | China ◢◤(DØN4lĐ T Я U m P is Ⱥ F****N' I D I Ø͓T) [200BPM] | 200 | 199.98 | 200.04 | 200.01 |
| 1877 | Escola de Samba (180) | 180 | 179.98 | 178.21 | 179.84 |
| 1720 | HighSociety (186 Bpm) | 186 | 185.98 | 123.99 | 185.97 |
| 1260 | G-sy minor [220] | 220 | 219.92 | 109.99 | 110.0 |
| 1269 | Strange Energy [180] | 180 | 180.02 | 178.21 | 178.21 |
| 5042 | Omnia Munda Mundis (163bpm) | 163 | 163.0 | 163.03 | 163.09 |
| 1768 | UNDERWATER SEADANCE [194 BPM] | 194 | 194.0 | 193.96 | 194.0 |
| 5054 | Non-Stop Cabaret [206] | 206 | 206.0 | 206.0 | 205.96 |
| 4659 | Space Bandits [196] | 196 | 195.98 | 196.0 | 196.04 |
| 1707 | Mushroom Trip (196Bpm) | 196 | 196.0 | 195.64 | 195.64 |
| 620 | Bleeps N Shit [192] | 192 | 192.0 | 191.39 | 191.39 |
| 4772 | Dezerta Spiro (212 bpm) | 212 | 212.02 | 212.13 | 211.97 |
| 4414 | Soundless Singing Humblebees (195 Bpm) | 195 | 195.02 | 194.51 | 194.91 |
| 5037 | Zabala (170bpm) | 170 | 170.0 | 169.42 | 170.04 |
| 4839 | Canticos De Aedrin (176 bpm) | 176 | 176.0 | 178.21 | 178.21 |
| 131 | LOST IN TRANSIT | 172 | 172.0 | 172.27 | 172.27 |
| 4680 | I Will Kill U (206) | 206 | 206.0 | 205.91 | 205.71 |
| 550 | Cybernetics [200] (Robot ́s EP ) | 200 | 200.0 | 199.91 | 200.0 |
| 5036 | Mega Ritual (145bpm) | 145 | 145.02 | 144.75 | 144.89 |
| 60 | NEUROSYNC [175 BPM] | 175 | 175.02 | 172.27 | 172.27 |
| 2947 | Vis Vitalis [215] | 215 | 215.02 | 214.2 | 214.2 |
| 1721 | Shanti (175Bpm) | 175 | 175.0 | 172.27 | 172.27 |
| 2578 | Helix (185) | 185 | 185.0 | 184.85 | 184.85 |
| 2656 | [200] 2 Crazy Brothers (VA ALIEN CONTROL compiled by Holy Manullu) | 200 | 200.0 | 199.74 | 200.03 |
| 4609 | Singularity Mirage (190) | 190 | 190.0 | 189.95 | 189.95 |
| 4743 | Nexo Void [181] | 181 | 181.0 | 178.21 | 178.21 |
| 3580 | Intrication [197 BPM] | 197 | 197.0 | 196.99 | 196.52 |
| 2615 | Psychonauts Theory (200 Bpm) (Trisulam Tribe Records) | 200 | 199.98 | 200.04 | 200.0 |
| 3443 | Gold Island | 152 | 152.0 | 152.0 | 152.0 |
| 2444 | Engines (170) | 170 | 170.0 | 113.26 | 172.27 |
| 5090 | Sad Girlz Luv Money [185] | 185 | 185.0 | 184.56 | 184.57 |
| 4160 | Supernova Strikers (190) | 190 | 190.0 | 189.71 | 190.02 |
| 3579 | Unattainable [186 BPM] | 186 | 186.0 | 184.86 | 185.76 |
| 1323 | Backpack Ready (170) | 170 | 170.0 | 113.35 | 172.27 |
| 2871 | Narayana (165 Bpm) | 165 | 165.0 | 164.42 | 164.98 |
| 404 | The Weeping Song (Cover) [170] | 170 | 170.0 | 172.27 | 172.27 |
| 1815 | LION-TECH (185BPM) | 185 | 184.96 | 183.86 | 184.54 |
| 80 | Kali Does The Dance (Magnetik Sadhu Remix) [160] | 160 | 160.0 | 161.6 | 161.55 |
| 1252 | It can't be that hard to find a Name [197] | 197 | 197.0 | 196.99 | 197.0 |
| 2931 | The World That Never Exists [190BPM] | 190 | 190.0 | 189.99 | 189.99 |
| 5050 | Meadu for the Evening (194bpm) | 194 | 194.0 | 193.81 | 193.81 |
| 3014 | Pagan Vibes (185) | 185 | 185.0 | 184.57 | 184.57 |
| 4841 | Mystical Sufi Experience (212 bpm) | 212 | 212.02 | 211.75 | 212.0 |
| 2583 | Driving Force (180) | 180 | 179.98 | 178.21 | 178.21 |
| 4843 | Explosion (240Bpm) | 240 | 240.02 | 120.01 | 119.95 |
| 3875 | Swimming To The Unknown 175-180 Bpm | 180 | 175.02 | 172.27 | 172.27 |
| 1780 | Back (170 BPM) | 170 | 169.98 | 172.27 | 172.27 |
| 3006 | Shamanic Ceremony [174] [demo] | 174 | 174.0 | 172.27 | 172.27 |
| 233 | Kaikkialla Vs Girisha -Vision On Brutality [200] unmastered | 200 | 200.0 | 200.0 | 200.0 |
| 1723 | Walter White (175Bpm) | 175 | 175.0 | 172.27 | 172.27 |

## Multifeature outliers (>1 BPM from title)

- 3622 The Hippy Trail to Goa [170]: reference 170; segment BPM [172.27, 172.27, 172.27]. Requires review; title or estimator may be wrong.
- 892 Soul Shredder [228] FREE: reference 228; segment BPM [114.0, 112.75, 113.96]. Requires review; title or estimator may be wrong.
- 2251 Destruction Bitch [175BPM]: reference 175; segment BPM [172.27, 172.27, 172.27]. Requires review; title or estimator may be wrong.
- 2582 License to Thrill (182): reference 182; segment BPM [184.57, 184.57, 184.57]. Requires review; title or estimator may be wrong.
- 891 Magnetic Massacre [220]: reference 220; segment BPM [109.99, 109.99, 109.43]. Requires review; title or estimator may be wrong.
- 4842 Singularity of Frequencies (175Bpm): reference 175; segment BPM [172.27, 172.27, 172.27]. Requires review; title or estimator may be wrong.
- 3501 Nago [230]: reference 230; segment BPM [114.97, 114.83, 114.74]. Requires review; title or estimator may be wrong.
- 1936 STAR FACTORY 2.0 [182]: reference 182; segment BPM [184.57, 184.57, 184.57]. Requires review; title or estimator may be wrong.
- 4681 Lethal Poison (220): reference 220; segment BPM [110.01, 110.0, 110.08]. Requires review; title or estimator may be wrong.
- 1551 Shiva Tandava Stotram [160]: reference 160; segment BPM [161.5, 161.5, 161.65]. Requires review; title or estimator may be wrong.
- 2540 Hyper Dimensions (175): reference 175; segment BPM [172.27, 172.27, 172.27]. Requires review; title or estimator may be wrong.
- 3958 Starfire [222]: reference 222; segment BPM [110.88, 110.99, 111.0]. Requires review; title or estimator may be wrong.
- 5034 Signal (170bpm): reference 170; segment BPM [169.32, 172.27, 172.27]. Requires review; title or estimator may be wrong.
- 2618 キル来攻 [175]: reference 175; segment BPM [172.27, 172.27, 172.27]. Requires review; title or estimator may be wrong.
- 4623 Perfect Happiness [220]: reference 220; segment BPM [109.9, 146.65, 109.96]. Requires review; title or estimator may be wrong.
- 3706 Pine [175]: reference 175; segment BPM [172.27, 172.27, 172.27]. Requires review; title or estimator may be wrong.
- 1260 G-sy minor [220]: reference 220; segment BPM [110.0, 109.99, 110.15]. Requires review; title or estimator may be wrong.
- 1269 Strange Energy [180]: reference 180; segment BPM [178.21, 178.21, 180.11]. Requires review; title or estimator may be wrong.
- 4839 Canticos De Aedrin (176 bpm): reference 176; segment BPM [178.21, 178.21, 176.19]. Requires review; title or estimator may be wrong.
- 60 NEUROSYNC [175 BPM]: reference 175; segment BPM [172.27, 172.27, 172.27]. Requires review; title or estimator may be wrong.
- 1721 Shanti (175Bpm): reference 175; segment BPM [172.27, 172.27, 172.27]. Requires review; title or estimator may be wrong.
- 4743 Nexo Void [181]: reference 181; segment BPM [178.21, 178.21, 178.21]. Requires review; title or estimator may be wrong.
- 2444 Engines (170): reference 170; segment BPM [172.27, 172.27, 172.27]. Requires review; title or estimator may be wrong.
- 1323 Backpack Ready (170): reference 170; segment BPM [172.27, 172.27, 172.27]. Requires review; title or estimator may be wrong.
- 404 The Weeping Song (Cover) [170]: reference 170; segment BPM [172.27, 172.27, 172.27]. Requires review; title or estimator may be wrong.
- 80 Kali Does The Dance (Magnetik Sadhu Remix) [160]: reference 160; segment BPM [212.74, 161.55, 161.5]. Requires review; title or estimator may be wrong.
- 2583 Driving Force (180): reference 180; segment BPM [178.21, 178.21, 178.21]. Requires review; title or estimator may be wrong.
- 4843 Explosion (240Bpm): reference 240; segment BPM [119.95, 120.02, 119.94]. Requires review; title or estimator may be wrong.
- 3875 Swimming To The Unknown 175-180 Bpm: reference 180; segment BPM [172.27, 116.72, 172.27]. Requires review; title or estimator may be wrong.
- 1780 Back (170 BPM): reference 170; segment BPM [172.27, 172.27, 172.27]. Requires review; title or estimator may be wrong.
- 3006 Shamanic Ceremony [174] [demo]: reference 174; segment BPM [172.27, 173.95, 115.85]. Requires review; title or estimator may be wrong.
- 1723 Walter White (175Bpm): reference 175; segment BPM [172.27, 172.27, 172.27]. Requires review; title or estimator may be wrong.

## Timing and interpretation

Analysis-only median seconds per 60-second segment (decoding excluded, first-call initialization included): librosa_refined: 0.179s, essentia_degara: 0.147s, essentia_multifeature: 0.463s. These are single-run timings, not a controlled throughput benchmark.

Method agreement is not independent evidence when algorithms share components. Benchmark review flags (>1 BPM between engine medians or against the reference) exist only in the result artifact. No key extraction was performed in this run.

Reproduce: run ../select_holdout.py once to freeze a sample, then ../benchmark_holdout.py and ../report_holdout.py. This run used three bounded processes with shard arguments 0, 1, 2; ../merge_holdout.py combines the saved parts. Runtime measurements after resuming include concurrent workload. Benchmark resumes from completed IDs in results.json. Environment versions are in ../environment.json.

## Holdout verification and interpretation

Zero overlap by track ID or exact artist/title with the prior 100-track sample. Selection also excluded the earlier 210 BPM sample and development tracks. The algorithm was developed on the original three tracks and CONSCIOUSNESS, then frozen before this independent run; no reference tempos were fed to its estimator.

This compares configured pipelines, not library brands: the new algorithm combines librosa onset features with SciPy autocorrelation and a psytrance-specific 135–250 BPM search. Essentia retains its existing 60–240 range and doubling rule. This domain prior is part of the new algorithm's advantage. No production implementation was changed.

The sole >1 BPM discrepancy is track 3875, Kokobloko — Swimming To The Unknown 175-180 Bpm. New results: 175.00, 175.02, 175.02 BPM. The parser extracted 180 from the title's range, so it is an ambiguous reference, not a confirmed error. The frozen headline remains 99/100; verify later sections against djay before assigning one fixed ground truth.

## Subsequent user verification of the range-title case

The user confirmed that track 3875 combines two recordings. The first is 175 BPM, matching all three benchmark windows. The second is 181 BPM in the combined YouTube file but 180 BPM as a separate download. With the first-section reference corrected from the parser's 180 to the verified 175, the new estimator is within 1 BPM on all 100 track medians in this holdout. This is a post-benchmark reference correction, not an estimator change. Frozen original metrics remain 99/100. This does not mean every section or arbitrary track is correct: the later beatless outro produced a spurious tempo.

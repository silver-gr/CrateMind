# 100-track title BPM benchmark

Frozen sample: 100 of 527 eligible tracks, seed 20260919. Title-based references were never passed to either engine. No catalog values, audio files, settings or default analyzers were changed.

## Selection

- Accepted standalone three-digit numbers followed by BPM (case-insensitive, with or without space), or enclosed in parentheses/brackets. Attached letters/digits/underscore, decimals, and conflicting title values were rejected or held.
- Held unavailable audio, files shorter than 270 seconds, and references outside 135–250 BPM. Duplicate artist/title copies were excluded.
- Sample spans 140–250 BPM. The unchanged Essentia maximum is 240: the 250 BPM case is retained and reported, not silently dropped.
- Full accepted sample and held cases with reasons: selection.json. Existing track metadata was not used as a reference when it disagreed with the title.

## Protocol

Three 60-second sections per track at offsets 30, 120 and 210 seconds. Refined librosa: 22050 Hz, hop_length=128, tempo median followed by median tempo measured over 16 tracked beat intervals. Essentia: 44100 Hz, degara and multifeature, minTempo=60 and maxTempo=240. Every raw BPM below 109 is doubled; no flooring or forced integer snapping.

Results are evaluated against title claims, not manually annotated beat grids. This is one candidate librosa refinement, not all possible librosa algorithms. The stored librosa v1 values are retained in results.json but were measured using a different window; they are not a controlled same-window baseline.

## Results

| Engine | Mean absolute error | Median absolute error | Tracks ±0.5 BPM | Tracks ±1 BPM | Sections ±1 BPM |
|---|---:|---:|---:|---:|---:|
| librosa_refined | 22.979 | 0.215 | 52/100 | 53/100 | 138/300 |
| essentia_degara | 8.31 | 0.265 | 61/100 | 67/100 | 189/300 |
| essentia_multifeature | 5.201 | 0.085 | 71/100 | 73/100 | 213/300 |

## Half-time diagnostic (no correction applied)

Counted only when the reported tempo is wrong by >1 BPM but doubling it would be within 1 BPM of the title reference. This uses the reference for diagnosis only and does not change output values.

- librosa_refined: 1 half-time cases: 5144
- essentia_degara: 4 half-time cases: 3329, 117, 5144, 3418
- essentia_multifeature: 4 half-time cases: 3329, 117, 5144, 3418

## Individual results

| ID | Track | Title BPM | Refined librosa | Degara | Multifeature |
|---|---|---:|---:|---:|---:|
| 1028 | Samsara !(142) (no-master) | 142 | 141.95 | 141.98 | 142.02 |
| 3546 | A Sign of Hope [185] | 185 | 184.98 | 184.88 | 184.89 |
| 1326 | Vacation's Over (175) | 175 | 119.06 | 116.69 | 172.27 |
| 3329 | Panspermia) (250 bpm) | 250 | 126.92 | 125.29 | 124.94 |
| 4182 | SHE'S A MANIAC (REMIX) [185] | 185 | 131.77 | 184.57 | 184.57 |
| 2680 | Space Butterfly ƸӜƷ [208] | 208 | 211.34 | 208.21 | 208.28 |
| 552 | The Feeling Element [212] | 212 | 212.02 | 211.95 | 212.0 |
| 647 | Fear Of (160)(VA-SONIC PORTAL) | 160 | 159.94 | 161.5 | 161.55 |
| 4667 | What You Waiting For (190) | 190 | 126.72 | 189.97 | 190.0 |
| 984 | Epiphany (180 BPM) | 180 | 121.33 | 178.21 | 178.21 |
| 117 | Tone Of The Third Toke [230] | 230 | 116.87 | 114.79 | 114.98 |
| 3117 | Consumption Side [155] | 155 | 154.99 | 154.45 | 154.45 |
| 118 | Creature Of Darkness (168bpm) | 168 | 168.06 | 165.84 | 166.62 |
| 3768 | Lost Detectives 🔎 [💀 +180 BPM 💀] | 180 | 120.01 | 178.21 | 178.21 |
| 26 | Epiphany [208] (Original Mix) | 208 | 208.02 | 208.07 | 208.0 |
| 329 | SubFusion [148 BPM] | 148 | 148.05 | 147.94 | 147.99 |
| 3318 | Mad Mood [192] | 192 | 192.07 | 191.9 | 191.97 |
| 3276 | The Philosophy of Time Travel [210] | 210 | 210.0 | 209.92 | 209.86 |
| 2493 | Sifer Vs Noctem Vox [185] | 185 | 185.09 | 185.01 | 185.01 |
| 4666 | Sealed Majestic [200] | 200 | 206.01 | 199.67 | 200.01 |
| 5048 | Harsh Jazz (170bpm) | 170 | 169.96 | 172.27 | 172.27 |
| 3017 | Mysteries (196) | 196 | 196.06 | 196.01 | 195.99 |
| 1254 | Dugara (Hazey Remix) [174] | 174 | 120.98 | 172.27 | 172.27 |
| 2579 | Unaffected (192) | 192 | 192.18 | 191.28 | 192.08 |
| 63 | EXALUV [190 BPM] | 190 | 189.98 | 189.98 | 189.98 |
| 1293 | I Believe [160] | 160 | 159.94 | 161.55 | 161.55 |
| 4441 | Straight Outta Space (200 Bpm) | 200 | 199.97 | 199.77 | 200.0 |
| 2632 | Odyn hero (180 bpm ) Free Dowload/NO MASTER/ | 180 | 180.25 | 178.21 | 180.37 |
| 2581 | The Time is Now (175) | 175 | 119.15 | 172.27 | 172.27 |
| 886 | 200 - 177bpm (FREE DOWNLOAD) | 177 | 175.0 | 172.27 | 172.27 |
| 5150 | Area 51 (170) | 170 | 169.96 | 172.27 | 172.27 |
| 5144 | Acethylcholine (220) | 220 | 110.03 | 109.98 | 109.98 |
| 1710 | Cheap Musik (172Bpm) | 172 | 116.96 | 172.27 | 172.27 |
| 2443 | Body Language (170) | 170 | 116.96 | 172.27 | 172.27 |
| 434 | Miami Sunrise (170) | 170 | 115.89 | 172.27 | 172.27 |
| 4063 | Affirmation (195) | 195 | 195.13 | 194.42 | 194.98 |
| 536 | Space Jumping Morons [150 BPM] | 150 | 150.07 | 150.1 | 150.08 |
| 371 | FireLight (190) | 190 | 190.09 | 190.03 | 189.97 |
| 4677 | Electronic Freestyle (205) | 205 | 205.18 | 204.9 | 204.99 |
| 20 | Space Monkey [164 Bpm] | 164 | 163.98 | 163.9 | 163.99 |
| 56 | Lambada Dance (200) | 200 | 200.09 | 198.36 | 199.83 |
| 4757 | Lahn Salibi (183 bpm) | 183 | 183.04 | 182.81 | 183.02 |
| 1077 | Horus of the Two Horizons [180 BPM] on ADN Music | 180 | 120.01 | 178.21 | 184.57 |
| 4467 | Something on Your Mind [200] | 200 | 199.97 | 200.05 | 199.66 |
| 1268 | Hubble Revisits Tangled [200] | 200 | 200.09 | 133.36 | 199.94 |
| 798 | Hyperekplexia-Horror Meets Electricity [190] | 190 | 189.98 | 189.77 | 189.98 |
| 4420 | Secret Weapon (196) | 196 | 196.17 | 195.58 | 196.03 |
| 370 | YOUniverse [182] (Original Mix) | 182 | 182.08 | 184.57 | 181.96 |
| 3615 | мечты [190 BPM] | 190 | 126.82 | 189.79 | 189.99 |
| 2488 | Elixir of Gods (190) | 190 | 190.09 | 189.76 | 189.95 |
| 1741 | WORLD PROBLEMS (190 BPM) | 190 | 131.98 | 190.17 | 189.91 |
| 1266 | A.P.U ON [185] | 185 | 126.14 | 185.1 | 185.02 |
| 28 | Space Butterfly ƸӜƷ [208] | 208 | 211.34 | 208.21 | 208.28 |
| 3678 | Idiophatic [210] | 210 | 210.33 | 209.97 | 210.0 |
| 2195 | Get Up Stand Up N' Fight (Marambá Remix)[180] | 180 | 180.05 | 178.21 | 178.21 |
| 3418 | Meteorite (220) | 220 | 113.35 | 110.08 | 110.08 |
| 3086 | Psychedelic Soberness (190 BPM) | 190 | 129.81 | 190.02 | 189.91 |
| 2201 | Bella Ciao Remix [180] | 180 | 123.88 | 178.21 | 178.21 |
| 4819 | The Forsaken [215] | 215 | 215.05 | 214.83 | 214.83 |
| 2735 | Mystic Soul [192] (Extended Mix) | 192 | 130.73 | 191.87 | 192.04 |
| 2513 | LAST TRANSMISSION [180 BPM] | 180 | 180.05 | 178.21 | 178.21 |
| 3757 | India Calling For Ever पराक्रमी विष्णु //164 BPM | 164 | 136.45 | 164.02 | 163.93 |
| 3514 | Mirage (192) | 192 | 132.62 | 191.58 | 191.99 |
| 1250 | Space Traveler [175] | 175 | 119.23 | 172.27 | 172.27 |
| 547 | Eur Zuria ~ (168 BPM) IN BANDCAMP | 168 | 168.06 | 165.61 | 166.38 |
| 235 | Trapped Affirmatives (200 BPM) | 200 | 203.16 | 199.92 | 199.96 |
| 3016 | LaGhetto (193) | 193 | 193.08 | 192.79 | 192.79 |
| 5044 | I Think People are the Greatest Fun (165bpm) | 165 | 165.04 | 164.46 | 165.0 |
| 4628 | Another Dimension (205 Bpm) | 205 | 205.12 | 205.13 | 205.13 |
| 5137 | Lush Glitch (189) | 189 | 128.7 | 188.67 | 188.13 |
| 1249 | Dreams [205] | 205 | 205.05 | 204.93 | 205.06 |
| 983 | It ́s Now (162 BPM) | 162 | 126.39 | 162.02 | 161.99 |
| 5141 | You Don't Know (185) | 185 | 184.98 | 123.29 | 184.99 |
| 2306 | KIUBA [198 BPM] | 198 | 199.73 | 197.44 | 197.96 |
| 3702 | Duende [140] | 140 | 140.03 | 140.02 | 139.93 |
| 4690 | We Are Gods (DAiiVa Rmx) [195] | 195 | 134.78 | 194.84 | 195.01 |
| 3769 | Cryptanite [150] | 150 | 150.07 | 150.05 | 150.03 |
| 1248 | Time Travel Stuff [210] | 210 | 216.11 | 209.86 | 209.92 |
| 3389 | Indigenous Alchemy (Emersound RMX) [191] (OVNI RECORDS 07) | 191 | 191.52 | 190.89 | 191.0 |
| 4750 | AstroPartickles [200] | 200 | 206.59 | 199.69 | 199.99 |
| 2676 | Live [205] | 205 | 205.05 | 204.98 | 204.98 |
| 2794 | Hyperekplexia-Sigil Of Malice (175) | 175 | 119.06 | 172.27 | 172.27 |
| 3621 | Grande Noite [168] | 168 | 168.06 | 166.35 | 166.54 |
| 2451 | Crystalized [148] | 148 | 148.05 | 148.01 | 148.02 |
| 2186 | Modern Raving [💀 +170 BPM 💀] | 170 | 120.19 | 172.27 | 172.27 |
| 5112 | Kali Mela (172 bpm) | 172 | 114.68 | 172.27 | 172.27 |
| 955 | The Big Train Robbery (192) | 192 | 195.02 | 191.77 | 191.98 |
| 5061 | Muscat Sunset (210 bpm) | 210 | 210.0 | 209.81 | 210.04 |
| 3709 | Toroid [145] | 145 | 144.94 | 144.98 | 145.01 |
| 119 | All Day Every Day (185bpm) | 185 | 184.98 | 184.57 | 184.57 |
| 5060 | LV-426 [178] | 178 | 121.15 | 118.67 | 178.18 |
| 2807 | Sys$Horizon [190] | 190 | 129.2 | 189.99 | 189.99 |
| 1703 | No Comment (210Bpm) | 210 | 213.39 | 209.96 | 210.0 |
| 950 | Lost Nomad (185) | 185 | 125.95 | 184.57 | 184.57 |
| 5147 | Grids & Patterns (200) | 200 | 204.55 | 199.74 | 199.9 |
| 4692 | Beatfighter [183] | 183 | 123.23 | 182.74 | 182.84 |
| 2304 | CaveZone [185 BPM] | 185 | 184.98 | 184.91 | 184.92 |
| 68 | FULL MELT [181 BPM] | 181 | 124.44 | 120.74 | 178.21 |
| 2997 | Arcana Power [194] | 194 | 130.94 | 193.2 | 193.99 |
| 3613 | Bulletholes Within [200BPM] | 200 | 200.09 | 199.67 | 199.87 |

## Multifeature outliers (>1 BPM from title)

- 1326 Vacation's Over (175): reference 175; segment BPM [172.27, 117.2, 172.27]. Requires review; title or estimator may be wrong.
- 3329 Panspermia) (250 bpm): reference 250; segment BPM [116.75, 125.29, 124.94]. Requires review; title or estimator may be wrong.
- 647 Fear Of (160)(VA-SONIC PORTAL): reference 160; segment BPM [161.59, 161.5, 161.55]. Requires review; title or estimator may be wrong.
- 984 Epiphany (180 BPM): reference 180; segment BPM [179.99, 178.21, 178.21]. Requires review; title or estimator may be wrong.
- 117 Tone Of The Third Toke [230]: reference 230; segment BPM [114.75, 115.01, 114.98]. Requires review; title or estimator may be wrong.
- 118 Creature Of Darkness (168bpm): reference 168; segment BPM [166.62, 166.62, 166.71]. Requires review; title or estimator may be wrong.
- 3768 Lost Detectives 🔎 [💀 +180 BPM 💀]: reference 180; segment BPM [178.21, 179.93, 178.21]. Requires review; title or estimator may be wrong.
- 5048 Harsh Jazz (170bpm): reference 170; segment BPM [172.27, 172.27, 172.27]. Requires review; title or estimator may be wrong.
- 1254 Dugara (Hazey Remix) [174]: reference 174; segment BPM [172.27, 115.99, 172.27]. Requires review; title or estimator may be wrong.
- 1293 I Believe [160]: reference 160; segment BPM [172.27, 161.5, 161.55]. Requires review; title or estimator may be wrong.
- 2581 The Time is Now (175): reference 175; segment BPM [172.27, 172.27, 172.27]. Requires review; title or estimator may be wrong.
- 886 200 - 177bpm (FREE DOWNLOAD): reference 177; segment BPM [172.27, 172.27, 172.27]. Requires review; title or estimator may be wrong.
- 5150 Area 51 (170): reference 170; segment BPM [172.27, 172.27, 172.27]. Requires review; title or estimator may be wrong.
- 5144 Acethylcholine (220): reference 220; segment BPM [109.98, 109.99, 109.91]. Requires review; title or estimator may be wrong.
- 2443 Body Language (170): reference 170; segment BPM [172.27, 172.27, 172.27]. Requires review; title or estimator may be wrong.
- 434 Miami Sunrise (170): reference 170; segment BPM [172.27, 169.57, 172.27]. Requires review; title or estimator may be wrong.
- 1077 Horus of the Two Horizons [180 BPM] on ADN Music: reference 180; segment BPM [184.57, 184.57, 184.57]. Requires review; title or estimator may be wrong.
- 2195 Get Up Stand Up N' Fight (Marambá Remix)[180]: reference 180; segment BPM [178.21, 178.21, 184.57]. Requires review; title or estimator may be wrong.
- 3418 Meteorite (220): reference 220; segment BPM [109.99, 110.15, 110.08]. Requires review; title or estimator may be wrong.
- 2201 Bella Ciao Remix [180]: reference 180; segment BPM [129.25, 178.21, 184.57]. Requires review; title or estimator may be wrong.
- 2513 LAST TRANSMISSION [180 BPM]: reference 180; segment BPM [178.21, 179.74, 178.21]. Requires review; title or estimator may be wrong.
- 1250 Space Traveler [175]: reference 175; segment BPM [172.27, 172.27, 116.68]. Requires review; title or estimator may be wrong.
- 547 Eur Zuria ~ (168 BPM) IN BANDCAMP: reference 168; segment BPM [165.2, 166.38, 166.67]. Requires review; title or estimator may be wrong.
- 2794 Hyperekplexia-Sigil Of Malice (175): reference 175; segment BPM [172.27, 172.27, 172.27]. Requires review; title or estimator may be wrong.
- 3621 Grande Noite [168]: reference 168; segment BPM [166.54, 167.98, 166.35]. Requires review; title or estimator may be wrong.
- 2186 Modern Raving [💀 +170 BPM 💀]: reference 170; segment BPM [172.27, 172.27, 178.21]. Requires review; title or estimator may be wrong.
- 68 FULL MELT [181 BPM]: reference 181; segment BPM [178.21, 178.21, 178.21]. Requires review; title or estimator may be wrong.

## Timing and interpretation

Analysis-only median seconds per 60-second segment (decoding excluded, first-call initialization included): librosa_refined: 1.236s, essentia_degara: 0.141s, essentia_multifeature: 0.444s. These are single-run timings, not a controlled throughput benchmark.

Method agreement is not independent evidence when algorithms share components. Benchmark review flags (>1 BPM between engine medians or against the reference) exist only in the result artifact. No key extraction was performed in this run.

Reproduce: run ../select_100.py once to freeze a sample, then ../benchmark_100.py and ../report_100.py. This run resumed after 17 tracks using three bounded processes with shard arguments 0, 1, 2; ../merge_100.py combines the saved parts. Runtime measurements after resuming include concurrent workload. Benchmark resumes from completed IDs in results.json. Environment versions are in ../environment.json.

## Assessment

Multifeature leads this sample, but 73/100 within 1 BPM is not a clean replacement result. Four misses are close half-time estimates that the unchanged <109 rule does not double. Other estimates repeatedly cluster at 172.27 or 178.21 BPM. Investigate these before assuming title numbers are wrong or trusting every decimal.

The parser also admits explicit +170/+180 BPM text. Such qualifiers may describe a lower bound rather than an exact reference (IDs 2186 and 3768); both are retained in the frozen sample and the headline metrics, with this caveat. Track 886 contains another bare number (200) alongside its explicit 177bpm token and merits reference review. None of these cases were removed after seeing results.

The fourth FELE title was not legible in the screenshot and remains pending user clarification; the three identifiable tracks were tested before this extended run.

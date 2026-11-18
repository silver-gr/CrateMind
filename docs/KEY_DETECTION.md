# Key detection

CrateMind estimates each track's musical key from the audio. The code is `backend/app/services/key_detect.py` (librosa's constant-Q transform, NumPy for the rest). It runs in «Ανάλυση BPM + Key», writes only `tracks.key_analyzed`, its confidence and `key_analyzed_method`, and never writes to audio files, tags or DJ apps.

## Which key a track shows

1. A key tag in the file.
2. CrateMind's own key, when its confidence is at least 0.7.
3. djay's key, when djay's analysis was imported (`tracks.key_djay`, kept in step with the djay rows on import, on removal and at start-up).
4. CrateMind's own key at any confidence.

The order lives in `services/musical_key.py` (`effective_key`, `OWN_KEY_MIN_CONFIDENCE`) and `frontend/src/lib/camelot.ts` (`fallbackKey`); keep the two in step. The profile editor's tooltip names the source. Step 2 applies only to keys from a method whose confidence was measured (`CALIBRATED_KEY_METHODS`); a key from the older method always comes after djay's.

**Why 0.7.** djay and CrateMind were compared on tracks with a known key (2026-11-18). Where the two give different keys:

| | Our confidence 0.7 and up | Below 0.7 |
|---|---|---|
| GiantSteps+, labelled by people | ours right 41, djay 17 (of 73) | djay right 24, ours 21 (of 69) |
| Library, where Traktor and Serato agree | ours right 58, djay 17 (of 81) | djay right 48, ours 32 (of 97) |

The rule scores 75.8% on GiantSteps (always ours 75.2%, always djay 70.8%) and 93.3% on the library reference (92.3%, 90.7%); any limit from 0.6 to 0.8 gives nearly the same.

djay stores its key as an index from 0 to 23: an even index 2i is the major key on pitch i (0 = C major, 2 = C♯ major …), and the odd index after it is that key's relative minor (1 = A minor, 3 = A♯ minor …). The mapping was measured against Traktor's and Serato's keys for the same 3,551 tracks.

## The method

1. Decode the whole track (up to 20 minutes) to mono at 22,050 Hz. The first analysis pass decodes once and uses the first 120 s of the same audio for the BPM.
2. Constant-Q magnitude, 36 bins per octave from C1 over seven octaves, tuning-corrected by librosa's estimate.
3. Average over 2-second blocks, then log-compress against the track's loudest block: `log(1 + 1000 · C / max C)`.
4. Sum the three bins of each semitone, giving 84 semitones with the octaves kept apart. Scale each block so its strongest semitone is 1, and average the blocks. Centre the result and scale it to unit length.
5. Score each of the 24 keys: rotate the profile so the key's tonic comes first in every octave, and take the weighted sum with `WEIGHTS_MAJOR` or `WEIGHTS_MINOR` (7 octaves × 12 semitones each; minor keys also add `MINOR_OFFSET`). A softmax over the 24 scores gives the key and, as its confidence, the key's probability.

The weights were trained (multinomial logistic regression, L-BFGS) on 3,377 tracks whose key two or three DJ apps (djay, Traktor, Serato) agree on; 93 of them are major. Two settings, chosen on the library alone: almost no L2 penalty (3e-6), and major-key tracks up-weighted by (minor count / major count) to the power 0.75. The rule for choosing them: the best held-out accuracy that keeps at least as many major keys right as averaged profiles did.

Changing anything here needs a new `METHOD` string. The analysis's key phase then re-keys every track whose stored method is older, without running BPM or the online providers again.

## How well it works

Measured on 2026-11-18 with the harness in `.omc/research/key-eval` (not in git). Everything on the library is held out: weights are trained on four fifths of the tracks and scored on the other fifth, split by artist folder, so no artist is on both sides. "Old" is the method before this one: Krumhansl-Schmuckler profiles over librosa's chroma of the first 120 s. "Averaged" is an intermediate version: one average profile per mode over the folded 12 pitch classes, with a small minor bias.

| Test | Old | Averaged | Trained (shipped) |
|---|---|---|---|
| Library, all 3,377 reference tracks | 46.7% | 73.8% | **87.8%** |
| Library, the 1,398 tracks all three apps agree on | 55.5% | 84.8% | **95.4%** |
| GiantSteps+, 476 excerpts labelled by people | 55.0% | 67.2% | **75.2%** |
| Major keys found, library (of 93) / GiantSteps (of 63) | 55 / 39 | 57 / 37 | 57 / 40 |

**GiantSteps+ is the independent check.** The GiantSteps+ EDM Key Dataset (Zenodo 1095691, CC BY-SA 4.0) holds two-minute Beatport excerpts with keys annotated by people, from tech house, deep house, progressive, electro house, trance, drum & bass, techno and more. The weights never saw it: they are trained on the library only, and nothing from the dataset is in CrateMind.

**Against the DJ apps, on keys labelled by people.** djay Pro 5.6.11, Traktor Pro 4.5.1 and Serato DJ Pro analysed the same GiantSteps+ excerpts (471 with one clear key and a key from every app):

| | Exact key | Major keys found (of 63) |
|---|---|---|
| Traktor | 76.9% | 36 |
| **CrateMind** | **75.2%** | **40** |
| djay | 70.7% | 38 |
| Serato | 66.9% | 23 |

Head to head, CrateMind is right where djay is wrong on 62 excerpts and the reverse on 41; against Traktor 41 and 49 (a tie within chance); against Serato 83 and 44. These excerpts are house, techno, trance and drum & bass. On the psytrance library the apps rank differently (see below), so no single app is best everywhere.

**Against the DJ apps, on the library.** Where two apps agree, how often does the third app give the same key, and how often does CrateMind, on the same tracks:

| Reference | Third app | Old | Trained |
|---|---|---|---|
| djay and Traktor agree (1,726 tracks) | Serato 81.0% | 50% | 91.3% |
| djay and Serato agree (1,669) | Traktor 83.8% | 51% | 88.9% |
| Traktor and Serato agree (1,542) | djay 90.7% | 50% | 92.3% |

This table flatters CrateMind: its weights were trained on these apps' agreement (on other artists' tracks), so it has learned their habits, while each app was built without seeing the other two.

**How good the apps' agreement is as a reference.** On GiantSteps, the key all three apps agree on is the human key on 94.3% of 264 excerpts; a key at least two agree on, on 81.0% of 431. So the library's three-app tracks are a sound reference and the two-app tracks a noisier one.

**The confidence means something.** On held-out library tracks:

| Confidence | Tracks | Right |
|---|---|---|
| below 0.50 | 279 | 46% |
| 0.50 – 0.70 | 425 | 68% |
| 0.70 – 0.90 | 673 | 89% |
| 0.90 – 0.99 | 1,139 | 97% |
| 0.99 and up | 861 | 99% |

On GiantSteps it runs a little high (0.99 and up: 92% right; below 0.70: 42%).

**What each change brought** (library / GiantSteps, exact key):
- Whole track instead of the first 120 s, log compression and profiles averaged from the reference tracks instead of textbook profiles: 46.7% → 73.8% / 55.0% → 67.2%. The textbook profiles called a minor track major about one time in five.
- Weights trained to separate the keys, instead of the class average: 73.8% → 79.1% / 67.2% → 70.8%.
- Keeping the seven octaves apart instead of folding them into 12 pitch classes: 79.1% → 87.8% / 70.8% → 75.2%.

**Settings and how sensitive they are.** With an L2 penalty anywhere from 3e-5 to 1e-6 the result stays within 87.4–87.9% on the library and 74.6–76.3% on GiantSteps. A strong penalty underfits (1e-3: 84.7% and 65.5%, and almost no major keys). The up-weighting of major keys trades accuracy on minor tracks for major keys found: none at all never predicts a major key; 0.5 gives 89% / 77% but 47 of 93 and 36 of 63 majors; 1.0 gives 85% / 72% with 64 and 41.

**Tried and rejected:** leaving out the sub-bass octave (32–65 Hz; it carries the root, accuracy falls by 13–23 points), voting over 30-second windows, weighting blocks by how tonal they look, giving the bass more or less weight, and a large minor bias on averaged profiles.

## Limits

- The reference is the DJ apps' agreement, not keys checked by ear, and the weights are trained on it: where the apps share a mistake, CrateMind has learned it. Tracks the apps agree on are the easier ones, so the library numbers are optimistic. GiantSteps, labelled by people, is the check that does not depend on the apps.
- The library is psytrance and related styles, 97% minor; the major weights come from 93 tracks. Music that is mostly in major keys is less well covered (GiantSteps: 40 of 63 majors).
- On other electronic music expect about three keys in four right. The misses there are unrelated keys (11%), a fifth away (6%), major/minor on the same tonic (4%) and the relative key (3%).
- One key per track: a track that modulates gets the key it spends most time in.
- It takes about 5 seconds per track (whole-track constant-Q transform); a re-key of a 5,000-track library runs for about an hour with eight workers.
- The weights are trained on every reference track, including those only two apps agree on (about one in five of such keys is wrong by the human labels). Training on the three-app tracks alone is untested.

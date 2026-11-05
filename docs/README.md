# CrateMind

Local-first personal DJ intelligence layer. Scans your music library, lets you
attach DJ taste metadata (energy / darkness / set role / status / …), finds
duplicates, builds sets with a transparent recommender, and exports safe
artifacts (M3U8 / CSV / JSON backup / Markdown).

**It owns taste metadata and listening bookmarks. It does not touch beatgrids or
cue points in other DJ apps, and it never writes to, moves or locks DJ-app files. An opt-in import may read them: the library database from a private copy, and per-track analysis files in place, read-only.** It never deletes or moves audio files.

## Quick start

The new Tauri desktop build reuses this Python backend. See
[desktop operations](TAURI_DESKTOP_OPERATIONS.md) for self-contained builds,
safe enrollment, folder mapping and complete two-way handoff. Desktop computes
BPM/key locally; the BPM review and SoundCloud/Spotify processing remain
web-owned. The legacy Deno application and
its `desktop/` source were retired on 2026-10-29. The shared backend retains its
bounded importer for existing Deno libraries; implementation tests use generated
fixtures and do not migrate the live library.

### Backend

```bash
cd backend
uv sync

# configure library paths
cp ../.env.example .env
# edit .env -> set CRATEMIND_LIBRARY_ROOTS to your music folder(s)

uv run uvicorn app.main:app --reload --port 8000
```

API docs at http://localhost:8000/docs

### Frontend

```bash
cd frontend
bun install
bun run dev
```

App at http://localhost:5173 (proxies `/api` to the backend).

### Tests

```bash
cd backend && uv run pytest
```

## Workflow

1. Set library roots in `backend/.env`, start backend; scan from **Settings**. Settings also runs **Fingerprint** (Chromaprint) and **Audio analysis (BPM + key)** (ffmpeg) jobs.
2. **Dashboard** → review-queue cards with live counts (Forgotten Approved,
   New Untagged, Long Break Candidates, Weapons, Duplicate Suspects) plus your
   **Memory Crates**. Click a card to open those tracks.
3. **Library** → search (field syntax + FTS), tag via the profile panel, pick an
   *Active set* and add results to it, or **Save as crate** to pin a search.
4. **Tagging Queue** → rapid keyboard tagging of untagged tracks.
5. **Duplicates** → review and resolve duplicate groups (never auto-deletes).
6. **Set Builder** → assemble a set, see BPM/energy/darkness curves and
   transition warnings, ask for the next track *or* a **bridge between** two
   adjacent tracks (recommendations show every reason, including transition
   pair-note memory), record pair notes, **Mark set played**, and export.
7. **Set transitions** → every adjacent pair gets a transition pill; open it to
   edit and preview the transition, then **Play as mix** (`Αναπαραγωγή ως μίξη`)
   to hear the whole set as one continuous mix on the two decks.

### Set transitions

Each adjacent pair in a set has a transition, keyed by the ordered pair
`(set, from track, to track)` in the `set_transitions` table, so it survives
reorders (a pair that is no longer adjacent is ignored). Without a saved row the
pair is **Auto** (`Αυτόματο`): a transparent rule picks a preset from key, BPM and
profile, and the pill shows the reasons in its tooltip.

| Preset (UI) | Key | Volume | EQ | Filter | Bars |
|---|---|---|---|---|---|
| Ξεθώριασμα | `fade` | smooth crossfade | none | none | 4 |
| Άνοδος | `rise` | overlap | bass swap at end | LP in / HP out | 8 |
| Ανάμειξη | `blend` | overlap | 3-band fade | none | 8 |
| Κύμα | `wave` | overlap | bass swap at centre | LP in / LP out | 8 |
| Λιώσιμο | `melt` | fade in / fade out | bass swap at centre | HP in / HP out | 8 |
| Κόψιμο | `slam` | centre cut | quick bass cut | none | 1 |
| Διάλυση | `dissolve` | fade in / cut out | bass swap at end | HP half out | 8 |
| Έκρηξη | `surge` | overlap | bass swap at start | HP in | 4 (+ 4-beat loop) |
| Απόηχος | `afterglow` | smooth crossfade | bass swap at centre | none | 8 |
| Χωρίς μετάβαση | `none` | cut | none | none | 0 |

Auto rules: the incoming playback rate is `fold(from_bpm / to_bpm)` into
[0.707, 1.414). Unknown BPM → Fade without tempo match; |rate − 1| > 0.16 →
Slam (1 bar, no tempo match); a compatible key (same, adjacent or relative on
the Camelot wheel) with |rate − 1| ≤ 0.03 → Blend; a `safe_blend` transition
role → Blend; a `dramatic_cut` role → Slam; a compatible key → Afterglow;
otherwise Fade. Changing any parameter makes the preset **Custom** (`Προσαρμογή`).

Routes: `GET /api/sets/{id}/transitions` (every adjacent pair, saved or Auto),
`POST /api/sets/{id}/transitions` (save one pair; anchors outside the track
return 422), `DELETE /api/sets/{id}/transitions/{from}/{to}` (back to Auto).
Writes are audited and the table is part of the JSON backup and restore.

**Editor.** Dual zoomed waveform with the bar grid and the volume/EQ/filter
curves; a draggable N-bar window (rubber-band at the track bounds) with
single-pointer and keyboard alternatives: bar-length select and ±1 bar, bar/beat
nudges for the window and for the incoming entry, ←/→ (beat), Shift+←/→ (bar),
Alt+←/→ (incoming entry), `[`/`]` (length). Preview plays the unsaved draft on
the decks from 4 bars before the window; Space toggles it.

**Continuous mix.** `Αναπαραγωγή ως μίξη` loads the first track on Deck A and
the second on Deck B. Bars are counted on the outgoing grid; the window starts
at the last exit cue after the midpoint (else so that it ends at the track end)
and the incoming track enters at its first entry cue (else its first downbeat).
Deck B is armed at T0 − 4 s with a sample-accurate scheduled start, matches the
outgoing grid tempo, then ramps back to its own tempo over 8 bars. Volume, EQ
and filter automation runs on a per-deck stage before the mixer, so a user's
fader/EQ move adds to it instead of cancelling it. Key lock is on for both decks
during the session and restored afterwards. The status strip shows now / next, a
countdown, `Παράλειψη` (start the transition at the next bar) and `Διακοπή`.
A manual load or eject on a deck stops the session; a reorder or removal in the
Set Builder rebuilds the upcoming queue. Tracks that cannot use the stretch
engine (element fallback) get a cut; AIFF tracks are skipped with a toast.

Limitations: the same track twice in a set shares one transition; there is no
effects row; phase alignment is only as good as the grid (an estimated grid can
be off by up to half a beat); the tempo ramp-back is a 50 ms main-thread ramp;
QA runs in Chromium while the desktop app uses WebKit.

### Listening cues

While listening, press physical **I** for Entry, **O** for Exit, or **C** for a
general Cue. The compact player also has **+ Entry**, **+ Exit**, **+ Cue**, and
**Cues** controls. Capture is immediate, needs no label, and works while paused.
Only the player owning playback keys handles shortcuts; buttons target their
own player. Typing, dialogs, modified keys, and held-key repeats do not capture.

Open **Cues** to seek, label, change type or timestamp (`m:ss.SSS`), adjust by
0.1 seconds, or explicitly confirm deletion. Seeking preserves play/pause.
Entry and Exit are independent bookmarks: multiple points are allowed in any
order, and an Exit does not stop playback.

Cues live in SQLite's `track_cues` table, tied to the audio track's own ID.
They survive reloads, restarts, rescans, and temporarily missing files; deleting
the actual track row removes its cues. They are never copied between matches or
written into music files. Positions are integer milliseconds. The API allows
100ms beyond a known finite positive duration for metadata/rounding differences;
unknown duration adds no artificial limit. Cue operations do not reload audio
or log plays.

### Memory Crates (v1.1)

A Memory Crate is a saved search that re-runs live over your taste metadata —
like a Serato smart crate, but personal. Build a query in the Library, hit
**Save as crate**, and it shows on the Dashboard with a live count. The flagship
"Forgotten Approved" crate is `status:approved not_recent:90`. Recency tokens
become real once you log plays (**▶ played** in the profile panel, or
**Mark set played** after practice).

### BPM windows (Phase B)

BPM analysis reads tempos inside a window, and anything outside it comes back
doubled or halved.

**DJ windows.** In the DJ profile, «Εύρος BPM ανάλυσης» in Ρυθμίσεις picks the
window for new analyses:
- «Psy / hi-tech (133–286)», the default;
- «Μικτό 4/4 (118–250)»;
- «Αργά / downtempo (70–125)».

**Per-folder windows.** Each music folder in Ρυθμίσεις can have its own window,
so a mixed library can analyse a downtempo folder with «Αργά».

**Tracks already analysed.** These keep their values until you choose
otherwise:
- Use «Ανάλυση BPM» on a Library selection, on all search results, or on a
  crate (Crates). You pick the window there, see how many tracks it covers,
  and only the local analysis runs.
- A full «Επανανάλυση» uses each folder's window or the default, so it
  replaces windows chosen for a crate or a selection.

The «Αργά» window is narrower than an octave, so use it only for slow
material.

**Therapy profile.** The «Μουσικοθεραπεία» profile always uses its own
40–240 estimator, which has no pull toward 120 and never doubles.
- 6/8 reads at the rocking dotted-quarter pulse, and 3/4 reads at the beat.
- Music with no steady pulse gets no BPM and shows «Χωρίς σταθερό ρυθμό»
  instead of a guess.

**Known limits** (synthetic testing):
- Eighth-note strumming, ballads with eighth hats, reggae and some lo-fi can
  read ×2 or ×½.
- 6/8 or 12/8 with a barely accented beat can read ×3.
- Solo voice often gets no BPM.
- A steady drone or tone can get a false tempo.

### BPM octave fix (×½ / ×2)

Next to the BPM of a loaded deck, in «Ουρά tagging», and on the Library's side
card, «×½» and «×2» halve or double the track's BPM.
- The value is stored only in CrateMind as a manual BPM, never in file tags or
  djay. It wins everywhere BPM is shown, searched, sorted or exported.
- «Επαναφορά BPM» returns to the automatic value.
- The toast offers «Αναίρεση».
- A playing deck keeps playing. Sync and new loops follow the new BPM, while an
  imported djay beatgrid keeps djay's own BPM.

### Library filters

«Φίλτρα» next to «Στήλες» opens a panel with:
- every vocabulary and its values, with counts for the current search;
- BPM, «Διέγερση» and «Συναισθηματικό σθένος» ranges in therapy («Σκοτεινότητα»
  in DJ).

Clicking a value adds or removes its token in the search box, which stays the
single source of truth.
- Two values of one vocabulary must both match (AND).
- Single-value vocabularies behave like radio buttons.
- «Καθαρισμός φίλτρων» removes only the panel's tokens.

## External tools

- `ffprobe` (recommended) — duration/codec/bitrate. Degrades gracefully if absent.
- `fpcalc` / Chromaprint (optional) — acoustic fingerprints for duplicate detection.
- `ffmpeg` (required for **Audio analysis**) — decodes audio read-only to
  estimate BPM and musical key. Run the job from **Settings → «Γρήγορες Ενέργειες ›
  BPM + Key · Μόνο νέα»** (both runtimes) or the «Ανάλυση BPM + Key» card (web
  only, with online BPM review). Results fill BPM/key only where embedded tags
  are missing; source files and tags are never modified.

On web, all three are auto-detected on `PATH` and can be overridden in `.env`;
the desktop app bundles them.

## Search syntax

The Library search box accepts field filters plus free text, e.g.:

```
energy:7-9 darkness:6-10 role:peak bpm:148-155 status:approved
substyle:hitech weirdness:7+ confidence:4+
mandragora status:approved -retired
```

Recency + transition tokens:

```
not_recent:30        not played in the last 30 days (or never)
played_recently:14   played within the last 14 days
never_played         play_count == 0
dramatic             dramatic_transition_candidate flag set
can_cut_into / can_cut_out_of   cut-point flags
tolerance:huge       bpm_jump_tolerance contains "huge"
```

The flagship query — approved, dark, high-energy 150–160 bridge tracks with a
long breakdown, survive a big BPM jump, not played recently:

```
status:approved darkness:7+ energy:8+ bpm:150-160 role:bridge break:long tolerance:huge not_recent:30 dramatic
```

Recency tokens depend on logged plays (the **▶ played** button in the profile
panel, or `POST /tracks/{id}/play`).

Whole-number BPM ranges match the BPM as the Library shows it, rounded:
`bpm:140-145` keeps 139.6 and 145.02 (the «Φίλτρα» BPM slider writes such
ranges). Decimal bounds (`bpm:139.8-145.2`) stay exact.

`status:` takes a comma list: `status:approved,weapon` matches either status
(the therapy «Εγκεκριμένα» presets use it, because therapy shows a DJ weapon
as approved).

Free text and quoting:

- Free text is accent- and case-insensitive and matches word prefixes:
  `μανος χατζιδ` finds «Μάνος Χατζιδάκις», `relax` finds «Relaxation».
- An excluded word (`-relax`) is exact: it removes «Relax One» but keeps
  «Relaxation Two».
- Only double quotes quote: `artist:"Μάνος Χατζιδάκις"`, `-"two words"`.
  Apostrophes are literal, so `Σ' αγαπώ` works as typed. Punctuation-only
  terms are ignored.
- String fields (`artist:`, `genre:`, …) are accent- and case-insensitive too.

Vocabularies, valence and folders:

```
valence:6-8              emotional valence (1–10), same ranges as energy
purpose:χαλάρωση         a vocabulary value (accents and case ignored)
purpose:"συναισθηματική έκφραση"   a multi-word value needs quotes
purpose:*                tracks with any value in that vocabulary
-purpose:*               tracks with no value in that vocabulary
folder:"C:/Music/Relax/" path contains this text; \ and / are the same
```

A vocabulary token uses the vocabulary's key, which the app never shows. The
suggested therapy vocabulary uses these keys:

```
purpose       Θεραπευτικός στόχος
mood          Διάθεση
voice         Φωνή
lyrics        Γλώσσα στίχων
instruments   Όργανα
phase         Φάση συνεδρίας
ages          Ηλικιακή ομάδα
tradition     Μουσική παράδοση
```

For a vocabulary you created yourself, click one of its values in the tag
cloud: the Library opens with that value's token in the search box, and the
search chips show the vocabulary's Greek label. A value the vocabulary does
not have matches nothing. A key that is not a vocabulary
falls back to free text, so `-purpose:*` without a `purpose` vocabulary
matches every track. End a folder with `/` to stop `Relax` matching
`Relaxation`.

## Safety

- DB is backed up to `data/backups/` on every launch (last N kept).
- Exports only ever write into the output folder; they never overwrite source
  files unless you pass `overwrite=true`.
- All taste metadata lives in `data/cratemind.sqlite`; back it up via the
  JSON-backup export for a portable canonical copy.

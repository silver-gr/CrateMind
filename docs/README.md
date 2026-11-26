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

In web mode the backend answers only to `localhost`, `127.0.0.1`, `::1` and the hostnames in
`CRATEMIND_CORS_ORIGINS`, and refuses a write (POST/PUT/PATCH/DELETE) whose `Origin` is another website;
requests without an `Origin` (curl, scripts) pass. To reach the backend itself under another name or IP,
set `CRATEMIND_ALLOWED_HOSTS` in `.env` (comma-separated exact hostnames, no port, no wildcards).
To open the dev frontend under another name (Tailscale, ngrok), add it to `fronts` in
`frontend/vite.config.ts`: the `/api` proxy then vouches for writes from that page.

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
5. **Duplicates** → review and resolve duplicate groups (never auto-deletes). Besides identical files and
   same artist/title at a similar length, it finds the same recording by audio fingerprint when the titles
   match: a preview of a full track, «&»/«vs»/«feat» credit spellings, «Unknown Artist» copies. A remix, edit
   or dub, or a long mix that opens with a track, is not flagged; a group you resolved or ignored stays decided.
   It needs the fingerprints («Fingerprint» in Settings), which cover each track's first 2 minutes.
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

### Play history

CrateMind logs what you actually play, like djay's History tab. A track counts
once it has been audible on a deck for 30 seconds (single-deck or two-deck; in
two-deck mode a deck whose fader is down does not count). Time heard while the
tagging queue («Ουρά tagging», `/tag`) is open never counts. Each logged play
raises the track's play count and last-played date, so it feeds `not_recent:`,
`never_played`, `played_recently` and the recommender's «played recently».
The **History** page («Ιστορικό», `/history`) groups plays into sessions (a gap
of more than 30 minutes starts a new one) with start, end, duration and deck
per row; a session can be saved as a set or deleted. Deleting plays lowers the
play counts again. Manual plays and **Mark set played** rows show there too,
without a deck or duration. History lives only in CrateMind's own
`play_events` table; audio files and other DJ apps are never touched.

### Recording a set

In two-deck mode, **REC** in the mixer records the master output
(exactly what goes to the speakers) as a 24-bit stereo WAV,
`CrateMind-recording-YYYY-MM-DD_HH-MM.wav`, in the export folder. While it
records, a «REC 12:34» pill shows at the top of the window on every page;
stopping takes two presses (**Διακοπή**, then **Σίγουρα;**). The file is valid
after every second written, so a crash keeps everything up to that point. A
recording refuses to start with less than 2 GB free and stops itself under
200 MB or at the 4 GB WAV limit (about 4 hours). If the two decks together
clip, the final message says so: lower the faders or
trim. A recording and the experimental VST3 plugins refuse each other: REC does
not start while they run, and they do not start while a recording runs or is
being saved. **Settings → «Μορφή εγγραφής set»** picks WAV, AAC 256 kbps or AAC
128 kbps. AAC recordings are still written as WAV first and converted with ffmpeg
when you stop (`.m4a`, about a minute for a 90-minute set); the WAV is deleted only
after the AAC file's length checks out, and kept if the conversion fails. Make a
short test recording before a real set.

### Deck rescue

While a deck holds a track, CrateMind saves the decks every two seconds: the
loaded tracks, their positions, tempo, pitch range, key lock and loop, and the
mixer (faders, crossfader, EQ, filter, trim, master). After a crash, a
force-quit or a page reload, the next start (desktop app or web page, same
library, within 24 hours) asks «Επαναφορά των decks από την προηγούμενη
συνεδρία;» and names the tracks. **Επαναφορά** loads them paused at the saved
positions and never starts playback; **Όχι** forgets the snapshot. With the
controller connected, its own faders and knobs stay the truth: only tempo
(the pitch fader must reach the saved value first), range, key lock and loop
come back. Up to two seconds of changes can be lost. Ejecting both decks clears
the snapshot; a normal quit with tracks still loaded keeps it, so the next
start offers them again. The desktop app also asks before it closes while a
deck is playing. The snapshot is one small file in CrateMind's own cache
folder (`deck-rescue.json`); audio files, tags and other DJ apps are never
touched, and a restore adds nothing to the play history.

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
- «Επαναφορά BPM» returns to the automatic value: the tempo of CrateMind's own
  beatgrid when that grid is confident and steady, else the file tag, the
  agreement of the analyses, or the local analysis.
- The toast offers «Αναίρεση».
- A playing deck keeps playing. Sync and new loops follow the new BPM. A stored
  steady beatgrid follows it too (its beats double or halve); a beatgrid stored
  as a list of beats (a flexible djay grid, or CrateMind's grid for a track
  with sections) keeps its own beats.

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

### Library grouping

«Ομαδοποίηση» next to «Φίλτρα» splits the current list (the whole library, a
search or an opened crate) into collapsible sections: by status, energy, role,
substyle, 5-BPM bands, key (Camelot order), genre, year, folder (relative to the
folder all loaded tracks share) or crate. Tracks keep the table's sort inside
each section, and tracks with no value sit under «Χωρίς τιμή», last. In
«Crates» mode each track goes under the **first** crate that matches it, in the
crate list's order (pinned first); tracks no crate matches sit under
«Χωρίς crate», and the crate whose query is open is skipped. Click a section's
header (or press Enter on it) to fold it; J/K skip folded sections. The choice
is remembered; role and substyle exist only in the DJ profile. This replaces the
old «Έξυπνοι φάκελοι» page (`/smart-folders` now opens the Library).

### Shown titles and artists

The Library, Set Builder and the decks show a tidied title and artist; the tags
in the file and the stored track keep the original. Hidden: emoji and other
decorations (ૐ, ◉, ●, ∞, box drawing) that do not sit between two letters, and
a lone @, ~ or * at either end; emoji and maths letters stored without their top
bits are first read back («홊홐홏 홉홊홒» shows as «OUT NOW»); empty brackets and
leftover separators (`//`, `->`, `| !`); misspelt download notes, chart
positions («Top #20 Beatport») and «on Bandcamp/Beatport/YouTube» at the end;
«(Original Mix)»; genre words wrapped round an artist («[HiTech Darkpsy
Psytrance] X», «PSY-TRANCE ◉ X»); a trailing «(… Records)» after an artist; the
artist at the start of a title written «Artist- Title»; doubled spaces. A dash
version reads as brackets («Title - X Remix» shows as «Title (X Remix)») and an
acute accent typed for an apostrophe reads as one («It ́s» shows as «It's»).
Numbers in titles stay, and a rule never empties a title. Metadata you accepted
or edited in «Κανονικά μεταδεδομένα» is shown exactly as you left it. The
originals show under «Στοιχεία αρχείου» as «Αρχικός τίτλος» and «Αρχικός
καλλιτέχνης»; exports (M3U8, CSV, Markdown) use the stored values.

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

`substyle:` matches a track's substyle as the Library shows it: its own, or,
when it has none, the genre of its artist once you confirmed that genre in
«Καλλιτέχνες» (shown fainter in the «Υποείδος» column and as the field's
placeholder in the profile). Unconfirmed artist estimates and placeholder
credits such as «Unknown Artist» never count, and nothing is written to the
tracks, so they stay «Αταξινόμητα» until you rate them.

`lufs:` filters by measured whole-track loudness (integrated LUFS, the
Library's «LUFS» column): `lufs:-10--8` (a range, either order), `lufs:-8+`
(−8 or louder), `lufs:-12-` (−12 or quieter), `lufs:-8` (the whole dB, −8.5
to −7.5). Unmeasured tracks never match, and a negated filter (`-lufs:-8+`)
keeps them. The analysis job («BPM + Key · μόνο νέα») measures every track not
measured yet; Auto Gain measures a track on first play if the job has not. What Auto Gain, the limiter
and the Maximizer each do to the sound, and when to use which: [LOUDNESS_GUIDE.md](LOUDNESS_GUIDE.md).

`status:` takes a comma list: `status:approved,weapon` matches either status
(the therapy «Εγκεκριμένα» presets use it, because therapy shows a DJ weapon
as approved).

`key:` matches the key as the Library shows it (file tag, then a confident
CrateMind key, then djay's) and takes any notation (`8A`, `Am`, `1m`) or a comma
list: `key:8A,9A,7A,8B bpm:140-146` finds the tracks that mix with an 8A track
at that tempo. A value that is not a key is ignored; a negated key filter
(`-key:8A,9A`) keeps tracks with no key.

`plays:` filters by play count, with the usual ranges: `plays:0` (never
played), `plays:1-3`, `plays:5+` (5 or more), `plays:5-` (at most 5).

OR: a bare, upper-case `OR` joins the term before it to the term after it;
every other pair of terms is AND. So `a b OR c d` means a AND (b OR c) AND d,
and `a OR b OR c` is one group.

```
energy:8-9 OR role:peak                  either one
status:approved energy:9 OR role:peak    approved, and energy 9 or peak role
key:8A OR key:9A bpm:140-145             (8A or 9A) at 140–145 BPM
mandragora OR "astrix"                   free text works in a group too
-status:retired OR energy:9              so does negation
```

A lower-case `or`, a quoted `"OR"`, and an `OR` at the start or the end
(or doubled) never join anything: the first two are free text, the others are
ignored.

Sorting and size: `sort:<field>` orders the result, `sort:-<field>` in reverse,
and `limit:N` keeps only the first N tracks in that order. Fields: `bpm`,
`key` (round the Camelot wheel, 1A, 1B, 2A … 12B, and low to high BPM within a
key), `energy` (and the other 1–10 axes: `darkness`, `melody`, `valence`, …),
`added`, `played` (last played), `plays`, `lufs`, `title`, `artist`. Tracks
without a value go last either way. Several `sort:` tokens sort by the first,
then the next (`sort:-energy sort:bpm`). Both tokens apply to the whole search
wherever they stand and never join an `OR`; an unknown field or a `limit:`
that is not a positive whole number is ignored.

```
role:peak sort:-plays limit:20     the 20 most played peak tracks
added:30 sort:-added               newest first
key:8A,9A,7A,8B sort:bpm           compatible keys, slowest first
```

A Memory Crate saves its query text, so it keeps its `sort:` and `limit:`:
its count, its track list and the crate bins in the Library hold at most N
tracks. The API pages inside the limit (`GET /api/tracks?q=…&offset=…` and the
tagging queue's `after` cursor), so the reported total is never more than N.

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

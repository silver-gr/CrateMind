# Changelog

All notable changes to CrateMind are documented here.
Format follows [Keep a Changelog](https://keepachangelog.com/). Versioning is [Semantic](https://semver.org/).
CrateMind stays at 0.x while the desktop app is a preview.

---

## [0.2.0] - 2026-11-02 — Deck waveforms get a density texture and spectral colour, the sidebar logo goes metallic, and releases get a version number

The deck waveforms are redrawn from measurements of djay's own, with a grainy texture and colour that follows the frequency bands. The sidebar gets a metallic logo and wordmark, and each tagged release now publishes a Windows installer under a version number.

### Added
- **Versioning and releases** — CrateMind now carries a version number and this changelog; tagged versions publish a Windows installer on GitHub Releases.
- **Metallic logo and wordmark** — the sidebar header shows the new brain-and-vinyl symbol as a live metallic effect over the colour logo, with «CrateMind» written close beneath it in white liquid-metal Geist lettering. The collapsed sidebar keeps a small version of the same symbol. Under reduced motion the effect draws a still frame, and without WebGL2 the plain logo image appears.
- **Fold the waveform panel** — the two-deck waveform panel, at the top or the bottom, folds to a thin strip with the same chevron as the deck dock; the waveforms stop drawing while it is folded and playback carries on.
- **Researched artist genres** — «Έρευνα ειδών» looks each artist up on the web (GPT-6 Luna, with citations) and proposes one genre from the psytrance list, or says it falls outside the list. The Artists page shows one result per artist with optional related genres; the rationale and sources open on request, and you confirm or correct the genre. Confirmed artists are never re-researched.
- **Four new backgrounds** — Gradient ASCII, Prism, Particles · Warp and Balatro join the list in Ρυθμίσεις > Εμφάνιση > Φόντο. Each has a light-theme version, runs capped for smooth performance and falls back to a static background if it fails to start.
- **Specular glass buttons** — the main actions («Ακρόαση A/B», «Έλεγχος αλλαγών», «Πλήρες backup», «Εισαγωγή beatgrid», «Αποθήκευση ως crate», «Σήμανση set ως παιγμένο», «Αποθήκευση προφίλ») get a glass button with a cyan shine and violet rim. The shine stands still when the button is disabled or when reduced motion is set.
- **Greek README** — a new overview in Greek covering what CrateMind is, its data-safety principle, features, limitations and roadmap, with a quick start and notes for the macOS and Windows builds.

### Changed
- **Deck waveforms redrawn after djay** — the deck waveforms now show a grainy density texture built from the real audio instead of a smooth outline, and each moment is coloured by the frequencies in it (bass red, mids green, highs blue), while quiet passages stay dark grey. Both the shape and the colours are tuned from measurements of djay Pro, but have not yet been checked side by side against djay. Texture tiles load in the background as you zoom or switch track, and tracks are re-analysed on first load after the update.
- **Theme waveform palette** — the theme palette now spans warm lows, amber and green mids and cyan, blue and violet highs, with neutral moments left neutral; «Συχνότητες (djay)» shows the colours as measured.
- **Spectral deck overviews** — the overview strip in each deck header is a continuous mirrored waveform coloured by frequency, instead of decorative bars on a gradient.
- **Stronger deck-panel edge** — the two-deck waveform panel has a 2px higher-contrast border and a soft shadow on the side facing the page, in both themes.
- **Scroll fades** — long lists (set tracks, collections, Settings, Crates, Playlists, Duplicates, the tagging queue, Artists, the Set Builder sidebar) fade at the top and bottom only while there is more to scroll, and short lists stay unfaded. In the Library and the Set Builder candidates the top fade starts below the column headings, which are now solid so rows no longer show through them; Key & Harmony fades at the bottom only.
- **Softer list focus** — Set Builder marks the focused list with a soft cyan glow along its left and right edges instead of a thin ring; the Library and the tagging queue, which have a single list, show no indicator.
- **Library table tools** — the track count, the J/K hint, «Επαναφορά μεγεθών» (now with a reset icon) and «Στήλες» sit together at the right edge. The SoundCloud columns use compact «SC» headers with play and thumbs-up icons, and the full names stay in the tooltips.
- **Library column widths** — «Επαναφορά μεγεθών» restores a tuned set of default widths. Each column stops at its default when narrowed, except the title column, which can shrink 120px further, and the four bar columns, which can shrink 40px further.
- **Artists page layout** — the result cards fill masonry columns that read left to right and all start at the top; opening a card's sources only pushes its own column down.
- **«Beatgrid από djay» report** — the seven counts sit in two columns, so labels such as «Χωρίς αντιστοίχιση» stay on one line.

### Fixed
- **Artist enrichment in the desktop app** — the desktop app now reads the LLM1 address, key, model and effort from its own settings file, so artist enrichment no longer fails with «Configure LLM1 before enriching artists». The web version keeps reading its `.env`.
- **Logo no longer clipped** — the sidebar logo and its glow were cut off at the top and bottom of their box. The box is taller and the art fits inside it, with a stronger metallic sheen over the colour logo.
- **Seeking from the deck overview** — clicking, dragging or using the arrow keys on a deck header's overview seeks again; the overview and the playhead share one time axis.
- **«Αποθήκευση ως crate» alignment** — the Library's save-as-crate button sits centred on the search field instead of at its top edge.

---

## [0.1.0] - 2026-11-01 — The first installable desktop preview: two decks, a controller, djay beatgrids and a Windows installer

CrateMind becomes a desktop app with its own two-deck player, a Numark Mixtrack Platinum FX controller, read-only djay beatgrid import and an unsigned Windows installer. The web version keeps working alongside it.

### Added
- **Desktop app** — a Tauri desktop app bundles the whole workspace, so it runs without a separate server. It shows a card-only splash while the library prepares, has a glyph-only icon, supports themed backgrounds, and shares the same interface as the web version. Native set creation works reliably. Audio analysis and provider lookups remain web-only in this preview.
- **Windows installer** — an unsigned Windows x64 installer is built on GitHub, bundling FFmpeg, ffprobe and Chromaprint. A fresh install starts with an empty library under the user's app data folder and ships no personal data.
- **Two-deck player and mixer** — two decks with pitch, bend, key lock, Sync, per-deck EQ and filter, trim and master level, and a djay-style mixer. Cue pads, playback gain with limiting, and smooth playhead, entrance and press-feedback motion round it out.
- **Numark Mixtrack Platinum FX support** — the controller drives the decks directly: jog scrubbing, Load, Cue, pad cues, pitch range with pickup, Sync, and browsing and loading from any list. Pressing play routes to a free deck. Tag banks, transition notes and loops are available from the pads, and the VU meters follow the audio. The buttons, pads, VU meters and jog screens light up, including a beat ring, and everything goes dark when the app quits. The deck layout fits the hardware. MIDI exists only in the desktop app.
- **Deck waveform panels** — each deck gets a scrolling waveform with a header, backed by a 3-band detail waveform. The panel sits at the top of the window by default, like djay, and a switch in Settings, «Θέση κυματομορφών decks», moves it back above the dock. The deck rows mirror around the mixer, the dock collapses, and the waveform colours follow the theme.
- **Beatgrid από djay** — an opt-in, read-only import brings djay Pro beatgrids into CrateMind. The djay library is read from a private copy and per-track analysis files are read in place, so djay files are never written to, moved or locked. A Settings card reports how many tracks matched and how many did not, and a button removes the imported grids again. Grids that djay draws straight are recognised by the typical beat rather than the worst few, so far more tracks are accepted as straight.
- **Downbeat tool** — a DOWNBEAT overlay on each deck's waveform (Set, ◀, ▶, ↺) lets you mark where bar 1 starts. The value lives only in CrateMind: it never moves djay beat positions, and removing or re-importing djay grids leaves it alone. Beat lines, estimate lines and bar numbers are drawn brighter, and grid lines stay readable on light waveform colours.
- **Shortcuts sheet** — an app-wide keyboard shortcuts sheet, and an updated psytrance substyle list with an info note for each option.

### Changed
- **Daily launch backups** — the database is snapshotted at most once every 24 hours after a light integrity check, and always before a pending schema upgrade. The last 3 backups are kept.
- **Consistent library metadata** — artist, title and tempo are shown from one consistent source across the Library, sets and recommendations, without ever rewriting source files. Manual identity decisions are preserved, and unchanged files are skipped on rescan.
- **Compact workspace** — the DJ workspace stays compact and ready for controller input, with the BPM and key badge under the pads in two-deck mode.
- **Greek djay UI** — the djay report and the downbeat button are in Greek, and the interface-language rule is tightened.
- **Retired the old Deno app** — the earlier Deno desktop app is gone, while the importer for its existing user databases stays.

### Fixed
- **Windows backups** — the backup snapshot is opened for writing before it is flushed to disk, and the self-test no longer leaves a catalog connection open on Windows.
- **djay track matching** — durations and bookmarked file paths are now read correctly, so more djay tracks match their CrateMind entries.

---

## Before versioning

Milestones from before CrateMind had version numbers; dates are when each milestone landed.

### 2026-10-24 — Fewer duplicates, steadier decisions, and a library shared with the desktop app

The library got quieter to maintain: new tracks are checked automatically, decisions stick, and the desktop app can share the same library.

- **No duplicate imports** — re-importing a file no longer creates a second entry, and new tracks are analysed automatically.
- **Decisions stay put** — library decisions are kept consistent, with less repeated review work.
- **Harmonic browsing** — browsing by key reflects the stored musical keys.
- **Library editor** — the editor stays in step with table playback.
- **Shared library** — the desktop app can share the library, and its owner, with the web version.

---

### 2026-10-08 — Installable web app and listening cues

CrateMind can be installed like an app, and the player and tagging queue give clearer feedback.

- **Installable app** — CrateMind is a PWA with its own install prompt.
- **Listening cues** — the player adds cues for auditioning tracks.
- **Rating in the tagging queue** — the queue shows the active rating.
- **Bigger track list** — the Library list cap rises from 5,000 to 10,000 tracks (raised on 2026-10-13).

---

### 2026-09-20 — Real waveforms, artwork and a light theme

CrateMind moved to its own project root and the player and tagging workstation got a major upgrade.

- **Real waveforms and artwork** — waveforms and cover art come from the source audio.
- **Solar light theme** — a light theme, a resizable shell and a design system.
- **Upgraded player and tagging workstation** — a better player, track table and tagging screen.
- **Better tempo estimates** — tempo is sampled across several sections and cross-checked with Essentia.
- **Delta scan** — rescans only look at what changed, with a guard against wrongly flagging files as missing.
- **Duplicate collections** — duplicate collections are folded behind a representative track.
- **Date search** — `added:` and `created:` search filters, and a refreshed Dashboard discovery area.

---

### 2026-09-14 — SoundCloud and ReccoBeats lookups

Outside services can now help fill in tempo and catalogue details, always with the local file as the source of truth.

- **ReccoBeats lookup** — catalogue lookup with metadata-first BPM analysis.
- **SoundCloud integration** — a SoundCloud integration with its own interface and a BPM analysis card.

---

### 2026-07-29 — Trustworthy BPM and a shuffled tagging queue

BPM values from several sources are compared before they are trusted.

- **Multi-source BPM validation** — sources are compared for consensus, and disagreements are flagged for review.
- **Random order** — the tagging queue gets a random-order toggle.
- **Desktop window** — the desktop window opens wider and the app screens move into the menu.

---

### 2026-07-21 — Artist intelligence and the first desktop app

Artists became first-class: CrateMind builds an artist catalogue from the library and can profile artists with a local language model. The same day brought the first desktop app, built on Deno (retired on 2026-10-29).

- **Artists page** — an Artists dashboard with cards, query chips and field labels.
- **Artist profiles** — artist profiles are enriched in batches by an LLM, with a confidence level shown.
- **Artist search** — search tokens such as `artist_*` over the artist catalogue.
- **Artist prefills** — advisory prefills appear in the tagging queue and the profile editor.
- **Embedded tags first** — embedded artist and title tags are treated as authoritative.
- **Backup and export** — JSON backups now include artist profiles, and a backup can be imported again, with a whole-library export.
- **First desktop app** — a packaged desktop app with a native window, a macOS menu and an app icon.

---

### 2026-06-27 — A full visual redesign and automatic BPM and key

The first big polish pass gave CrateMind its neon look and added audio analysis.

- **Redesigned interface** — a Psy Void Neon redesign of all screens, plus six new feature pages, a ⌘K command palette, animated backgrounds and a hero wordmark.
- **Library table** — sortable, resizable columns, file dates, and a sort that survives a refresh.
- **Tagging queue** — the track cap is removed.
- **Floating sidebar** — the sidebar collapses to a floating island at the bottom.
- **BPM and key analysis** — tracks are analysed in the background for BPM and key, and the results feed the recommender and the Set Builder.

---

### 2026-06-26 — v1.1: Memory Crates, dashboard and bridge recommender

CrateMind began on this day as a local-first DJ intelligence layer (effectively "v1.0"), and a second release the same day, internally called v1.1, followed.

- **v1.0 foundation** — library scan, taste metadata, search, duplicate detection, sets and exports (M3U8, CSV, JSON backup and Markdown). It never changes the source music.
- **Memory Crates** — saved searches that behave like smart crates (v1.1).
- **Dashboard** — a dashboard for discovery (v1.1).
- **Bridge recommender** — a recommender mode that suggests a track to play between two chosen tracks, one that mixes out of the first and leads into the second (v1.1).
- **Local audition player** — audio streaming and a mini player for auditioning tracks.

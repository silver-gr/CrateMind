# Changelog

All notable changes to CrateMind are documented here.
Format follows [Keep a Changelog](https://keepachangelog.com/). Versioning is [Semantic](https://semver.org/).
CrateMind stays at 0.x while the desktop app is a preview.

---

## [Unreleased]

### Added
- **«Iridescence · Violet» background** — a second Iridescence look in «Επιλογή φόντου»: violet and magenta streaks that follow the pointer and swirl where you click. The original is now listed as «Iridescence · Pearl».

### Changed
- **The «Συλλογές» screens look like the rest of the app** — «Συλλογές», «Προέλευση συλλογών», «Πληρότητα & ανάκτηση», «Μεταδεδομένα & καλλιτέχνες» and «Ενοποιημένη βιβλιοθήκη» now share one header, glass panels, status pills and a compact pager. Every count is grouped with Greek separators (19.954), each source tile in «Ενοποιημένη βιβλιοθήκη» shows its linked / high-confidence / probable split as a bar, dates read as Greek dates, and the long explanation in «Πληρότητα & ανάκτηση» folds away under «Πώς διαβάζονται οι αριθμοί». The colours follow the theme, so these screens now also read in the light theme.
- **Glass headers** — the dashboard's title bar, the Library table's column header and the two waveform-panel toggles were solid black; they are now see-through glass like the rest of the UI.

### Fixed
- **Internal keys on the «Συλλογές» screens** — provider names («spotify»), collection relationships («owned · private»), match classes, DJ statuses and a SoundCloud account number showed as raw keys; they now read in Greek or by name. An artist stored as the text "null" shows as «Άγνωστος καλλιτέχνης».

---

## [0.4.0] - 2026-11-03 — BPM windows for every kind of music, a ×½ / ×2 BPM fix, Library filters and a start-screen dashboard

BPM analysis no longer forces every track into a psytrance range. You can pick a window per music folder, crate or selection, and the therapy profile gets its own estimator, built so slow music reads at its real tempo. Any track's BPM can be halved or doubled in one click. The Library gets a filter panel, therapy gets an emotion map and its own dashboard, the dashboard becomes a start screen, the deck waveforms get a calmer beatgrid with two display toggles, and the decks get a hardware look. A new cleanup command slims the identity data, and the library counts now include only identifiable recordings.

### Added
- **BPM windows** — DJ analysis reads tempos inside a window: «Psy / hi-tech (133–286)» by default, «Μικτό 4/4 (118–250)» or «Αργά / downtempo (70–125)». You can:
  - pick the default in Ρυθμίσεις;
  - give each music folder its own window;
  - re-analyse a Library selection, all search results or a crate with «Ανάλυση BPM», which shows the track count first and runs only the local analysis.
- **Therapy tempo estimator** — the «Μουσικοθεραπεία» profile analyses 40–240 BPM, with no pull toward 120 and no doubling, so slow music reads at its real tempo. 6/8 reads at the rocking dotted-quarter pulse and 3/4 at the beat. Music with no steady pulse gets no BPM («Χωρίς σταθερό ρυθμό») instead of a guess.
- **BPM octave fix** — «×½» and «×2» sit next to the BPM in both profiles: on a loaded deck, in «Ουρά tagging» and on the Library card. «Επαναφορά BPM» returns to the automatic value, and the toast offers «Αναίρεση». The value is stored only in CrateMind, never in file tags or djay, and a playing deck keeps playing.
- **Library filters** — «Φίλτρα» opens a panel with every vocabulary and its counts, plus BPM, arousal and valence ranges (darkness in the DJ profile). Clicking a value edits the search box.
- **«Χάρτης συναισθήματος»** — in therapy, Energy Maps becomes an arousal × valence map.
- **Therapy dashboard** — «Γρήγορες λίστες» (your pinned crates) and the «Ταξινομημένα x / y» progress line, without the DJ tiles.
- **Dashboard start screen** — three new sections:
  - a quick search box, with your pinned crates as one-click chips;
  - «Συνέχεια», laid out as masonry cards: the tracks you last loaded into a deck on this device, your recently logged plays and your latest set. Each row has a coloured «BPM» and key, plus → Deck A/B;
  - «Θέλουν προσοχή», which counts tracks without BPM, tracks over 200 BPM (possible doubles), new untagged tracks, missing files and duplicates.
- **Main crate** — star a crate as «Κύριο» on Crates or on the dashboard, and the dashboard hero shows it. Its name, count, Play and «Library →» all use that crate's query. On the dashboard cards the star appears on hover, like pin and delete, and stays visible on the main crate.
- **Waveform toggles** — two small buttons at the bottom right of each deck waveform: «Έντονο beatgrid» for strong grid lines, and «Διαφανές πάνελ κυματομορφών» to let the background show through the panel.
- **Icon rail sidebar** — a new «Σύμπτυξη πλαϊνής μπάρας» choice in Ρυθμίσεις. Collapsing the sidebar can still show the floating dock, or it can shrink the sidebar, animated, into a narrow scrollable icon rail on the left edge.
- **Windows title bar** — the Windows app gets the same slim title bar as macOS, with its own «Ελαχιστοποίηση», «Μεγιστοποίηση» and «Κλείσιμο» buttons, and a readable startup error screen.
- **Working-library cleanup** — `reconciliation/clean_working_library.py` slims the identity and catalog data without touching your tags, decisions or audio.
  - It previews by default. `--apply` takes a verified backup first, a rerun changes nothing, and `--rollback` restores the saved copy.
  - It links local files to their SoundCloud uploads when the match is certain: either the app's own automatic-link rule, or files downloaded from your SoundCloud likes that match by title and duration. Each such link can be undone with «Αναίρεση σύνδεσης» on the Canonical page.
  - Weak SoundCloud suggestions for tracks that are already linked are dropped.

### Changed
- **Cue markers in pad colours** — cue markers on the deck waveforms now take their cue pad's colour, and on the big waveform they also show the pad number. The deck waveform also has a top border, and the waveform view toggles appear once, at the bottom right of the panel.
- **Chartreuse beatgrid** — bar lines and bar numbers on the deck waveforms are now chartreuse instead of yellow.
- **Deck controls with a hardware look** — with two decks, each deck rounds off its top corner beside the mixer, and its letter sits above eject, lit while the deck plays, like Play. Faders have recessed slots and caps with a lit centre line, and pitch and the crossfader have no fill. Knobs have a body and the level meter is segmented. Empty cue pads show only their number (a + on hover), set pads show their time in near-white, and the pad settings icon appears on hover.
- **«Bangers» instead of «Όπλα»** — the status for a proven dancefloor track is now called «banger» everywhere: the W key in «Ουρά tagging», the presets, the dashboard and the query chips. Saved searches using `weapons` keep working.
- **Calmer beatgrid** — the deck's beat lines, bar lines and bar numbers are drawn more discreetly by default.
- **DJ default window starts at 133** — prog psy at 133–135 no longer reads doubled. Stored values change only when you re-analyse.
- **BPM search matches the shown BPM** — a whole-number range such as `bpm:140-145` now includes a track at 139.6, which the Library shows as 140.
- **Greek BPM analysis card** — the web BPM analysis card is now in Greek. In the desktop app, the missing-ffmpeg tooltip now says to reinstall instead of pointing to PATH.

### Fixed
- **Dashboard main preset** — the «Peak Bridge Weapons» card showed the count of all weapons, while its Play and «Library →» opened a query that matched nothing. The main crate replaces it, and the decorative fake graphs are gone.
- **Analysis log growth** — a stalled analysis process wrote a stack dump every minute. It now writes one per stall and stops writing details once the log passes 2 MiB.
- **Known-music counts** — the Unified library, Recovery, Canonical review, collection counters and the dashboard now count only live, identifiable recordings, so old duplicate redirects no longer show up as known and unresolved. References with only an ID and no title are counted separately as «Ανεπίλυτες αναφορές» and left out of default lists and recommendations.
- **Spotify re-imports** — importing another Spotify export no longer blanks ISRCs or artist links that an earlier export provided.
  - Values merge field by field: an empty value never replaces a filled one, and conflicting values are kept as alternatives.
  - Genre, label and artist-genre columns are read from both English and Greek exports.
- **Identity data growth** — library scans no longer regrow the data a cleanup removed. They keep a shortlist of the strongest candidate matches per track, store compact provider data and log only real changes.

---

## [0.3.0] - 2026-11-02 — A music-therapy profile with your own vocabularies, bulk tagging and accent-free search, and BPM/key analysis in the desktop app

CrateMind can now be set up for music therapy as well as for DJing. The «Μουσικοθεραπεία» profile relabels the scales, hides the DJ-only pages and works with vocabularies you define, such as «Θεραπευτικός στόχος». You can tag many tracks in one step and find them without typing accents, and the desktop app now analyses BPM and key itself.

### Added
- **«Μουσικοθεραπεία» profile** — on first launch CrateMind asks «Πώς θα χρησιμοποιήσεις το CrateMind;» and offers DJ or «Μουσικοθεραπεία». You can change it later in Ρυθμίσεις; existing installs stay on DJ and are not asked. In therapy, energy becomes «Διέγερση» and the statuses read «Αταξινόμητο», «Υπό δοκιμή», «Εγκεκριμένο», «Αποσυρμένο» and «Αποφυγή». Flow Finder, Key & Harmony, Phrase Finder, «Έξυπνοι φάκελοι», the «Beatgrid από djay» card and «Έρευνα ειδών» are hidden. The editors show «Διέγερση», «Συναισθηματικό σθένος» and your vocabularies instead of the DJ fields. The digit keys set «Διέγερση» and Shift+digit sets «Συναισθηματικό σθένος», also while a deck is loaded.
- **«Συναισθηματικό σθένος»** — a new 1–10 scale for how positive or negative a track feels. Together with «Διέγερση» it forms the two axes of the circumplex model used in music-emotion research. Search it with `valence:6-8`; the CSV export includes it.
- **Vocabularies** — build your own tag vocabularies in Ρυθμίσεις > «Λεξιλόγια», such as «Θεραπευτικός στόχος» or «Διάθεση», each allowing one value or several per track. «Φόρτωση προτεινόμενου λεξιλογίου (μουσικοθεραπεία)» adds a draft of 8 vocabularies with 47 values that you can edit freely. You pick values as chips in «Ουρά tagging» and the Library editor, Tag Cloud groups them under their vocabulary, and the JSON backup saves them. Search with tokens such as `purpose:χαλάρωση`, or `-purpose:*` for tracks with no value yet.
- **Bulk tagging** — tick tracks in the Library (Shift-click selects a range) or take all search results, then use «Προσθήκη τιμών» or «Αφαίρεση τιμών» on «Επιλεγμένα (N)» or «Όλα τα αποτελέσματα (N)». Before anything is written, the confirmation shows how many tracks will change and how many single-value tags will be replaced. The whole change is applied in one step, and each track's change is logged.
- **Sorting help in «Ουρά tagging»** — a «Χωρίς …» queue for each vocabulary, «Από φάκελο…» with a folder list and track counts, and a «Ταξινομημένα x / y» progress line. Queues load 500 tracks at a time, so large libraries open quickly.
- **Folder search** — `folder:` followed by part of a path, written with `\` or `/`, finds the tracks under matching folders.
- **BPM and key analysis in the desktop app** — the Windows and macOS apps now analyse BPM and key themselves, with the same librosa analysis as the web version, so both give the same values on a shared library. New tracks are analysed automatically after a scan, and «BPM + Key · Μόνο νέα» and «Επανανάλυση» appear in Ρυθμίσεις. Analysis runs in a separate, lower-priority process so playback stays smooth, and it stops cleanly when you quit. Essentia and the ReccoBeats, GetSongBPM and Cyanite comparisons, including the BPM review card, stay in the web version. The Windows installer grows by about 50 MB.

### Changed
- **Search ignores accents and matches partial words** — «χαλαρωση» finds «Χαλάρωση», «μανος» finds «Μάνος» and a final ς matches σ, also in field searches such as `artist:μάνος`. A word you are still typing matches every word it starts. Apostrophes no longer break a search («Σ' αγαπώ»); only double quotes group words. The first launch after the update rebuilds the search index once, right after the launch backup, which adds a few seconds on a large library.
- **CSV export** — adds a «Συναισθηματικό σθένος» column and one column per vocabulary, and starts with a UTF-8 BOM so Excel shows Greek text correctly.
- **Greek analysis messages** — a missing ffmpeg, a busy analysis and an interrupted analysis now report in Greek («Δεν βρέθηκε το ffmpeg…», «Εκτελείται ήδη άλλη εργασία…», «Η ανάλυση BPM/key σταμάτησε πριν ολοκληρωθεί…»).

### Fixed
- **«Όλα» in «Ουρά tagging»** — the «Όλα» queue showed no tracks; it now lists the whole library, 500 tracks at a time.
- **Searches in very large libraries** — a search word, or an excluded word, that matched more than 32,766 tracks made the search fail. Search, listing and bulk tagging now work at any library size.

---

## [0.2.1] - 2026-11-02 — The Windows app starts, and Energy Maps cards stop freezing invisible

The 0.2.0 Windows installer stopped at startup on every PC; this release fixes it. Energy Maps cards no longer stay invisible after loading, and the web version draws its glass buttons and metallic logo again.

### Fixed
- **Windows app starts** — after installing 0.2.0 on Windows, the startup window stopped at «Η εκκίνηση δεν ολοκληρώθηκε» with «Εκκίνηση υπηρεσίας: … (os error 24)», because the library service was launched with a wrong Windows setting. The app now starts, and every Windows build tests that launch before it builds the installer. On a fresh install, add your music in «Φάκελοι μουσικής σε αυτή τη συσκευή» in Ρυθμίσεις.
- **Energy Maps cards visible again** — the cards and panels on Energy Maps could stay almost transparent after loading, while their tooltips still worked; it happened nearly every time in the desktop app. They now fade in once and stay visible.
- **Glass buttons and metallic logo in the web version** — the web version showed white boxes with a broken-image icon over the glass buttons and the sidebar wordmark, and a plain logo image. They draw normally again; the desktop app was not affected.

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

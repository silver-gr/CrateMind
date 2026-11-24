# Changelog

All notable changes to CrateMind are documented here.
Format follows [Keep a Changelog](https://keepachangelog.com/). Versioning is [Semantic](https://semver.org/).
CrateMind stays at 0.x while the desktop app is a preview.

---

## [0.7.0] - 2026-11-24 — Free software under GPL-3.0, set recording, an effects rack on each deck, a play history and better keys

CrateMind is now free software under the GPL-3.0. The two-deck mixer can record your set to a WAV or AAC file, and each deck gets a built-in effects rack. CrateMind keeps a history of what you actually play, and after a crash it offers to bring the decks back. Keys are detected from the whole track with a trained method, djay's key is used too, and an uncertain key is marked «?». The Library gets a «LUFS» column, a «Δομή» column, «Ομαδοποίηση» and a tabbed side panel with artists and history. Suggestions come 12 per page with a musical match score, the duplicate check also compares the sound itself, and «Ρυθμίσεις» is now a sidebar of topics.

> **Licence:** from this release CrateMind is free software under the GNU General Public License v3.0 only (GPL-3.0-only). The licence text is in `LICENSE` in the repository, and the source code is on GitHub. Every download carries the licence texts of all the packages it ships and a `NOTICES.txt` that says where to get the source of each bundled media tool. Earlier versions are no longer offered for download. GSAP, whose licence stood in the way of an open licence, is gone: the page reveals and the dashboard spotlight now use the browser's own animations and look the same.

> **After updating:** the first launch adds columns for keys, loudness and play history to the library (with a backup first when the library lives in a dataset folder) and fills in djay's keys for tracks you imported from djay. Then run «BPM + Key · μόνο νέα» in «Ρυθμίσεις» once: it detects every track's key again with the new method and measures every track's loudness. BPM and beat grids are not analysed again. Some keys will change, because the order of key sources changed (see Changed). A library-exchange file from this version is refused by older installs.

### Added
- **Record a set** — a «REC» button in the two-deck mixer records what goes to the speakers, as a 24-bit WAV in your export folder. A «REC 12:34» pill stays at the top of the window on every page, and stopping takes two presses («Σίγουρα;»), so a stray click never ends a set. The file stays valid if the app crashes mid-set. «Μορφή εγγραφής set» in «Ρυθμίσεις» chooses WAV (default), AAC 256 kbps or AAC 128 kbps: in AAC mode the WAV is converted when you stop and deleted only after the AAC file checks out; if the conversion fails, the WAV stays. A recording will not start with less than 2 GB free and stops below 200 MB. Recording only creates new files; it never touches your music, tags or djay files.
- **An effects rack on each deck** — in two-deck mode each deck has one effect slot after its fader, so echo and reverb tails keep ringing when you close the fader or the crossfader. There are 66 presets in the range of djay Pro's audio FX (echo, reverb, filter, phaser, gate, crusher, slicer and more, including Polyrhythmic Delay and Chromatic Juggle). They follow CrateMind's beat grid and the deck's tempo; build-ups can fade out on the next phrase line, and key-aware presets tune to the track's key. Each deck header gets an effect row: a searchable picker with favourites, a button that latches on a tap and holds while pressed, a beats setting and an amount knob. On the controller, the FX paddles, Wet/Dry and the Beats knob drive it.
- **Play history** — CrateMind now logs what you actually play. A track counts once it has been audible on a deck for 30 seconds; nothing counts while «Ουρά tagging» is open, or while a deck's fader is down in two-deck mode. The new «Ιστορικό» page groups plays into sessions (a new one after 30 minutes of silence), and you can play a track again, save a session with «Αποθήκευση ως set» or delete plays. Play counts and «last played» now reflect real use, so `not_recent:` and the suggestions' «played recently» do too.
- **Bring the decks back after a crash** — while a deck holds a track, CrateMind saves the decks and the mixer every 2 seconds. If the app closes unexpectedly, the next start (within 24 hours) asks «Επαναφορά των decks από την προηγούμενη συνεδρία;» and names the tracks. «Επαναφορά» loads them paused at the same position, with tempo, key lock, loop and mixer settings; nothing starts playing by itself. With a controller connected, its faders and knobs win. Ejecting both decks clears the saved state.
- **Ask before quitting while a deck plays** — in the desktop app, closing the window (or Cmd+Q and «Έξοδος» on a Mac) while deck A or B is playing first asks «Ένα deck παίζει. Κλείσιμο του CrateMind;». When nothing plays, the app closes as before.
- **Drag a track onto a deck** — drag a row from the Library (also Set Builder's candidates and the dashboard's recent list) or a card from a set onto Deck A or B to load it. A playing deck is never replaced: while you drag over it, it says «Το Deck X παίζει — δεν θα φορτωθεί». This works in the desktop app too.
- **«LUFS» column and `lufs:` search** — each track's loudness (integrated LUFS and true peak) is stored, shown in a sortable «LUFS» column after Key, and searchable: `lufs:-10--8`, `lufs:-8+`, `lufs:-12-`, `lufs:-8`. The analysis measures tracks that have no value yet, and new tracks are measured on scan. Audio files are only read.
- **Track structure in the Library and on the decks** — the sections and phrases from «Phrase Finder» now show where you pick and mix tracks. The Library has a «Δομή» column (hideable) with a thin strip per track, tall where the bass plays; hover shows every part with its start and length. The deck's small seek overview gets ticks where the bass comes in and stops; click one to jump there. The scrolling waveform labels each part («Break · 16 bars»).
- **«Ομαδοποίηση» in the Library** — split whatever list is showing (the whole library, a search or an open crate) into sections you can fold, by status, energy, role, substyle, BPM band, Camelot key, genre, year or folder. «Crates» puts each track under the first crate it matches, and the rest under «Χωρίς crate». J/K and the controller's browse knob skip folded sections. The «Έξυπνοι φάκελοι» placeholder page is gone.
- **Duplicates by sound** — the duplicate check now also compares the audio fingerprints of tracks that have one, so it finds a preview of a full track, copies with credits spelled differently («&», «vs», «feat») and «Unknown Artist» copies. A match becomes a review group only when the titles agree or the audio is near-identical at the same length; a remix, edit, dub, VIP or a long mix that opens with the track is never grouped. As always, nothing is deleted or moved.
- **VST3 plugins on the decks and the master (experimental, macOS desktop app only)** — «Plugins VST3 στα decks και στο master (πειραματικό)» in «Ρυθμίσεις» runs VST3 plugins you have installed, in three slots: Deck A, Deck B and Master, each with its own plugin window and saved state. It needs two-deck mode and is off at every launch. A slot can be bypassed live; changing a plugin means stop, change, start. The decks stay in time with each other, and the waveform playhead and beat visuals are shifted by the measured delay so they line up with the sound. Settings shows the delay and any dropouts. A set recording and the plugins cannot run at the same time. If the device, a plugin or the connection fails, the sound goes back to the normal output.
- **Choose how many launch backups to keep** — in the desktop app, «Αντίγραφα ασφαλείας που κρατιούνται» in «Ρυθμίσεις» keeps 1 to 7 daily backups (default 3, as before). The app makes at most one backup per day it is opened, so 7 reaches back over the last seven days you used it; each backup of a 4,700-track library takes about 440 MB. The change applies at the next start.
- **Controller messages CrateMind does not use** — in the desktop app, «Ρυθμίσεις» lists the last 30 controller buttons and knobs that CrateMind does not use yet («Μηνύματα χωρίς αντιστοίχιση») instead of ignoring them silently. When the controller is switched to its Deck 3/4 layer, which is not mapped, a message tells you how to switch back.
- **«Waves» background** — a new option in «Επιλογή φόντου»: deep-blue lines with a lime accent where the pointer or a click pushes them.
- **An uncertain key shows «?»** — when the only key a track has is CrateMind's own and its confidence is low, the key is dimmed with a trailing «?» and a tooltip, in the Library, the deck header, Set Builder, «Ουρά tagging», Flow Finder and the history lists. Sorting, search and suggestions are unchanged.
- **«Σχετικά με το CrateMind» and the usual Mac menu items** — on macOS the app menu now has «Σχετικά με το CrateMind» (version, licence and where the source is), «Ρυθμίσεις…» (⌘,), «Υπηρεσίες», «Απόκρυψη του CrateMind» (⌘H), «Απόκρυψη άλλων» and «Εμφάνιση όλων». A new «Παράθυρο» menu has «Ελαχιστοποίηση», «Ζουμ» and macOS's own window commands.
- **Analysis waits while you play a set** — background analysis (BPM, key, beat grid, loudness) now waits between tracks while both decks hold a track and one of them plays, so it does not compete with the sound. The task shows «Σε παύση όσο παίζει ένα deck» and carries on about 10 seconds after playback stops. Listening to a single track in the Library or in «Ουρά tagging» does not hold it back.
- **Limits on artist genre research** — one run now researches at most 100 artists, gives each artist at most 5 minutes and stops after 3 hours. It keeps what it found and says how many artists were not researched; the next run continues with them.

### Changed
- **Keys from the whole track, and djay's key** — CrateMind's own key detection now listens to the whole track instead of the first two minutes, with weights trained on tracks whose key two or three DJ apps agree on, and gives a confidence. On 476 electronic music excerpts with keys labelled by people it finds the exact key 75.2% of the time, up from 54.8%. On the 471 that every app analysed: Traktor 76.9%, CrateMind 75.2%, djay 70.7%, Serato 66.9%. A track's key is now its file tag, then CrateMind's key when it is confident, then djay's key, then CrateMind's key at any confidence. «Key & Harmony» counts the keys «Από djay». Search, key statistics, suggestions and every key chip follow the same order.
- **Suggestions, 12 per page with a match score** — Flow Finder and the suggestions in «Χτίσιμο set» show 12 cards per page, up to 8 pages, and earlier pages stay as they were. Each card shows «ταίριασμα N%», the musical fit on tempo, key and genre, plus the tempo difference in percent, a genre chip and the reasons as chips. Tempo is compared as a percentage, so 3 BPM counts less at 200 than at 145. Genre comes from the track's substyle, then its artist's genre, then the file's genre tag, on a ladder from Chill and Psydub up to Psycore. In bridge mode the suggestions aim between A and B instead of at A's tempo. The «fresh» bonus and the status lines are gone (the status badge shows it). Flow Finder no longer uses a hidden «Flow scratch» set; if you have one, it now shows as an ordinary set you can keep or delete. An audition no longer replaces a playing Deck B, or anything during a set mix.
- **The artist's confirmed genre instead of artist suggestions** — the «Προτάσεις από τον καλλιτέχνη» panel (track inspector and «Ουρά tagging») ran on old, mostly unknown artist profiles and is gone. Instead, once you confirm an artist's genre in «Καλλιτέχνες», every track of that artist without a substyle of its own shows that genre, fainter, in the Library's «Substyle» column and as the placeholder of the substyle field; sorting, «Ομαδοποίηση» and `substyle:` search use it. A track's own substyle always wins, and nothing is written to the tracks.
- **A tabbed side panel in the Library** — the «Φίλτρα» panel is now resizable and has three tabs: «Φίλτρα», «Καλλιτέχνες» and «Ιστορικό». «Καλλιτέχνες» is a searchable list: click an artist to filter the table by that artist and keep your other filters. «Ιστορικό» shows your sessions: click a play to select the track, double-click to play it, drag it onto a deck or save a session as a set. The full pages leave the main sidebar and open from «Πλήρης σελίδα» in each tab or from ⌘K. Row checkboxes show only on hover, focus or when checked.
- **«Ρυθμίσεις» as a sidebar of topics** — the settings page is now 11 sections in 5 groups («Εφαρμογή», «Βιβλιοθήκη», «Ανάλυση», «Ήχος», «Σύστημα»), with a search and a status card that opens «Κατάσταση συστήματος». Every action appears once, in its own section. Scan and analysis results read as labelled counts («Προστέθηκαν: 0, Ενημερώθηκαν: 41, Αμετάβλητα: 4655, …»), and the last English button reads «Επανυπολογισμός consensus».
- **Messages time out again** — most messages close by themselves again. Only the outcome of a task (scan, fingerprints, BPM/key analysis, djay import, the duplicate check, artist genre research, a backup import) stays until you close it, so you don't miss it while on another screen.
- **A jog wheel precise enough to line up beats** — the controller's jog wheel now moves the track at vinyl rate (about 1.8 ms per tick instead of 50 ms), so you can place a beat by hand. Hold Shift for the old fast seek.
- **Auto Gain is instant** — Auto Gain now uses the loudness the analysis stores for each track, so a measured track gets its level as soon as it loads, even the first time you play it.
- **One master output** — both decks now meet on one shared master output before the speakers. That is what «REC» records and what the plugin slots feed; with nothing switched on, the sound is the same as before.
- **The playing deck's border** — the electric border now runs only along the deck's top and its mixer side, and the glow reaches under the mixer.
- **Messages as wide as their text** — a message is now as wide as its text needs, up to 880 px, instead of a fixed 356 px, so a scan summary or the question about bringing the decks back fits on one line.
- **A clearer BPM change message** — after «×½», «×2» or «Επαναφορά BPM» the message names the action and the track («Διπλό BPM: 95 → 190») and says that the value is saved only in CrateMind, not in the tags or in djay.
- **A wider main menu** — the main menu's narrowest width is now 330 px (was 292).
- **Under the hood** — tests and checks run on every push, the desktop app's third-party licences can be listed, backend and frontend libraries are updated, and the key and suggestion measurements are written up in `docs/KEY_DETECTION.md` and the README.

### Fixed
- **Key and comment tags in MP3 and M4A files** — the tag reader skipped the key, comment and rating fields of MP3, M4A, AIFF and WAV files, so a key tag in an MP3 or M4A never came first as it should. They are read now; a comment that is only a website address is left out, and a rating is stored as 1 to 5 stars (no screen shows it yet). Files are only read.
- **Flow Finder suggested A or B** — it could suggest Track A, Target B or copies of them. A, B and every excluded track now take their duplicate copies with them, and copies among the suggestions collapse to one.
- **Set exports to M3U and CSV** — exporting a set from the Library's «Sets/Playlist» tab failed for M3U and CSV after the first export, and «Χτίσιμο set» replaced the previous set's file. Each set now gets its own file (`set-<id>.m3u8`, `set-<id>.csv`, as Markdown already did), and exporting it again replaces only that file. A failed export says why («Αποτυχία εξαγωγής M3U» with the reason).
- **Resolved duplicates came back** — a duplicate group you resolved or ignored came back as a new group on the next check. A decided group now stays decided; a new copy of the same recording still opens a group.
- **Hidden analysis failures** — an analysis run whose beat grid, key or loudness steps failed read as if nothing happened. The result now ends with «Αποτυχίες σε beatgrid/key/LUFS: N».
- **The beat light on the playhead** — while paused or scrubbing, the playhead turned cyan for a few positions around a beat; it now lights only when it is exactly on the beat line, and beat lines, cues and part labels no longer sit half a pixel off.
- **Faint backgrounds in the light theme** — Soft Aurora, Aurora, Prism, Prismatic Burst, Gradient ASCII and Faulty Terminal were barely visible in «Ηλιακό Φως»; they are clearly visible now, and Soft Aurora no longer greys the page. The dark theme is unchanged.
- **Cut-off glows** — the playing deck's glow ended in a straight line over the mixer, and in the desktop app the cover halo in the track panel was cut to a square. Both now fade out on their own.
- **Another controller mistaken for the Platinum FX** — only a port named Mixtrack Platinum is treated as the controller now, so a Mixtrack Pro FX no longer receives the Platinum FX's messages.
- **Web version security** — for those who run the development web version: the backend now refuses requests from other websites and from unknown hostnames.
- **Sound that stayed off after the output device dropped** — when the sound output was interrupted (a device unplugged, the Mac waking up), CrateMind tried once to bring it back and could stay silent until the next press of play. It now tries again when you return to the window, click or press a key, and when a device is connected.
- **A deck stuck on loading** — if a deck's audio engine stopped answering during a load, the deck stayed busy and every later load waited behind it. The load now fails after a few seconds and the next one starts fresh.
- **A wrong button name in Phrase Finder** — the «Χωρίς δομή» hint named a button that does not exist; it now says «BPM + Key · μόνο νέα».


---

## [0.6.0] - 2026-11-16 — CrateMind's own beat grid, a Sync that locks, a working Phrase Finder, and Crates and Sets inside the Library

CrateMind now builds its own beat grid from the audio and prefers it to djay's when it is confident; a confident steady grid's tempo also becomes the track's BPM. Sync, on screen and on the controller, locks a deck to the other deck's tempo and beats. «Phrase Finder» is a working page: it measures where each track's bass comes in and drops out, and the decks draw its phrase lines. The Library takes in Crates, Sets, the Tag Cloud and Flow Finder. Every page shares one header, the deck footer is rearranged and the playing deck glows. Messages stay on screen until you close them, and job results and server errors read in Greek.

> **After updating:** the first launch adds a column and a table to the library (with a backup first when the library lives in a dataset folder). The first «BPM + Key · Μόνο νέα» in «Ρυθμίσεις» then builds the grid and structure of every track once, about 2 seconds per track; BPM and key are not analysed again. A library-exchange file from this version is refused by older installs.

### Added
- **CrateMind's own beat grid** — the BPM analysis now builds a beat grid for each track from the audio: tempo, beat positions and the bar line, with a confidence. A track with a timing jump (also of a quarter, half or three quarters of a beat) or a tempo change gets a grid of steady sections. When the grid is confident it is used before djay's; otherwise djay's grid stays, if there is one. On 417 test tracks it landed on the kick at 97.8% of points on steady tracks (djay 96.5%) and at 91.9% on tracks with changes where it was confident (djay 90.3%). Audio is only read; djay data, tags and files are untouched. Method and limits: `docs/BEATGRID_DETECTION.md`.
- **«Phrase Finder»** — the page was a «σύντομα» placeholder. The BPM analysis now also measures where each track's bass plays and stops, and puts a phrase line every 8 bars from where the bass comes in. The page lists tracks (with the Library's search language) with a small map of their sections; for the selected track it shows the map, the phrase lines and the mix points: first bass, each break and return, end of the bass. Each point loads the track on a deck at that second («→ A», «→ B») or saves it as a cue. On the deck waveforms the heavy line now falls on the measured phrase lines. It needs a confident CrateMind grid, and tracks without a clear kick and bass get no structure. Method and limits: `docs/TRACK_STRUCTURE.md`.
- **Sync on screen** — each deck has a Sync button next to play; before, Sync existed only on the controller.
- **A glow on the playing deck** — in two-deck mode the deck that plays gets an electric border and a wide glow in its colour, fading out when it stops (static with reduced motion).
- **Stop a scrub on the beat** — while a deck is paused or scrubbed, the playhead turns cyan when a beat is under it.

### Changed
- **Sync is a lock** — Sync now locks the deck to the other one: it takes its tempo, puts the beats together (a shift of at most half a beat) and keeps them there while the button is lit, following the other deck's pitch and bend. A correction by hand (bend, scrub) is kept. Press Sync again to let go; moving the deck's own pitch fader, a new track on the other deck or starting «Αναπαραγωγή ως μίξη» also let go, and the held tempo stays on the fader. One deck is locked at a time. Without grids on both decks, with a loop, or with a grid at half or double tempo it follows the tempo only.
- **BPM from the beat grid** — when CrateMind's grid is confident and steady, its tempo is the track's BPM, second only to a BPM you set yourself (then the file tag, the online consensus and the local analysis). This fixes tracks where the estimates were a fraction off (145.19 for a 146 track) or the local analysis picked a 4/3 or 3/2 tempo. Real decimal tempos (130.23) stay as they are, so loops and Sync don't drift.
- **Crates, Sets, Tag Cloud and Flow Finder live in the Library** — the Library's right panel has three tabs: «Κομμάτι» (the inspector), «Crates» and «Sets/Playlist», with the same actions as the old pages; clicking a crate runs its search in the table, and unsaved profile edits survive a tab change. In the DJ profile «Ετικέτες» opens the Tag Cloud in a side drawer and «Flow Finder» opens a drawer with the selected track as track A. The old addresses lead to the new tabs; in the music-therapy profile the Tag Cloud stays a page.
- **Library tools in the sidebar** — the toolbar under the search moved into a folded «Εργαλεία βιβλιοθήκης» section at the top of the sidebar (set picker, «Νέο set», «Αποθήκευση ως crate», SoundCloud review, columns), next to «Έτοιμα φίλτρα» and «Μαζική επεξεργασία», which keeps its draft while folded. On a narrow window the table and the sidebar stack, and an «Εργαλεία» button jumps to the inspector. The save button sits under the scroll area instead of covering fields.
- **A grouped track inspector** — identity, the first four axes and status stay in view; the rest folds into «Λεπτομέρειες αξιολόγησης», «Προτάσεις από τον καλλιτέχνη», «Προφίλ μετάβασης», play history and «Tags και λεξιλόγια». Sources show as compact links («Συλλογές», «Προέλευση», «Άλλες πηγές») with Greek statistics labels, your own notes are kept apart from the file and source comments, and the large centred cover is back with a blurred halo.
- **Clean track titles** — release and mastering notes in titles and filenames («[190] Soon On STZ - Records», «unmastered», «Master 24 bit») are left out of the shown title, while named versions (remix, edit, VIP) stay. Useful notes (unmastered, bit depth) appear as source comments. A title the tag reader cut short is completed from the filename when the filename clearly holds the rest, and search also matches filename text. This is display only: nothing is written to files or to the stored title.
- **The deck footer** — each deck's half of the dock now runs, from the outer edge to the mixer: the 8 pads; a column with elapsed time, play and Sync above a small seek overview, and the remaining time (rose in the last 30 seconds), BPM and key below it; the artwork (150 px) with title and artist, where a long title slides; and the pitch fader, which now fills its column. On a narrow window the artwork goes first. Deck B is lime green instead of magenta. The level bars left the dock (the mixer's meters show the same), and the waveform panel's info row is gone, giving the page 42 px.
- **One header on every page** — all pages share one header: an icon, a title with a slow sheen, a count, a subtitle and actions on a glass bar. Buttons press in slightly, and tinted buttons share one soft style. Switching theme uses a circular reveal (skipped with reduced motion).
- **«Ηλιακό Φως» is real glass** — the light theme's cards, dock and waveform controls are see-through, so the background shows through as in «Νυχτερινό Κενό». The deck waveform screen is white glass there, with dark beats, deep chartreuse bars, and A/B chips and bar numbers that stay readable. The A/B chips are larger in both themes, and the title bar of the desktop app is frosted.
- **Messages stay until you close them** — every message stays on screen until you click its close button, so a scan or analysis result is never missed. The quick confirmations while playing («cue αποθηκεύτηκε», undo) still time out.
- **Job results and errors in Greek** — job results («Βρέθηκαν 4 ομάδες διπλοτύπων»), fingerprint and djay import summaries and about 30 server errors now read in Greek; any other error falls back to a Greek line, and a lost connection reads «Δεν υπάρχει σύνδεση με την υπηρεσία του CrateMind». «Export OK» became «Έγινε export».

### Fixed
- **Specular button light** — the light of the specular buttons no longer spills outside them; the glow is a halo around the button.
- **Windows release build** — the installer build retries a folder rename that Windows can block for a moment; it failed the first 0.5.1 tag build.

---

## [0.5.1] - 2026-11-07 — A signed macOS download, visible borders in the light theme and dropdowns that open below their field

Every release now ships a Developer ID signed, notarized DMG for Apple Silicon Macs next to the Windows installer. The light theme gets visible borders and faint fills everywhere (count badges, card buttons, dividers, stat boxes, the research progress bar), dropdowns open just under their field, and idle level meters no longer show coloured specks. Windows installs of 0.5.0 update to this release by themselves: the first automatic update.

### Added
- **macOS download** — every release now includes `CrateMind.Preview-mac-arm64.dmg` for Apple Silicon Macs with macOS 15 or later. Open it and drag «CrateMind Preview» to Applications. It is signed with a Developer ID and notarized by Apple, so it opens without a Gatekeeper warning. There are no automatic updates on macOS: download the newer DMG and replace the app; your library stays.

### Changed
- **Dropdowns open below their field** — every dropdown («Ρόλος στο set», «Κατάσταση», …) now opens just under its field instead of on top of it, so the field and its label stay visible. Options are taller and rounder, and the selected one reads in medium weight with a cyan tick.

### Fixed
- **Specks on idle level meters** — the mixer's level meters showed two red pixels at the top and two green ones at the bottom while silent; the coloured scale now only appears where there is signal.
- **Borders and faint fills in the light theme** — count badges, card buttons and the line above them («Crates», «DJ Sets»), the «Στατιστικά set» boxes, the research progress bar on «Καλλιτέχνες», the outline of «Παίζει / Επιλογή / Τελευταίο» and many other hairlines were invisible on the light theme's pale surfaces. They now use a theme-aware colour; the dark theme looks exactly as before. A crate's track count is grouped the Greek way (2.668).

---

## [0.5.0] - 2026-11-07 — Set transitions and a continuous mix, a one-click Windows installer with automatic updates, and renamed files that keep their history

«Χτίσιμο set» gets a transition between every pair of tracks that you can see, hear and edit, and «Αναπαραγωγή ως μίξη» plays the whole set as one continuous mix on the two decks. Windows moves to a one-click installer that updates itself in the background from this release on. A scan now merges a renamed or moved file into its old track instead of leaving it «λείπει», CSV exports open correctly in Greek Excel, and the «Συλλογές» screens get the app's look.

### Added
- **Set transitions and «Αναπαραγωγή ως μίξη»** — every pair of neighbouring tracks in «Χτίσιμο set» now has a transition pill («Αυτόματο · Ανάμειξη», «Κόψιμο», …) whose tooltip says why Auto picked it (key, BPM distance, profile). Click it for «Επεξεργασία μετάβασης»: both waveforms with the bar grid and the volume/EQ/filter curves, a window you drag (or move with bar/beat buttons and the arrow keys), ten presets («Ξεθώριασμα», «Άνοδος», «Ανάμειξη», «Κύμα», «Λιώσιμο», «Κόψιμο», «Διάλυση», «Έκρηξη», «Απόηχος», «Χωρίς μετάβαση»), each parameter on its own, «Ταίριασμα tempo», a preview on the decks and «Αποθήκευση» per set. «Αναπαραγωγή ως μίξη» then plays the whole set as one continuous mix on the two decks: each transition starts on the beat, the next track matches the current tempo and eases back to its own over 8 bars, key lock stays on during the mix and your settings come back when it ends. A strip above the decks shows what plays now and next, a countdown, «Παράλειψη» and «Διακοπή». Only the transitions and their audit entries are stored; audio files, tags, cues, beatgrids and djay data are never touched. A library-exchange file from this version is refused by older installs (new table).
- **«Iridescence · Violet» background** — a second Iridescence look in «Επιλογή φόντου»: violet and magenta streaks that follow the pointer and swirl where you click. The original is now listed as «Iridescence · Pearl».
- **Automatic updates on Windows** — a couple of minutes after it opens, CrateMind checks for a newer release and downloads it in the background. It installs only when you close the app, never mid-set, and doesn't touch your library or settings. Updates start working with the first release that ships the new installer.

### Changed
- **One-click Windows installer** — the old step-by-step wizard is replaced by `CrateMind.Preview-win-Setup.exe`: a short splash, no questions and no admin prompt, then CrateMind opens. It installs for your account only, and WebView2 is downloaded only if Windows doesn't already have it, so the installer no longer carries its own copy and is smaller. **If you have the old version installed, uninstall it first** from Settings → Apps and leave «Delete the application data» unchecked; your library stays. Still unsigned, so SmartScreen asks once: «More info» → «Run anyway».
- **More room for the set in «Χτίσιμο set»** — the candidates panel and the analysis panel each fold to a thin strip with a chevron, and a one-tap «Εστίαση στο set» icon in the timeline footer folds both panels and the sidebar together. On a portrait phone the page opens folded, so the set list gets the whole width. Your choice is remembered.
- **Artist genre research shows its progress** — the research on «Καλλιτέχνες» now shows a progress bar with «N/M επεξεργασμένοι», the artist being researched («Τώρα: …») and the time left («Απομένουν ≈N λεπτά»). If the connection drops it reconnects («Επανασύνδεση…») instead of losing track of the job.
- **The «Συλλογές» screens look like the rest of the app** — «Συλλογές», «Προέλευση συλλογών», «Πληρότητα & ανάκτηση», «Μεταδεδομένα & καλλιτέχνες» and «Ενοποιημένη βιβλιοθήκη» now share one header, glass panels, status pills and a compact pager. Every count is grouped with Greek separators (19.954), each source tile in «Ενοποιημένη βιβλιοθήκη» shows its linked / high-confidence / probable split as a bar, dates read as Greek dates, and the long explanation in «Πληρότητα & ανάκτηση» folds away under «Πώς διαβάζονται οι αριθμοί». The colours follow the theme, so these screens now also read in the light theme.
- **Glass headers** — the dashboard's title bar, the Library table's column header and the two waveform-panel toggles were solid black; they are now see-through glass like the rest of the UI. The «εκτίμηση · DOWNBEAT · Ορισμός» chips on each deck waveform use a lighter glass, so the waveform shows through.

### Fixed
- **CSV export opens correctly in Greek Excel** — fields are now separated with «;», so a double-clicked file splits into columns under Greek regional settings instead of landing in column A, and numbers are written with at most two decimals, so Excel no longer misreads a value such as 240.024 as 240024. Excel set to a «,» list separator (e.g. English US) needs «Data → From Text/CSV».
- **Renamed or moved files keep their history** — a scan used to add a renamed file as a new, empty track and mark the old one «λείπει», leaving its status, sets, cues, beatgrid and SoundCloud link behind. Every scan now merges a missing track into the one available track with the same bytes: everything moves to the file's new path and the stale row goes, with the details kept in the audit log. When more than one copy matches, nothing is merged. The scan message reports «συγχωνεύτηκαν μετακινημένα N». Audio files are never touched.
- **Internal keys on the «Συλλογές» screens** — provider names («spotify»), collection relationships («owned · private»), match classes, DJ statuses and a SoundCloud account number showed as raw keys; they now read in Greek or by name. An artist stored as the text "null" shows as «Άγνωστος καλλιτέχνης». In «Ενοποιημένη βιβλιοθήκη», «Υπάρχον στοιχείο» now names the earlier decision («χειροκίνητη επιβεβαίωση», «ίδια μεταδεδομένα», …) instead of its internal key, and screen readers announce the close button of dialogs and side panels as «Κλείσιμο».

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

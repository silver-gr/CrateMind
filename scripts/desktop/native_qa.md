# Native WebView acceptance

Use a built preview `.app`, never personal app data. `scripts/desktop/smoke_installed.py` is a packaged HTTP/lifecycle check; it does not operate WKWebView.

1. Create a disposable absolute fixture directory containing `.cratemind-qa-fixture`, seeded paired data and source-root mappings. Audio fixtures must be generated or redistributable, with original hashes recorded.
2. Add `native-qa-fixtures.json`: `{"tracks":[{"id":1,"codec":"mp3"}]}`. Allowed codecs: mp3, flac, wav, m4a, ogg, opus, aiff. IDs must refer to the fixture catalog. Include all formats and an AIFF refusal case. No supplied scripts, URLs, commands or audio paths are accepted by the QA surface.
3. Launch the preview executable with `--qa-app-data /absolute/fixture --qa-run`. Add `--qa-stay-open` only when screenshots/manual interactions are needed. The marker and explicit QA flags gate fixed compiled probes; there is no HTTP/Tauri QA command.
4. Read `native-qa-report.json`. It contains user agent/origin, authenticated fetch, inaccessible HttpOnly cookie, Greek Settings/library rendering, media 206/416, metadata/native decode/play/seek and preferences evidence. Missing fixtures do not prove codec support. A failed probe remains a failure.
5. Launch the same fixture again. The next report checks the previous saved marker across a new ephemeral origin and records the applied theme. Preserve both reports for provenance.
6. Manually verify native folder dialogs, menu/focus, copy/paste/selection, typing shortcut guards, cue persistence, close during a scan, accessibility/reduced-motion, image/artwork and heard playback. Record screenshots and per-platform codec limits. The fixed muted decode probe is not heard-audio evidence.

macOS arm64 is the only local native route. Windows/Linux and offline clean-machine installs need actual separate runners; preparing CI or compiling source does not establish those gates. Unsigned/ad-hoc builds are development artifacts; signing, notarization and redistribution-license obligations remain release gates.

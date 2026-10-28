# CrateMind native host

Tauri 2 shell around the shared frozen Python desktop-core. Rust never reads or writes `active.json` or a library database. Backend/tool/front-end resources must be staged first; development has no executable environment fallback.

Pinned Tauri crate 2.12.5, tauri-build 2.7.4, single-instance 2.5.4, JavaScript CLI 2.12.4. The current local build uses Homebrew Rust/Cargo 1.99.1 on macOS arm64. `rust-toolchain.toml` also declares that exact version for rustup; direct Homebrew executables do not obey rustup selection.

```sh
cargo test --manifest-path native/src-tauri/Cargo.toml
cargo build --manifest-path native/src-tauri/Cargo.toml --release --features custom-protocol
cd native
bun install --frozen-lockfile
bun run build:preview
```

The build scripts currently support macOS arm64 and produce an ad-hoc `.app`.
They restore the full staged backend after Tauri copies resources, preserving
PyInstaller's symlink tree, then sign nested code/frameworks and the final app.
Direct `tauri build` output has not completed these steps. Validate the final app
with `scripts/desktop/verify_bundle.py` and `scripts/desktop/smoke_installed.py`.
Build one heavy process at a time; the wrapper sets `CARGO_BUILD_JOBS=1`.

Production identifier: `gr.x3lixi.cratemind`. Preview identifier: `gr.x3lixi.cratemind.preview`. A fixture-only installed-artifact launch may use `--qa-app-data /absolute/temp/fixture`; the directory must already contain `.cratemind-qa-fixture`. Never launch acceptance against personal app data.

Initialization and subsequent parent controls use bounded newline JSON on stdin. The secret is never an argument, URL, frontend state, or public IPC command. The HTTP frontend has no registered invoke handler or remote capabilities. Native menus own navigation and standard Edit actions; Python requests the fixed native-action whitelist over the private child pipe.

The host creates the backend's Unix process group or Windows kill-on-close Job before execution, drains pipes, requires authenticated health after matching BOUND, installs and reads back the HttpOnly cookie off the UI thread, and navigates the hidden main WebView. Normal stop gives Python seven seconds, then terminates/reaps the owned tree within the eighth second. Python's EOF watchdog handles host death on Unix.

`EXCHANGE_PREPARED` registers a bounded, expiring preview and decision. Rust accepts only that preview, stops Python, runs the fixed packaged exchange helper, then restarts with a fresh secret/origin. Python alone verifies staging and changes active data.

Local Rust tests and executable compilation do not establish installed WebView cookie delivery, codec playback, clean-machine independence, Windows/Linux behavior, OS support floors, release signing, notarization, or license-complete redistribution. Those remain separate acceptance gates. `tauri.conf.json`'s macOS deployment metadata is provisional until target package dependencies are checked on clean machines.

# Research: Tauri 2 native implementation references

Retrieved: 2026-10-27. Research only; no dependencies installed, application source changed, database opened, or native artifact tested. Read the validated design and implementation plan in this directory's sibling `specs/` and `plans/` directories.

## Request Type

Implementation reference lookup plus version/toolchain verification. Search path: Context7 CLI library resolution → targeted official documentation → exact released crate source where the documentation leaves completion semantics unclear. Context7's Tauri index includes older snapshots and the development branch; release metadata and released source take precedence.

## Direct Answer

The chosen architecture has the required APIs. Implement the hidden bundled startup window, authenticated loopback navigation, native cookie setup and process supervision in Rust. Keep Python responsible for the external HTTP origin's authentication/CSP. Preserve the entire PyInstaller onedir tree as resources. Native WebView and installed-artifact acceptance remain necessary; documentation does not prove those behaviors.

### Verified version baseline

| Component | Exact stable version | Evidence / compatibility |
|---|---|---|
| `tauri` | `=2.12.5` | [Registry metadata](https://crates.io/api/v1/crates/tauri/2.12.5); Rust minimum 1.90; released 2026-10-21 |
| `tauri-build` | `=2.7.4` | [Registry metadata](https://crates.io/api/v1/crates/tauri-build/2.7.4); Rust minimum 1.90; matches Tauri's build requirement |
| `tauri-plugin-single-instance` | `=2.5.4` | [Registry metadata](https://crates.io/api/v1/crates/tauri-plugin-single-instance/2.5.4); requires `tauri ^2.12`, Rust 1.90 |
| `@tauri-apps/cli` | `2.12.4` | [Official package registry](https://registry.npmjs.org/@tauri-apps%2fcli); `latest` stable tag; `next` is Tauri 3 alpha |
| PyInstaller | `6.22.3` | [PyPI metadata](https://pypi.org/pypi/pyinstaller/6.22.3/json), [versioned manual](https://pyinstaller.org/en/v6.22.3/) |
| Python build interpreter | Local `3.13.18` available | `/opt/homebrew/opt/python@3.13/bin/python3.13`; retain the plan's Python 3.13 line pending the packaging spike |

Use exact manifest versions and commit the resolved Cargo/package/Python lockfiles. The newest returned single-instance release is `3.0.0-alpha.3`; do not select it for this Tauri 2 implementation. Tauri crate/CLI/build/plugin version numbers intentionally differ; they need compatible release lines, not identical numeric versions. [Released Tauri dependencies](https://crates.io/api/v1/crates/tauri/2.12.5/dependencies), [single-instance dependencies](https://crates.io/api/v1/crates/tauri-plugin-single-instance/2.5.4/dependencies).

### Hidden window, cookie and navigation sequence

Use `WebviewWindowBuilder::new(..., WebviewUrl::App("index.html".into()))`, `.visible(false)`, `.on_navigation(...)`, `.on_new_window(...)` and `.on_page_load(...)`. After authenticated readiness, install the launch cookie using `WebviewWindow::set_cookie`, verify it using `cookies_for_url` from a background thread/blocking task, then `navigate(exact_origin)`. Show only after the expected document has loaded. `PageLoadEvent::Finished` reports load completion; its payload is not an HTTP success status. [Window builder reference](https://docs.rs/tauri/2.12.5/tauri/webview/struct.WebviewWindowBuilder.html), [window reference](https://docs.rs/tauri/2.12.5/tauri/webview/struct.WebviewWindow.html).

Cookie builder shape for this pinned release:

```rust
use tauri::webview::{Cookie, cookie::SameSite};

let cookie = Cookie::build((launch_cookie_name, session_secret))
    .domain("127.0.0.1")
    .path("/")
    .http_only(true)
    .same_site(SameSite::Strict)
    .secure(false) // the selected origin is plain loopback HTTP
    .build();
window.set_cookie(cookie)?;
```

This example is documentation-grounded, not compiled in this lane. Do not print cookie values. Native setters consume the cookie's domain/path rather than accepting a separate URL; supply those explicitly. Verify initial navigation and authenticated media on each target WebView; cookie-store readback alone does not prove that an HTTP request sends it. In particular, retain a test for the initial bundled-page → HTTP navigation with `SameSite=Strict`.

Cookie reads can deadlock inside synchronous Windows commands/event handlers. Start the readback work after returning control to the event loop, using a separate thread or async blocking task; apply a bounded startup deadline. Do not block the setup/UI thread while waiting for work dispatched to it. [Cookie API warning](https://docs.rs/tauri/2.12.5/tauri/webview/struct.WebviewWindow.html#method.cookies).

Allow only the bundled bootstrap during startup and the exact authenticated HTTP origin afterward. Compare parsed scheme/host/port, reject userinfo and unwanted schemes, and handle new-window requests explicitly. Do not rely on string prefixes. These checks are implementation guidance based on the available navigation hooks; they are not a substitute for backend Host/Origin/auth checks.

### No remote IPC

Do not register an application `invoke_handler` for the HTTP frontend. Do not grant any capability with `remote.urls` matching loopback, and do not retain scaffold `core:default`, shell, filesystem or other frontend permissions. Keep `withGlobalTauri: false`; this hides the global convenience API but is not the authorization boundary. Rust-owned native menus/actions can still use Rust APIs directly.

Capabilities merge when more than one matches a window. Files in the capabilities directory are auto-enabled unless the config selects capabilities explicitly. Also, application commands registered through `invoke_handler` are allowed by default unless command-manifest permissions constrain them. Inspect the resulting manifest, not just an empty-looking capability array. [Official capabilities guide](https://v2.tauri.app/security/capabilities/).

Tauri's `on_web_resource_request` hook currently applies to its custom protocol, not an external HTTP server. Therefore Python must supply CSP and HTTP security headers for the loopback SPA/API/media responses. [Released API documentation](https://docs.rs/tauri/2.12.5/tauri/webview/struct.WebviewWindowBuilder.html#method.on_web_resource_request).

Register the single-instance plugin before all other plugins and before backend spawn; the second-instance callback focuses the existing window without starting another Python process. [Official single-instance guide](https://v2.tauri.app/plugin/single-instance/).

### Complete process ownership

On Unix, stable `std::os::unix::process::CommandExt::process_group(0)` creates a group whose PGID is the child PID. Signal the owned group with `libc::kill(-pgid, SIGTERM)`, then `SIGKILL` after a bounded drain, and reap the direct child. Validate PGID > 1. Stable Rust's child-group convenience kill methods are not available; avoid nightly-only APIs. [Rust process-group API](https://doc.rust-lang.org/std/os/unix/process/trait.CommandExt.html#tymethod.process_group), [Apple kill semantics](https://developer.apple.com/library/archive/documentation/System/Conceptual/ManPages_iPhoneOS/man2/kill.2.html).

A process group does not provide automatic cleanup after the Rust host is killed. The inherited parent channel/EOF watchdog and Python's tracked tool children remain necessary for that failure path. Descendants deliberately creating a new group/session escape the original group; coordinate the shared Python ToolRunner instead of assuming all future children remain contained.

On Windows, create a Job Object, set `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE`, retain its non-inherited handle in the host, and associate Python before it executes. Descendants join by default unless breakaway is enabled; do not enable breakaway. Explicit stop may use `TerminateJobObject`, followed by handle/process cleanup. [Microsoft Job Objects](https://learn.microsoft.com/en-us/windows/win32/procthread/job-objects).

Prefer `STARTUPINFOEXW` + `PROC_THREAD_ATTRIBUTE_JOB_LIST` + `EXTENDED_STARTUPINFO_PRESENT` in `CreateProcessW` on Windows 10+. Creating suspended and then calling `AssignProcessToJobObject` leaves a crash window with an orphaned suspended process. Microsoft documents job-list assignment before the initial thread runs. [Attribute API](https://learn.microsoft.com/en-us/windows/win32/api/processthreadsapi/nf-processthreadsapi-updateprocthreadattribute), [Microsoft explanation](https://devblogs.microsoft.com/oldnewthing/20230209-00/?p=107812/).

Rust 1.99.1's `CommandExt::spawn_with_attributes` remains nightly-only, so stable implementation requires the Win32 creation API or another already-authorized compatible seam. Use explicit inherited stdin/stdout/stderr handles and a handle allowlist; never inherit the Job handle. Quote executable paths correctly and avoid a shell. [Rust Windows process API](https://doc.rust-lang.org/std/os/windows/process/trait.CommandExt.html), [Microsoft process creation](https://learn.microsoft.com/en-us/windows/win32/procthread/creating-processes).

### Full PyInstaller onedir resource tree

Keep `backend-executable` and its entire `_internal/` sibling tree together. In PyInstaller 6 onedir, `sys._MEIPASS` points inside `_internal`; `sys.executable` points to the real outer executable. Package-relative resources should use `__file__` with matching spec destinations. Never copy only the executable. [Versioned runtime reference](https://pyinstaller.org/en/v6.22.3/runtime-information.html).

Map the staged **directory**, not a flattening map glob, into Tauri resources, for example `"resources/backend/": "backend/"`. Resolve it through Rust's `app.path().resource_dir()` or `BaseDirectory::Resource`; frontend filesystem permissions are unnecessary. Map globs flatten matched files, while directory mappings preserve hierarchy. [Official resource guide](https://v2.tauri.app/develop/resources/).

Preserve symlinks and executable modes through staging and installation. PyInstaller 6 POSIX bundles rely on symlinks; use symlink-preserving copy/archive operations and inspect the final Tauri artifact. On macOS `cp -fR` preserves links whereas `cp -fr` does not; ordinary zip needs `-y`. Call `multiprocessing.freeze_support()` before starting the application. The frozen bootloader changes child library-search behavior, so run bundled ffmpeg/fpcalc from their absolute staged paths and verify their exact dynamic-library dependencies rather than relying on PATH. [Versioned pitfalls guide](https://pyinstaller.org/en/v6.22.3/common-issues-and-pitfalls.html).

PyInstaller is not an OS cross-compiler. macOS/Homebrew builds may require the build OS or newer; a successful local build cannot establish an older macOS floor or Windows/Linux support. [Manual](https://pyinstaller.org/en/v6.22.3/), [requirements](https://pyinstaller.org/en/v6.22.3/requirements.html), [macOS compatibility guidance](https://pyinstaller.org/en/v6.22.3/usage.html#making-macos-apps-forward-compatible).

### Offline WebView2

Use `bundle.windows.webviewInstallMode = { "type": "offlineInstaller" }`. The default `downloadBootstrapper` and `embedBootstrapper` require internet; `skip` does not install the runtime. Offline installer packaging downloads/builds the prerequisite ahead of distribution, so the build can need internet while installation remains offline. The guide's approximate added size is not a CrateMind measurement. Test a Windows machine with no runtime and no network. [Official Windows installer guide](https://v2.tauri.app/distribute/windows-installer/).

## Source-Reference Evidence

Needed because public cookie APIs do not describe completion propagation. Read the exact published crate archives, without installing them:

- [tauri-runtime-wry 2.12.3 source](https://docs.rs/crate/tauri-runtime-wry/2.12.3/source/src/lib.rs): `set_cookie` enqueues `WebviewMessage::SetCookie` and returns. Later platform-set failures are logged; they do not propagate back through the original return value. `Ok(())` is therefore not proof of installed authentication.
- [wry 0.57.0 macOS source](https://docs.rs/crate/wry/0.57.0/source/src/wkwebview/mod.rs): cookie insertion uses WKHTTPCookieStore completion and a blocking-operation pump.
- [wry 0.57.0 Windows source](https://docs.rs/crate/wry/0.57.0/source/src/webview2/mod.rs): cookie conversion takes explicit domain/path; insertion calls WebView2 `AddOrUpdateCookie`.
- [Released Tauri manifest](https://docs.rs/crate/tauri/2.12.5/source/Cargo.toml): cookie dependency is `0.18`, runtime-wry requirement is `~2.12.3`. The runtime-wry release uses wry `0.57.0`; Cargo.lock must record the actual patch resolution.

## Local Toolchain Evidence

- Machine architecture: `arm64`.
- Shell PATH selects `/opt/homebrew/bin/rustc` and `cargo`, both **1.99.1**.
- `rustup` also exists; its sole installed `stable-aarch64-apple-darwin` toolchain is **1.93.1**. Both satisfy the selected crates' Rust 1.90 minimum.
- A `rust-toolchain.toml` does not control direct Homebrew cargo/rustc executables. Use a consistent rustup proxy/explicit toolchain invocation or document the Homebrew toolchain; verify the executed versions during builds.
- Xcode **26.3**, build **17C529**, active at `/Applications/Xcode.app/Contents/Developer`.
- Default `python3` is **3.15.2**; select the explicit Python **3.13.18** executable above for this packaging line.
- Default `~/.cargo/registry/src` and `cache` were absent; `CARGO_HOME` was unset. No preinstalled Tauri crate cache was found there. Network resolution/build is still required.

## Caveats / Ambiguity Flags

- No compile, dependency install, artifact creation, browser/native launch, database access, media playback or process-kill experiment occurred in this research lane.
- Context7 returned dev-branch excerpts and an older version list. Exact stable registries and released crate archives were checked before selecting the versions above.
- Official PyInstaller CLI synopsis still mentions Python 3.8–3.11 despite the manual/changelog supporting newer versions; use the versioned manual and successful Python 3.13 packaging spike, not that stale synopsis.
- Agent-reach's `mcporter` and `agent-reach` commands were unavailable. Context7 CLI worked; built-in web search/fetch and official package registry/source retrieval supplied the cited fallback evidence.
- Cookie readback, native navigation, HTTP success, SameSite delivery and codec support are separate acceptance claims. The installed native-WebView tests must establish each relevant one.

## Reusable Takeaway

Pin the verified Tauri 2 line, expose no frontend IPC, confirm native cookie insertion asynchronously, keep loopback security in Python, ship the complete onedir resource tree, and contain owned child processes using platform facilities. The macOS toolchain is available; cross-platform installed-artifact gates remain unproven.

# Branded Native Startup and Transparent Title Bar

## Goal

Show a centered, theme-aware CrateMind loading screen before backend preparation, while retaining native window controls and safe retry/close behavior.

## Cause and correction

Pinned Tauri2.12.5 normalizes WebviewUrl::App(index.html) to the bundled rootURL. The navigation policy previously allowed only /index.html, blocking the actual first document. A shared strict bundled-origin predicate now permits root and explicit index paths, and a separate local-document-ready flag gates backend startup on the worker thread with a10-second bound. Backend/QA readiness remains separate.

Source evidence: https://github.com/tauri-apps/tauri/blob/tauri-v2.12.5/crates/tauri/src/manager/webview.rs#L469-L485

## Presentation

- Centered frosted card with reused glyph, cyan/violet ambient tint and restrained cyan/lime/violet activity.
- CSS transform/opacity motion only; reduced-motion has a static indicator. No fake percentage or invented completion steps.
- Native stored theme selects matching initial window/background and local HTML theme. macOS uses Transparent titlebar with native traffic lights.
- Errors retain the same branded surface and explicit retry guidance. No backend-dependent assets or scripts are required.

## Verified boundaries

- Actual standalone HTML rendered in browser: dark/light previews, centered within0.01px, glyph loaded, static reduced motion, error and retry fit800x600.
- Rust files parsed with rustfmt and trusted initialization JavaScript syntax/URL/deferred-root behavior checked without compilation.
- Added Rust URL regression tests are not executed. No application build/restart/commit was requested or run. Native compositor timing and titlebar appearance require a subsequent authorized desktop build.

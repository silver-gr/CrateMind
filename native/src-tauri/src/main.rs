#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]
fn main() {
    // Must run first: during Velopack install/update/uninstall it handles the hook and exits.
    // No auto-apply here: it would run before single-instance and could replace files under a
    // running session. Downloaded updates install when CrateMind closes (updates.rs).
    #[cfg(windows)]
    velopack::VelopackApp::build().set_auto_apply_on_startup(false).run();
    cratemind_native::run();
}

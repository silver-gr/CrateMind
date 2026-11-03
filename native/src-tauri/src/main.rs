#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]
fn main() {
    // Must run first: during Velopack install/update/uninstall it handles the hook and exits.
    #[cfg(windows)]
    velopack::VelopackApp::build().run();
    cratemind_native::run();
}

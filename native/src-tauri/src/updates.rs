//! Windows auto-update through Velopack. Checks GitHub Releases in the background and installs a
//! downloaded update only when CrateMind closes, after the backend has stopped; never mid-session.
//! Changes only the Velopack install folder (%LocalAppData%\CrateMind.Preview); in app data it only
//! writes logs/updates.log (and keeps the previous session's copy as updates.prev.log).
use std::{
    fs,
    io::{Read, Write},
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicBool, Ordering::SeqCst},
        OnceLock,
    },
    time::{Duration, SystemTime, UNIX_EPOCH},
};
use velopack::{
    bundle,
    locator::{self, LocationContext, VelopackLocator},
    sources::{FileSource, GithubSource, NoneSource, UpdateSource},
    UpdateCheck, UpdateManager,
};

const FEED: &str = "https://github.com/silver-gr/CrateMind";
const CHECK_DELAY: Duration = Duration::from_secs(120);
static LOG: OnceLock<PathBuf> = OnceLock::new();
// Admission handshake, SeqCst store-then-load on both sides: a step that can write Update.exe runs
// only inside `busy`, never starts once `on_exit` has begun, and `on_exit` never overlaps one.
static BUSY: AtomicBool = AtomicBool::new(false);
static EXITING: AtomicBool = AtomicBool::new(false);

fn log(message: &str) {
    let Some(path) = LOG.get() else { return };
    let now = SystemTime::now().duration_since(UNIX_EPOCH).map_or(0, |d| d.as_secs());
    if let Ok(mut file) = fs::OpenOptions::new().create(true).append(true).open(path) {
        let _ = writeln!(file, "{now} {message}");
    }
}

fn source() -> Box<dyn UpdateSource> {
    // Test hook: only an existing local folder replaces the GitHub feed (never set it with setx).
    match std::env::var_os("CRATEMIND_UPDATE_TEST_DIR").map(PathBuf::from) {
        Some(dir) if dir.is_absolute() && dir.is_dir() => {
            log(&format!("test feed {}", dir.display()));
            Box::new(FileSource::new(dir))
        }
        _ => Box::new(GithubSource::new(FEED, None, false)),
    }
}

fn busy<T>(step: impl FnOnce() -> T) -> Option<T> {
    BUSY.store(true, SeqCst);
    if EXITING.load(SeqCst) {
        BUSY.store(false, SeqCst);
        return None;
    }
    let result = step();
    BUSY.store(false, SeqCst);
    Some(result)
}

/// The newest downloaded full package that is newer than the installed version.
fn pending() -> Option<(VelopackLocator, PathBuf)> {
    let locator = locator::auto_locate_app_manifest(LocationContext::FromCurrentExe).ok()?;
    let (package, manifest) = locator::find_latest_full_package(&locator.get_packages_dir())?;
    (manifest.version > locator.get_manifest_version()).then_some((locator, package))
}

/// Velopack overwrites Update.exe in place after a download, so a process exit mid-write leaves it
/// broken. The package was checksum-verified before its rename, so its copy is intact: extract it
/// to a sibling temp file, check it, and rename it over Update.exe (atomic on one volume).
fn repair_updater(locator: &VelopackLocator, package: &Path) -> bool {
    let target = locator.get_update_path();
    let temp = target.with_extension("exe.repair");
    let result = (|| -> Result<(), String> {
        let bundle = bundle::load_bundle_from_file(package).map_err(|e| e.to_string())?;
        bundle
            .extract_zip_predicate_to_path(|name| name.ends_with("Squirrel.exe"), &temp)
            .map_err(|e| e.to_string())?;
        let mut header = [0u8; 2];
        fs::File::open(&temp)
            .and_then(|mut file| file.read_exact(&mut header))
            .map_err(|e| e.to_string())?;
        if &header != b"MZ" {
            return Err("extracted file is not an executable".into());
        }
        fs::rename(&temp, &target).map_err(|e| e.to_string())
    })();
    match result {
        Ok(()) => {
            log("repaired Update.exe");
            true
        }
        Err(error) => {
            let _ = fs::remove_file(&temp);
            log(&format!("updater repair failed: {error}"));
            false
        }
    }
}

/// Starts the background check. Does nothing outside a Velopack install (dev runs, CI).
pub fn spawn_check(data: &Path) {
    if locator::auto_locate_app_manifest(LocationContext::FromCurrentExe).is_err() {
        return;
    }
    let logs = data.join("logs");
    let _ = fs::create_dir_all(&logs);
    let path = logs.join("updates.log");
    // Two small files: this launch, and the previous one (which holds its exit/apply outcome).
    let _ = fs::rename(&path, logs.join("updates.prev.log"));
    let _ = LOG.set(path);
    std::thread::spawn(|| {
        if let Some((locator, package)) = pending() {
            busy(|| repair_updater(&locator, &package));
        }
        std::thread::sleep(CHECK_DELAY);
        let manager = match UpdateManager::new_boxed(source(), None, None) {
            Ok(manager) => manager,
            Err(error) => return log(&format!("check failed: {error}")),
        };
        match manager.check_for_updates() {
            Ok(UpdateCheck::UpdateAvailable(info)) => {
                let version = info.TargetFullRelease.Version.clone();
                log(&format!("downloading {version}"));
                match busy(|| manager.download_updates(&info, None)) {
                    Some(Ok(())) => log(&format!("downloaded {version}; installs when CrateMind closes")),
                    Some(Err(error)) => log(&format!("download failed: {error}")),
                    None => log("download skipped: CrateMind is closing"),
                }
            }
            Ok(UpdateCheck::NoUpdateAvailable) => log("up to date"),
            Ok(UpdateCheck::RemoteIsEmpty) => log("no update feed published yet"),
            Err(error) => log(&format!("check failed: {error}")),
        }
    });
}

/// Called from `RunEvent::Exit`, after the backend has stopped: hands a downloaded update to
/// Update.exe, which waits for this process to exit and then installs it (no restart).
pub fn on_exit() {
    EXITING.store(true, SeqCst);
    if BUSY.load(SeqCst) {
        return log("update deferred: a download or repair is still running");
    }
    let Some((locator, package)) = pending() else { return };
    // Velopack launches Update.exe without checking it, so a failed repair must block the apply.
    if !repair_updater(&locator, &package) {
        return log("update deferred: updater repair failed");
    }
    let applied = UpdateManager::new_boxed(Box::new(NoneSource {}), None, None).and_then(|manager| {
        let Some(asset) = manager.get_update_pending_restart() else { return Ok(None) };
        manager.wait_exit_then_apply_updates(&asset, false, false, Vec::<String>::new())?;
        Ok(Some(asset.Version))
    });
    match applied {
        Ok(Some(version)) => log(&format!("applying {version} on exit")),
        Ok(None) => {}
        Err(error) => log(&format!("apply failed: {error}")),
    }
}

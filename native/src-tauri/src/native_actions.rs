use crate::protocol::valid_id;
use serde_json::{json, Value};
use std::{
    collections::HashMap,
    path::{Path, PathBuf},
    time::{SystemTime, UNIX_EPOCH},
};
#[derive(Clone)]
pub struct Prepared {
    pub digest: String,
    pub decision: String,
    pub expires_at_unix: u64,
    pub local_digest: Option<String>,
}
#[derive(Default)]
pub struct NativeActions {
    pub prepared: HashMap<String, Prepared>,
}
fn digest(value: &str) -> bool {
    value.len() == 64 && value.bytes().all(|b| b.is_ascii_hexdigit())
}
fn now() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs()
}
impl NativeActions {
    pub fn register(&mut self, id: String, value: Prepared) -> Result<(), String> {
        self.prepared.retain(|_, p| p.expires_at_unix > now());
        if !valid_id(&id)
            || !digest(&value.digest)
            || !["import", "replace"].contains(&value.decision.as_str())
            || value.expires_at_unix <= now()
            || value.expires_at_unix > now() + 900
            || value.local_digest.as_deref().is_some_and(|d| !digest(d))
            || self.prepared.len() >= 16
        {
            return Err("Μη έγκυρη προεπισκόπηση εισαγωγής".into());
        }
        if value.decision.starts_with("replace") && value.local_digest.is_none() {
            return Err("Λείπει επιβεβαίωση τοπικής έκδοσης".into());
        }
        self.prepared.insert(id, value);
        Ok(())
    }
    pub fn take_prepared(&mut self, arguments: &Value) -> Result<(String, Prepared), String> {
        strict_keys(arguments, &["preview_id", "decision", "local_digest"])?;
        let id = field(arguments, "preview_id")?;
        let value = self
            .prepared
            .remove(id)
            .ok_or("Άγνωστη ή ήδη χρησιμοποιημένη προεπισκόπηση")?;
        if value.expires_at_unix <= now()
            || field(arguments, "decision")? != value.decision
            || (value.decision == "replace"
                && arguments.get("local_digest").and_then(Value::as_str)
                    != value.local_digest.as_deref())
        {
            return Err("Η επιβεβαίωση εισαγωγής έχει λήξει ή αλλάξει".into());
        }
        Ok((id.into(), value))
    }
}
pub fn strict_keys(value: &Value, keys: &[&str]) -> Result<(), String> {
    if value
        .as_object()
        .is_none_or(|map| map.keys().any(|key| !keys.contains(&key.as_str())))
    {
        Err("Μη έγκυρες παράμετροι ενέργειας".into())
    } else {
        Ok(())
    }
}
pub fn field<'a>(value: &'a Value, name: &str) -> Result<&'a str, String> {
    value
        .get(name)
        .and_then(Value::as_str)
        .filter(|s| !s.is_empty() && s.len() <= 8192)
        .ok_or_else(|| format!("Μη έγκυρο πεδίο {name}"))
}
pub fn external_url(raw: &str) -> Result<url::Url, String> {
    let url = url::Url::parse(raw).map_err(|_| "Μη έγκυρος σύνδεσμος")?;
    if !["http", "https"].contains(&url.scheme())
        || url.host_str().is_none()
        || !url.username().is_empty()
        || url.password().is_some()
    {
        return Err("Επιτρέπονται μόνο σύνδεσμοι http/https".into());
    }
    Ok(url)
}
pub fn open_external(raw: &str) -> Result<(), String> {
    let url = external_url(raw)?;
    #[cfg(target_os = "macos")]
    let mut command = std::process::Command::new("/usr/bin/open");
    #[cfg(target_os = "linux")]
    let mut command = std::process::Command::new("xdg-open");
    #[cfg(windows)]
    let mut command = {
        let mut c = std::process::Command::new("rundll32.exe");
        c.arg("url.dll,FileProtocolHandler");
        c
    };
    command
        .arg(url.as_str())
        .spawn()
        .map_err(|e| e.to_string())
        .map(|_| ())
}
/// `canonicalize` on Windows returns a `\\?\` verbatim path, which Explorer does not open (it falls back
/// to its default folder without an error).
#[cfg(any(windows, test))]
fn without_verbatim(path: &str) -> String {
    match path.strip_prefix(r"\\?\UNC\") {
        Some(share) => format!(r"\\{share}"),
        None => path.strip_prefix(r"\\?\").unwrap_or(path).to_string(),
    }
}
pub fn dialog_action(action: &str, arguments: &Value) -> Result<(bool, Value), String> {
    match action {
        "pick_library_roots" | "pick_export_dir" => {
            strict_keys(arguments, &[])?;
            let dialog = rfd::FileDialog::new().set_title(if action == "pick_library_roots" {
                "Φάκελοι μουσικής"
            } else {
                "Φάκελος εξαγωγής"
            });
            if action == "pick_library_roots" {
                let paths = dialog.pick_folders();
                Ok((paths.is_none(), json!(paths)))
            } else {
                let path = dialog.pick_folder();
                Ok((path.is_none(), json!(path)))
            }
        }
        "reveal_path" => {
            strict_keys(arguments, &["path"])?;
            let path = Path::new(field(arguments, "path")?);
            if !path.is_absolute() || !path.exists() {
                return Err("Ο τοπικός φάκελος ή το αρχείο δεν υπάρχει".into());
            }
            let path = path.canonicalize().map_err(|e| e.to_string())?;
            #[cfg(target_os = "macos")]
            let result = std::process::Command::new("/usr/bin/open")
                .arg("-R")
                .arg(path)
                .spawn();
            #[cfg(target_os = "linux")]
            let result = std::process::Command::new("xdg-open")
                .arg(if path.is_dir() {
                    path.clone()
                } else {
                    path.parent().unwrap().into()
                })
                .spawn();
            #[cfg(windows)]
            let result = {
                use std::os::windows::process::CommandExt;
                // Explorer's own parser: `/select,"path"` selects the item (Windows paths cannot hold `"`).
                std::process::Command::new("explorer.exe")
                    .raw_arg(format!("/select,\"{}\"", without_verbatim(&path.to_string_lossy())))
                    .spawn()
            };
            result.map_err(|e| e.to_string())?;
            Ok((false, Value::Null))
        }
        "open_external" => {
            strict_keys(arguments, &["url"])?;
            open_external(field(arguments, "url")?)?;
            Ok((false, Value::Null))
        }
        _ => Err("Μη επιτρεπόμενη εγγενής ενέργεια".into()),
    }
}
/// The experimental VST3 host's actions; none of them focuses the main window.
pub const MASTER_HOST_ACTIONS: [&str; 5] = [
    "master_host_scan",
    "master_host_start",
    "master_host_stop",
    "master_host_editor",
    "master_host_bypass",
];
/// One of the host's three plugin slots.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum HostSlot {
    DeckA,
    DeckB,
    Master,
}
impl HostSlot {
    /// In load order: Deck A, Deck B, Master.
    pub const ALL: [HostSlot; 3] = [HostSlot::DeckA, HostSlot::DeckB, HostSlot::Master];
    /// The slot's key in the action arguments, the start reply and the stats.
    pub fn key(self) -> &'static str {
        match self {
            HostSlot::DeckA => "deck_a",
            HostSlot::DeckB => "deck_b",
            HostSlot::Master => "master",
        }
    }
    pub fn parse(key: &str) -> Option<HostSlot> {
        HostSlot::ALL.into_iter().find(|slot| slot.key() == key)
    }
    pub fn index(self) -> usize {
        self as usize
    }
    pub fn is_deck(self) -> bool {
        self != HostSlot::Master
    }
}
/// The longest plugin path accepted, in characters; master_host re-validates the path itself.
pub const MAX_PLUGIN_PATH: usize = 4096;
#[derive(Debug, PartialEq)]
pub enum MasterHostRequest {
    Scan,
    /// One optional plugin per slot, indexed by `HostSlot::index`; at least one is set.
    Start { slots: [Option<PathBuf>; 3], sample_rate: u32 },
    Stop,
    Editor { slot: HostSlot },
    Bypass { slot: HostSlot, bypassed: bool },
}
fn slot_argument(arguments: &Value) -> Result<HostSlot, String> {
    arguments
        .get("slot")
        .and_then(Value::as_str)
        .and_then(HostSlot::parse)
        .ok_or_else(|| "Μη έγκυρο slot".into())
}
/// `{deck_a, deck_b, master}`, each a plugin path or null, at least one a path.
fn slot_paths(value: Option<&Value>) -> Result<[Option<PathBuf>; 3], String> {
    let invalid = || "Μη έγκυρα plugins".to_string();
    let slots = value.ok_or_else(invalid)?;
    strict_keys(slots, &HostSlot::ALL.map(HostSlot::key)).map_err(|_| invalid())?;
    let mut paths: [Option<PathBuf>; 3] = Default::default();
    for slot in HostSlot::ALL {
        paths[slot.index()] = match slots.get(slot.key()).ok_or_else(invalid)? {
            Value::Null => None,
            Value::String(path) if !path.is_empty() && path.chars().count() <= MAX_PLUGIN_PATH => Some(PathBuf::from(path)),
            _ => return Err(invalid()),
        };
    }
    if paths.iter().all(Option::is_none) {
        return Err("Διάλεξε τουλάχιστον ένα plugin.".into());
    }
    Ok(paths)
}
/// Checks a host action's arguments; each plugin path itself is validated by master_host.
pub fn master_host_request(action: &str, arguments: &Value) -> Result<MasterHostRequest, String> {
    match action {
        "master_host_start" => {
            strict_keys(arguments, &["sample_rate", "slots"])?;
            let sample_rate = arguments
                .get("sample_rate")
                .and_then(Value::as_u64)
                .filter(|rate| (8_000..=384_000).contains(rate))
                .ok_or("Μη έγκυρος ρυθμός δειγματοληψίας")?;
            Ok(MasterHostRequest::Start {
                slots: slot_paths(arguments.get("slots"))?,
                sample_rate: sample_rate as u32,
            })
        }
        "master_host_editor" => {
            strict_keys(arguments, &["slot"])?;
            Ok(MasterHostRequest::Editor { slot: slot_argument(arguments)? })
        }
        "master_host_bypass" => {
            strict_keys(arguments, &["slot", "bypassed"])?;
            let bypassed = arguments
                .get("bypassed")
                .and_then(Value::as_bool)
                .ok_or("Μη έγκυρη τιμή bypass")?;
            Ok(MasterHostRequest::Bypass { slot: slot_argument(arguments)?, bypassed })
        }
        _ => {
            strict_keys(arguments, &[])?;
            match action {
                "master_host_scan" => Ok(MasterHostRequest::Scan),
                "master_host_stop" => Ok(MasterHostRequest::Stop),
                _ => Err("Μη επιτρεπόμενη εγγενής ενέργεια".into()),
            }
        }
    }
}
/// The bound loopback listener and the main-thread dispatcher the host runs on, and the folder that
/// keeps each slot's plugin state between sessions.
#[cfg(target_os = "macos")]
pub struct MasterHost {
    pub listener: std::sync::Arc<std::net::TcpListener>,
    pub main: crate::master_host::MainThread,
    pub state_dir: PathBuf,
}
/// Runs a host action and passes its result to `reply`. Start, stop, the editor and bypass wait for
/// the main thread (a plugin load can take seconds), so they answer from their own thread.
#[cfg(target_os = "macos")]
pub fn master_host_action(
    host: Option<&MasterHost>,
    action: &str,
    arguments: &Value,
    origin: &str,
    reply: impl FnOnce(Result<Value, String>) + Send + 'static,
) {
    use crate::master_host;
    let request = match master_host_request(action, arguments) {
        Ok(request) => request,
        Err(error) => return reply(Err(error)),
    };
    let Some(host) = host else {
        return reply(Err("Τα plugins VST3 δεν είναι διαθέσιμα.".into()));
    };
    let main = host.main.clone();
    match request {
        MasterHostRequest::Scan => reply(Ok(json!(master_host::scan()))),
        MasterHostRequest::Start { slots, sample_rate } => {
            let mut paths: [Option<PathBuf>; 3] = Default::default();
            for (valid, path) in paths.iter_mut().zip(&slots) {
                if let Some(path) = path {
                    match master_host::validate_path(path) {
                        Ok(path) => *valid = Some(path),
                        Err(error) => return reply(Err(error)),
                    }
                }
            }
            let (listener, origin, state_dir) = (host.listener.clone(), origin.to_owned(), host.state_dir.clone());
            std::thread::spawn(move || {
                reply(master_host::start(&paths, sample_rate, &origin, &listener, &main, Some(&state_dir)).map(|started| json!(started)))
            });
        }
        MasterHostRequest::Stop => {
            std::thread::spawn(move || reply(master_host::stop(&main).map(|_| Value::Null)));
        }
        MasterHostRequest::Editor { slot } => {
            std::thread::spawn(move || reply(master_host::open_editor(&main, slot).map(|_| Value::Null)));
        }
        MasterHostRequest::Bypass { slot, bypassed } => {
            std::thread::spawn(move || reply(master_host::set_bypass(&main, slot, bypassed).map(|_| Value::Null)));
        }
    }
}
/// A NATIVE_RESULT record for request `id`.
pub fn result_record(id: &str, result: Result<(bool, Value), String>) -> Value {
    match result {
        Ok((canceled, value)) => json!({"type":"NATIVE_RESULT","protocol_version":1,"id":id,"canceled":canceled,"value":value}),
        Err(error) => json!({"type":"NATIVE_RESULT","protocol_version":1,"id":id,"canceled":false,"error":error}),
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn rejects_command_urls_and_extra_arguments() {
        for value in [
            "file:///etc/passwd",
            "javascript:alert(1)",
            "https://user:secret@example.com",
        ] {
            assert!(external_url(value).is_err());
        }
        assert!(external_url("https://example.com/a").is_ok());
        assert!(dialog_action("pick_export_dir", &json!({"command":"sh"})).is_err());
    }
    #[test]
    fn explorer_gets_plain_windows_paths() {
        assert_eq!(without_verbatim(r"\\?\D:\Music\a b.mp3"), r"D:\Music\a b.mp3");
        assert_eq!(without_verbatim(r"\\?\UNC\nas\music\a.mp3"), r"\\nas\music\a.mp3");
        assert_eq!(without_verbatim(r"D:\Music\a.mp3"), r"D:\Music\a.mp3");
    }
    #[test]
    fn host_slots_parse_only_their_own_keys() {
        for slot in HostSlot::ALL {
            assert_eq!(HostSlot::parse(slot.key()), Some(slot));
            assert_eq!(HostSlot::ALL[slot.index()], slot);
        }
        assert!(HostSlot::DeckA.is_deck() && HostSlot::DeckB.is_deck() && !HostSlot::Master.is_deck());
        for bad in ["", "A", "deck_A", "Deck A", "deck_c", "master "] {
            assert_eq!(HostSlot::parse(bad), None, "{bad}");
        }
    }
    #[test]
    fn master_host_actions_take_only_their_own_arguments() {
        let a = "/Library/Audio/Plug-Ins/VST3/A.vst3";
        assert_eq!(
            master_host_request("master_host_start", &json!({"sample_rate":48000,"slots":{"deck_a":a,"deck_b":null,"master":null}})),
            Ok(MasterHostRequest::Start { slots: [Some(a.into()), None, None], sample_rate: 48_000 })
        );
        assert_eq!(
            master_host_request("master_host_start", &json!({"sample_rate":44100,"slots":{"deck_a":null,"deck_b":a,"master":a}})),
            Ok(MasterHostRequest::Start { slots: [None, Some(a.into()), Some(a.into())], sample_rate: 44_100 })
        );
        let longest = format!("/{}.vst3", "ä".repeat(MAX_PLUGIN_PATH - 6));
        assert!(master_host_request("master_host_start", &json!({"sample_rate":48000,"slots":{"deck_a":longest,"deck_b":null,"master":null}})).is_ok());
        let slots = |deck_a: Value| json!({"deck_a":deck_a,"deck_b":null,"master":null});
        for bad in [
            json!({"slots":slots(json!(a))}),
            json!({"sample_rate":"48000","slots":slots(json!(a))}),
            json!({"sample_rate":true,"slots":slots(json!(a))}),
            json!({"sample_rate":48000.5,"slots":slots(json!(a))}),
            json!({"sample_rate":1000,"slots":slots(json!(a))}),
            json!({"sample_rate":48000}),
            json!({"sample_rate":48000,"slots":[a, null, null]}),
            json!({"sample_rate":48000,"slots":a}),
            json!({"sample_rate":48000,"slots":slots(json!(null))}),
            json!({"sample_rate":48000,"slots":slots(json!(""))}),
            json!({"sample_rate":48000,"slots":slots(json!(1))}),
            json!({"sample_rate":48000,"slots":slots(json!({"path":a}))}),
            json!({"sample_rate":48000,"slots":slots(json!(format!("/{}.vst3", "x".repeat(MAX_PLUGIN_PATH))))}),
            json!({"sample_rate":48000,"slots":{"deck_a":a,"deck_b":null}}),
            json!({"sample_rate":48000,"slots":{"deck_a":a,"deck_b":null,"master":null,"deck_c":null}}),
            json!({"sample_rate":48000,"slots":{"A":a,"deck_b":null,"master":null}}),
            json!({"path":a,"sample_rate":48000}),
            json!({"sample_rate":48000,"slots":slots(json!(a)),"command":"sh"}),
        ] {
            assert!(master_host_request("master_host_start", &bad).is_err(), "{bad}");
        }
        assert_eq!(master_host_request("master_host_scan", &json!({})), Ok(MasterHostRequest::Scan));
        assert_eq!(master_host_request("master_host_stop", &json!({})), Ok(MasterHostRequest::Stop));
        for slot in HostSlot::ALL {
            assert_eq!(master_host_request("master_host_editor", &json!({"slot":slot.key()})), Ok(MasterHostRequest::Editor { slot }));
            assert_eq!(
                master_host_request("master_host_bypass", &json!({"slot":slot.key(),"bypassed":true})),
                Ok(MasterHostRequest::Bypass { slot, bypassed: true })
            );
        }
        assert_eq!(
            master_host_request("master_host_bypass", &json!({"slot":"master","bypassed":false})),
            Ok(MasterHostRequest::Bypass { slot: HostSlot::Master, bypassed: false })
        );
        for (action, bad) in [
            ("master_host_editor", json!({})),
            ("master_host_editor", json!({"slot":"A"})),
            ("master_host_editor", json!({"slot":null})),
            ("master_host_editor", json!({"slot":"deck_a","path":"/"})),
            ("master_host_bypass", json!({"slot":"deck_a"})),
            ("master_host_bypass", json!({"bypassed":true})),
            ("master_host_bypass", json!({"slot":"deck_a","bypassed":1})),
            ("master_host_bypass", json!({"slot":"deck_a","bypassed":"true"})),
            ("master_host_bypass", json!({"slot":"x","bypassed":true})),
            ("master_host_bypass", json!({"slot":"deck_a","bypassed":true,"extra":1})),
            ("master_host_scan", json!({"path":"/"})),
            ("master_host_stop", json!({"slot":"deck_a"})),
            ("master_host_stats", json!({})),
            ("master_host_load", json!({"slot":"deck_a","path":a})),
            ("master_host_empty", json!({"slot":"deck_a"})),
        ] {
            assert!(master_host_request(action, &bad).is_err(), "{action} {bad}");
        }
        // Every action lib.rs routes here is accepted with its own arguments.
        let valid = [
            json!({}),
            json!({"sample_rate":48000,"slots":slots(json!(a))}),
            json!({}),
            json!({"slot":"deck_b"}),
            json!({"slot":"deck_b","bypassed":false}),
        ];
        for (action, arguments) in MASTER_HOST_ACTIONS.iter().zip(valid) {
            assert!(master_host_request(action, &arguments).is_ok(), "{action}");
        }
    }
    #[test]
    fn unknown_exchange_never_reaches_helper() {
        assert!(NativeActions::default()
            .take_prepared(&json!({"preview_id":"x", "decision":"apply"}))
            .is_err());
    }
    #[test]
    fn exchange_requires_registered_immutable_decision_and_confirmation() {
        let mut actions = NativeActions::default();
        let prepared = Prepared {
            digest: "a".repeat(64),
            decision: "replace".into(),
            expires_at_unix: now() + 60,
            local_digest: Some("b".repeat(64)),
        };
        actions
            .register("preview".into(), prepared.clone())
            .unwrap();
        assert!(actions
            .take_prepared(
                &json!({"preview_id":"preview","decision":"replace","local_digest":"c".repeat(64)})
            )
            .is_err());
        actions.register("preview".into(), prepared).unwrap();
        assert!(actions.take_prepared(&json!({"preview_id":"preview","decision":"replace","local_digest":"b".repeat(64),"path":"/tmp/injected"})).is_err());
        assert!(actions
            .take_prepared(
                &json!({"preview_id":"preview","decision":"replace","local_digest":"b".repeat(64)})
            )
            .is_ok());
        assert!(actions
            .take_prepared(
                &json!({"preview_id":"preview","decision":"replace","local_digest":"b".repeat(64)})
            )
            .is_err());
    }
    #[test]
    fn expired_and_unconfirmed_replacements_are_rejected() {
        let mut actions = NativeActions::default();
        let mut prepared = Prepared {
            digest: "a".repeat(64),
            decision: "import".into(),
            expires_at_unix: now() - 1,
            local_digest: None,
        };
        assert!(actions
            .register("preview".into(), prepared.clone())
            .is_err());
        prepared.expires_at_unix = now() + 60;
        prepared.decision = "replace".into();
        assert!(actions.register("preview".into(), prepared).is_err());
    }
    #[test]
    fn ordinary_import_does_not_require_replacement_confirmation() {
        let mut actions = NativeActions::default();
        actions
            .register(
                "preview".into(),
                Prepared {
                    digest: "a".repeat(64),
                    decision: "import".into(),
                    expires_at_unix: now() + 60,
                    local_digest: Some("b".repeat(64)),
                },
            )
            .unwrap();
        assert!(actions
            .take_prepared(&json!({"preview_id":"preview","decision":"import","local_digest":null}))
            .is_ok());
    }
}

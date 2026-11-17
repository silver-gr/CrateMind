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
            let result = std::process::Command::new("explorer.exe")
                .arg(path.parent().unwrap_or(&path))
                .spawn();
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
/// The experimental VST3 master host's actions; none of them focuses the main window.
pub const MASTER_HOST_ACTIONS: [&str; 4] = [
    "master_host_scan",
    "master_host_start",
    "master_host_stop",
    "master_host_editor",
];
#[derive(Debug, PartialEq)]
pub enum MasterHostRequest {
    Scan,
    Start { path: PathBuf, sample_rate: u32 },
    Stop,
    Editor,
}
/// Checks a master host action's arguments; the plugin path itself is validated by master_host.
pub fn master_host_request(action: &str, arguments: &Value) -> Result<MasterHostRequest, String> {
    if action == "master_host_start" {
        strict_keys(arguments, &["path", "sample_rate"])?;
        let sample_rate = arguments
            .get("sample_rate")
            .and_then(Value::as_u64)
            .filter(|rate| (8_000..=384_000).contains(rate))
            .ok_or("Μη έγκυρος ρυθμός δειγματοληψίας")?;
        return Ok(MasterHostRequest::Start {
            path: PathBuf::from(field(arguments, "path")?),
            sample_rate: sample_rate as u32,
        });
    }
    strict_keys(arguments, &[])?;
    match action {
        "master_host_scan" => Ok(MasterHostRequest::Scan),
        "master_host_stop" => Ok(MasterHostRequest::Stop),
        "master_host_editor" => Ok(MasterHostRequest::Editor),
        _ => Err("Μη επιτρεπόμενη εγγενής ενέργεια".into()),
    }
}
/// The bound loopback listener and the main-thread dispatcher the master host runs on, and the
/// folder that keeps each plugin's state between sessions.
#[cfg(target_os = "macos")]
pub struct MasterHost {
    pub listener: std::sync::Arc<std::net::TcpListener>,
    pub main: crate::master_host::MainThread,
    pub state_dir: PathBuf,
}
/// Runs a master host action and passes its result to `reply`. Start, stop and the editor wait for
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
        return reply(Err("Το plugin master δεν είναι διαθέσιμο.".into()));
    };
    let main = host.main.clone();
    match request {
        MasterHostRequest::Scan => reply(Ok(json!(master_host::scan()))),
        MasterHostRequest::Start { path, sample_rate } => {
            let path = match master_host::validate_path(&path) {
                Ok(path) => path,
                Err(error) => return reply(Err(error)),
            };
            let (listener, origin, state_dir) = (host.listener.clone(), origin.to_owned(), host.state_dir.clone());
            std::thread::spawn(move || {
                reply(master_host::start(&path, sample_rate, &origin, &listener, &main, Some(&state_dir)).map(|started| json!(started)))
            });
        }
        MasterHostRequest::Stop => {
            std::thread::spawn(move || reply(master_host::stop(&main).map(|_| Value::Null)));
        }
        MasterHostRequest::Editor => {
            std::thread::spawn(move || reply(master_host::open_editor(&main).map(|_| Value::Null)));
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
    fn master_host_actions_take_only_their_own_arguments() {
        assert_eq!(
            master_host_request("master_host_start", &json!({"path":"/Library/Audio/Plug-Ins/VST3/A.vst3","sample_rate":48000})),
            Ok(MasterHostRequest::Start { path: "/Library/Audio/Plug-Ins/VST3/A.vst3".into(), sample_rate: 48_000 })
        );
        for bad in [
            json!({"path":"/x.vst3"}),
            json!({"path":"/x.vst3","sample_rate":"48000"}),
            json!({"path":"/x.vst3","sample_rate":true}),
            json!({"path":"/x.vst3","sample_rate":48000.5}),
            json!({"path":"/x.vst3","sample_rate":1000}),
            json!({"path":"","sample_rate":48000}),
            json!({"path":"/x.vst3","sample_rate":48000,"command":"sh"}),
        ] {
            assert!(master_host_request("master_host_start", &bad).is_err(), "{bad}");
        }
        assert_eq!(master_host_request("master_host_scan", &json!({})), Ok(MasterHostRequest::Scan));
        assert_eq!(master_host_request("master_host_stop", &json!({})), Ok(MasterHostRequest::Stop));
        assert_eq!(master_host_request("master_host_editor", &json!({})), Ok(MasterHostRequest::Editor));
        assert!(master_host_request("master_host_scan", &json!({"path":"/"})).is_err());
        assert!(master_host_request("master_host_stats", &json!({})).is_err());
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

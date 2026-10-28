use crate::protocol::valid_id;
use serde_json::{json, Value};
use std::{
    collections::HashMap,
    path::Path,
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

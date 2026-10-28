use serde::{Deserialize, Serialize};
use std::{collections::HashMap, path::PathBuf};

pub const MAX_RECORD: usize = 128 * 1024;
pub const VERSION: u8 = 1;
#[derive(Clone, Serialize)]
pub struct DesktopInit {
    pub protocol_version: u8,
    pub launch_id: String,
    pub session_secret: String,
    pub paths: Paths,
    pub tools: HashMap<String, PathBuf>,
    pub runtime_profile: &'static str,
}
#[derive(Clone, Serialize)]
pub struct Paths {
    pub app_data: PathBuf,
    pub resources: PathBuf,
}
impl DesktopInit {
    pub fn cookie_name(&self) -> String {
        format!("cratemind_{}", self.launch_id)
    }
}
#[derive(Debug, Deserialize)]
#[serde(tag = "type")]
pub enum BackendEvent {
    BOUND {
        protocol_version: u8,
        launch_id: String,
        port: u16,
    },
    #[serde(rename = "NATIVE_REQUEST")]
    NativeRequest {
        protocol_version: u8,
        id: String,
        action: String,
        #[serde(default)]
        arguments: serde_json::Value,
    },
    #[serde(rename = "EXCHANGE_PREPARED")]
    ExchangePrepared {
        protocol_version: u8,
        preview_id: String,
        digest: String,
        decision: String,
        expires_at_unix: u64,
        local_digest: Option<String>,
    },
    #[serde(rename = "HELPER_RESULT")]
    HelperResult {
        protocol_version: u8,
        ok: bool,
        error: Option<String>,
    },
    #[serde(rename = "SHUTDOWN_COMPLETE")]
    ShutdownComplete { protocol_version: u8 },
}
pub fn parse_event(line: &[u8]) -> Result<BackendEvent, String> {
    if line.len() > MAX_RECORD {
        return Err("Υπερβολικά μεγάλο μήνυμα υπηρεσίας".into());
    }
    serde_json::from_slice(line).map_err(|_| "Μη έγκυρο μήνυμα υπηρεσίας".into())
}
pub fn valid_id(id: &str) -> bool {
    id.bytes().next().is_some_and(|b| b.is_ascii_alphanumeric())
        && id.len() <= 128
        && id
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b"_-".contains(&b))
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn rejects_unbounded_and_unknown_records() {
        assert!(parse_event(&vec![b' '; MAX_RECORD + 1]).is_err());
        assert!(parse_event(br#"{"type":"EXEC","command":"x"}"#).is_err());
    }
    #[test]
    fn ids_cannot_be_paths_or_arguments() {
        for id in ["../x", "--help", "a b", ""] {
            assert!(!valid_id(id));
        }
        assert!(valid_id("preview_123"));
    }
}

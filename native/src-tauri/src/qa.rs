//! Fixed acceptance probes. Explicit marked fixture mode only; never arbitrary scripts.
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{
    path::Path,
    sync::mpsc,
    time::{Duration, Instant},
};

#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct TrackFixture {
    id: u64,
    codec: String,
}
#[derive(Default, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct Fixtures {
    #[serde(default)]
    tracks: Vec<TrackFixture>,
}
fn evaluate(window: &tauri::WebviewWindow, script: &str) -> Result<Value, String> {
    let (sender, receiver) = mpsc::sync_channel(1);
    window
        .eval_with_callback(script, move |result| {
            let _ = sender.send(result);
        })
        .map_err(|e| e.to_string())?;
    let raw = receiver
        .recv_timeout(Duration::from_secs(10))
        .map_err(|_| "Native QA evaluation timed out")?;
    serde_json::from_str(&raw).map_err(|e| format!("Native QA invalid response: {e}"))
}
pub fn run(window: &tauri::WebviewWindow, root: &Path) -> Result<Value, String> {
    if !root.join(".cratemind-qa-fixture").is_file() {
        return Err("Native QA requires fixture marker".into());
    }
    let path = root.join("native-qa-fixtures.json");
    let fixtures: Fixtures = if path.is_file() {
        let bytes = std::fs::read(path).map_err(|e| e.to_string())?;
        if bytes.len() > 8192 {
            return Err("Native QA fixture input too large".into());
        }
        serde_json::from_slice(&bytes).map_err(|e| e.to_string())?
    } else {
        Fixtures::default()
    };
    if fixtures.tracks.len() > 16
        || fixtures.tracks.iter().any(|t| {
            t.id == 0
                || !["mp3", "flac", "wav", "m4a", "ogg", "opus", "aiff"].contains(&t.codec.as_str())
        })
    {
        return Err("Invalid native QA track fixtures".into());
    }
    let previous: Value = std::fs::read(root.join("native-qa-report.json"))
        .ok()
        .and_then(|b| serde_json::from_slice(&b).ok())
        .unwrap_or(Value::Null);
    let settings = json!({"tracks":fixtures.tracks,"previous_preference":previous.get("saved_preference").cloned().unwrap_or(Value::Null),"previous_origin":previous.get("origin").cloned().unwrap_or(Value::Null)});
    let script = include_str!("qa.js").replace("__NATIVE_QA_FIXTURES__", &settings.to_string());
    window.eval(script).map_err(|e| e.to_string())?;
    let deadline = Instant::now() + Duration::from_secs(120);
    loop {
        let value = evaluate(
            window,
            "JSON.stringify(window.__cratemindNativeQa || {pending:true})",
        )?;
        // eval result is a JSON string because the fixed expression explicitly serializes.
        let report = if let Some(raw) = value.as_str() {
            serde_json::from_str::<Value>(raw).map_err(|e| e.to_string())?
        } else {
            value
        };
        if report.get("pending").and_then(Value::as_bool) == Some(false) {
            std::fs::write(
                root.join("native-qa-report.json"),
                serde_json::to_vec_pretty(&report).unwrap(),
            )
            .map_err(|e| e.to_string())?;
            return Ok(report);
        }
        if Instant::now() > deadline {
            return Err("Native QA probes timed out".into());
        }
        std::thread::sleep(Duration::from_millis(100));
    }
}

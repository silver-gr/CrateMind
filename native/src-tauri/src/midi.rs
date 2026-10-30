use crate::security::AllowedOrigin;
use midir::{Ignore, MidiInput, MidiInputConnection, MidiOutput, MidiOutputConnection};
use std::{
    sync::{
        atomic::{AtomicBool, Ordering},
        mpsc, Arc,
    },
    time::Duration,
};

const BATCH_MAX: usize = 256;
type Active = (MidiInputConnection<mpsc::Sender<[u8; 3]>>, Option<MidiOutputConnection>, String);
// SysEx values from Mixxx's Numark Mixtrack Platinum FX script.
const SYSEX_EXIT_DEMO: [u8; 6] = [0xF0, 0x7E, 0x00, 0x06, 0x01, 0xF7]; // exit demo lightshow
const SYSEX_STATUS: [u8; 7] = [0xF0, 0x00, 0x20, 0x7F, 0x03, 0x01, 0xF7];
const SYSEX_SHUTDOWN: [u8; 6] = [0xF0, 0x00, 0x20, 0x7F, 0x02, 0xF7];

fn forwardable(msg: &[u8]) -> Option<[u8; 3]> {
    match *msg {
        [status @ 0x80..=0xBF, d1, d2] => Some([status, d1, d2]),
        _ => None,
    }
}

fn script(batch: &[[u8; 3]]) -> String {
    format!("window.dispatchEvent(new CustomEvent(\"cratemind:midi\",{{detail:{}}}))", serde_json::to_string(batch).unwrap())
}

fn status_script(connected: bool) -> String {
    format!("window.dispatchEvent(new CustomEvent(\"cratemind:midi-status\",{{detail:{{connected:{connected}}}}}))")
}

fn input() -> Result<MidiInput, midir::InitError> {
    let mut input = MidiInput::new("CrateMind")?;
    input.ignore(Ignore::All);
    Ok(input)
}

fn port_is_mixtrack(input: &MidiInput, port: &midir::MidiInputPort) -> bool {
    input.port_name(port).is_ok_and(|name| name.to_lowercase().contains("mixtrack"))
}

fn connect_output() -> Result<Option<MidiOutputConnection>, String> {
    let out = MidiOutput::new("CrateMind").map_err(|e| e.to_string())?;
    let Some(port) = out.ports().into_iter().find(|p| out.port_name(p).is_ok_and(|n| n.to_lowercase().contains("mixtrack"))) else { return Ok(None) };
    let mut conn = out.connect(&port, "cratemind-out").map_err(|e| e.to_string())?;
    conn.send(&SYSEX_EXIT_DEMO).map_err(|e| e.to_string())?;
    conn.send(&SYSEX_STATUS).map_err(|e| e.to_string())?;
    Ok(Some(conn))
}

fn shutdown(active: &mut Option<Active>) {
    if let Some((_, Some(out), _)) = active { let _ = out.send(&SYSEX_SHUTDOWN); std::thread::sleep(Duration::from_millis(20)); }
}

fn connect(tx: &mpsc::Sender<[u8; 3]>) -> Result<Option<Active>, String> {
    let probe = input().map_err(|e| e.to_string())?;
    let Some(port) = probe.ports().into_iter().find(|p| port_is_mixtrack(&probe, p)) else { return Ok(None) };
    let name = probe.port_name(&port).map_err(|e| e.to_string())?;
    let conn = probe
        .connect(&port, "cratemind-in", |_, msg, tx| { if let Some(m) = forwardable(msg) { let _ = tx.send(m); } }, tx.clone())
        .map_err(|e| e.to_string())?;
    // Output failure is non-fatal: the input keeps working.
    let out = connect_output().unwrap_or_else(|e| { eprintln!("CrateMind midi: output failed: {e}"); None });
    Ok(Some((conn, out, name)))
}

// The backend origin intentionally has no invoke handler/capabilities, so events go in via eval, not IPC.
pub fn spawn(window: tauri::WebviewWindow, stop: Arc<AtomicBool>, allowed: AllowedOrigin, loaded: Arc<AtomicBool>) -> std::thread::JoinHandle<()> {
    let (tx, rx) = mpsc::channel::<[u8; 3]>();
    let (status_window, status_allowed) = (window.clone(), allowed.clone());
    std::thread::spawn(move || {
        while let Ok(first) = rx.recv() {
            let mut batch = vec![first];
            while batch.len() < BATCH_MAX { match rx.try_recv() { Ok(m) => batch.push(m), Err(_) => break } }
            if allowed.lock().is_ok_and(|g| g.is_some()) { let _ = window.eval(script(&batch)); }
        }
    });
    std::thread::spawn(move || {
        let (window, allowed) = (status_window, status_allowed);
        let lister = match input() { Ok(i) => i, Err(e) => { eprintln!("CrateMind midi: unavailable: {e}"); return; } };
        let mut active: Option<Active> = None;
        let mut was_loaded = false;
        while !stop.load(Ordering::Acquire) {
            if let Some((_, _, name)) = &active {
                if !lister.ports().iter().any(|p| lister.port_name(p).is_ok_and(|n| &n == name)) {
                    eprintln!("CrateMind midi: disconnected {name}");
                    active = None;
                }
            }
            if active.is_none() {
                match connect(&tx) {
                    Ok(Some((conn, out, name))) => { eprintln!("CrateMind midi: connected {name}"); active = Some((conn, out, name)); }
                    Ok(None) => {}
                    Err(e) => eprintln!("CrateMind midi: connect failed: {e}"),
                }
            }
            if allowed.lock().is_ok_and(|g| g.is_some()) { let _ = window.eval(status_script(active.is_some())); }
            // The controller dumps its control positions on SYSEX_STATUS; the connect-time dump lands before the page loads, so ask again once it has.
            let is_loaded = loaded.load(Ordering::Acquire);
            if is_loaded && !was_loaded {
                if let Some((_, Some(out), _)) = &mut active {
                    if out.send(&SYSEX_STATUS).is_ok() { eprintln!("CrateMind midi: requested control positions"); }
                }
            }
            was_loaded = is_loaded;
            for _ in 0..20 { if stop.load(Ordering::Acquire) { shutdown(&mut active); return; } std::thread::sleep(Duration::from_millis(100)); }
        }
        shutdown(&mut active);
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn forwards_only_three_byte_channel_messages_up_to_cc() {
        assert_eq!(forwardable(&[0x90, 0, 127]), Some([0x90, 0, 127]));
        assert_eq!(forwardable(&[0x80, 1, 2]), Some([0x80, 1, 2]));
        assert_eq!(forwardable(&[0xB0, 6, 1]), Some([0xB0, 6, 1]));
        assert_eq!(forwardable(&[0xBF, 6, 1]), Some([0xBF, 6, 1]));
        assert_eq!(forwardable(&[0xC0, 1, 2]), None);
        assert_eq!(forwardable(&[0xE0, 1, 2]), None);
        assert_eq!(forwardable(&[0x7F, 1, 2]), None);
        assert_eq!(forwardable(&[0xF0, 1, 0xF7]), None);
        assert_eq!(forwardable(&[0xF8]), None);
        assert_eq!(forwardable(&[0x90, 1]), None);
        assert_eq!(forwardable(&[0x90, 1, 2, 3]), None);
        assert_eq!(forwardable(&[]), None);
    }

    #[test]
    fn status_script_carries_bool_only() {
        assert_eq!(status_script(true), "window.dispatchEvent(new CustomEvent(\"cratemind:midi-status\",{detail:{connected:true}}))");
        assert_eq!(status_script(false), "window.dispatchEvent(new CustomEvent(\"cratemind:midi-status\",{detail:{connected:false}}))");
    }

    #[test]
    fn script_is_numbers_only_event() {
        assert_eq!(
            script(&[[144, 0, 127], [176, 6, 1]]),
            "window.dispatchEvent(new CustomEvent(\"cratemind:midi\",{detail:[[144,0,127],[176,6,1]]}))"
        );
    }
}

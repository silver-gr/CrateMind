use crate::security::AllowedOrigin;
use midir::{Ignore, MidiInput, MidiInputConnection};
use std::{
    sync::{
        atomic::{AtomicBool, Ordering},
        mpsc, Arc,
    },
    time::Duration,
};

const BATCH_MAX: usize = 256;
type Active = (MidiInputConnection<mpsc::Sender<[u8; 3]>>, String);

fn forwardable(msg: &[u8]) -> Option<[u8; 3]> {
    match *msg {
        [status @ 0x80..=0xBF, d1, d2] => Some([status, d1, d2]),
        _ => None,
    }
}

fn script(batch: &[[u8; 3]]) -> String {
    format!("window.dispatchEvent(new CustomEvent(\"cratemind:midi\",{{detail:{}}}))", serde_json::to_string(batch).unwrap())
}

fn input() -> Result<MidiInput, midir::InitError> {
    let mut input = MidiInput::new("CrateMind")?;
    input.ignore(Ignore::All);
    Ok(input)
}

fn port_is_mixtrack(input: &MidiInput, port: &midir::MidiInputPort) -> bool {
    input.port_name(port).is_ok_and(|name| name.to_lowercase().contains("mixtrack"))
}

fn connect(tx: &mpsc::Sender<[u8; 3]>) -> Result<Option<Active>, String> {
    let probe = input().map_err(|e| e.to_string())?;
    let Some(port) = probe.ports().into_iter().find(|p| port_is_mixtrack(&probe, p)) else { return Ok(None) };
    let name = probe.port_name(&port).map_err(|e| e.to_string())?;
    let conn = probe
        .connect(&port, "cratemind-in", |_, msg, tx| { if let Some(m) = forwardable(msg) { let _ = tx.send(m); } }, tx.clone())
        .map_err(|e| e.to_string())?;
    Ok(Some((conn, name)))
}

// The backend origin intentionally has no invoke handler/capabilities, so events go in via eval, not IPC.
pub fn spawn(window: tauri::WebviewWindow, stop: Arc<AtomicBool>, allowed: AllowedOrigin) {
    let (tx, rx) = mpsc::channel::<[u8; 3]>();
    std::thread::spawn(move || {
        while let Ok(first) = rx.recv() {
            let mut batch = vec![first];
            while batch.len() < BATCH_MAX { match rx.try_recv() { Ok(m) => batch.push(m), Err(_) => break } }
            if allowed.lock().is_ok_and(|g| g.is_some()) { let _ = window.eval(script(&batch)); }
        }
    });
    std::thread::spawn(move || {
        let lister = match input() { Ok(i) => i, Err(e) => { eprintln!("CrateMind midi: unavailable: {e}"); return; } };
        let mut active: Option<Active> = None;
        while !stop.load(Ordering::Acquire) {
            if let Some((_, name)) = &active {
                if !lister.ports().iter().any(|p| lister.port_name(p).is_ok_and(|n| &n == name)) {
                    eprintln!("CrateMind midi: disconnected {name}");
                    active = None;
                }
            }
            if active.is_none() {
                match connect(&tx) {
                    Ok(Some((conn, name))) => { eprintln!("CrateMind midi: connected {name}"); active = Some((conn, name)); }
                    Ok(None) => {}
                    Err(e) => eprintln!("CrateMind midi: connect failed: {e}"),
                }
            }
            for _ in 0..20 { if stop.load(Ordering::Acquire) { return; } std::thread::sleep(Duration::from_millis(100)); }
        }
    });
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
    fn script_is_numbers_only_event() {
        assert_eq!(
            script(&[[144, 0, 127], [176, 6, 1]]),
            "window.dispatchEvent(new CustomEvent(\"cratemind:midi\",{detail:[[144,0,127],[176,6,1]]}))"
        );
    }
}

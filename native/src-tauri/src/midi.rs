use crate::security::AllowedOrigin;
use midir::{Ignore, MidiInput, MidiInputConnection, MidiOutput, MidiOutputConnection};
use serde::Deserialize;
use std::{
    collections::HashMap,
    sync::{
        atomic::{AtomicBool, AtomicU64, Ordering},
        mpsc, Arc,
    },
    time::{Duration, Instant},
};

const BATCH_MAX: usize = 256;
type Active = (MidiInputConnection<mpsc::Sender<[u8; 3]>>, Option<MidiOutputConnection>, String);
// SysEx values from Mixxx's Numark Mixtrack Platinum FX script.
const SYSEX_EXIT_DEMO: [u8; 6] = [0xF0, 0x7E, 0x00, 0x06, 0x01, 0xF7]; // exit demo lightshow
const SYSEX_STATUS: [u8; 7] = [0xF0, 0x00, 0x20, 0x7F, 0x03, 0x01, 0xF7];
const SYSEX_SHUTDOWN: [u8; 6] = [0xF0, 0x00, 0x20, 0x7F, 0x02, 0xF7];
const TICK: Duration = Duration::from_millis(50);
const STATUS_EVERY: u32 = 40; // ticks: port scan and status eval run every 2 s
const STALE: Duration = Duration::from_millis(500);
const RAW_MAX: usize = 8 * 1024; // raw eval result, rejected before queuing
const JSON_MAX: usize = 4 * 1024;
const LED_ON: u8 = 0x7F;
const LED_DIM: u8 = 0x01;
// Returns a primitive string and never throws; wry JSON-encodes it, so the callback receives a JSON string literal.
const SNAPSHOT_JS: &str = r#"(()=>{try{const f=window.__cratemindDecks;const s=typeof f==="function"?JSON.stringify(f()):"";return typeof s==="string"?s:""}catch(e){return ""}})()"#;

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

#[derive(Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct RawDeck { playing: bool, bpm: f64, position_ms: f64, duration_ms: f64, pads: [bool; 8], level: f64, bar_phase: f64, rate: f64, keylock: bool }
#[derive(Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct RawSnapshot { tag_route: bool, #[serde(rename = "A")] a: Option<RawDeck>, #[serde(rename = "B")] b: Option<RawDeck> }

#[derive(Clone, Default, Debug, PartialEq)]
struct Deck { playing: bool, bpm_x100: u32, pos_ms: u32, dur_ms: u32, pads: [bool; 8], level: f64, bar_phase: f64, pitch_x10000: i32, keylock: bool }
// Default = both decks unloaded.
#[derive(Default, Debug, PartialEq)]
struct Snapshot { tag_route: bool, decks: [Option<Deck>; 2] }

fn clamp_u32(v: f64, max: f64) -> u32 { v.clamp(0.0, max).round() as u32 }

// Mixxx sends rateRange·−rate; the live check confirms that a faster deck shows + on the screen.
const PITCH_SCREEN_SIGN: i32 = 1;

fn deck(raw: RawDeck) -> Deck {
    let rate = if raw.rate.is_finite() { raw.rate.clamp(0.5, 1.5) } else { 1.0 };
    Deck { playing: raw.playing, bpm_x100: clamp_u32(raw.bpm * rate * 100.0, 99_900.0), pitch_x10000: ((rate - 1.0) * 10_000.0).round() as i32 * PITCH_SCREEN_SIGN, keylock: raw.keylock, pos_ms: clamp_u32(raw.position_ms, 86_400_000.0), dur_ms: clamp_u32(raw.duration_ms, 86_400_000.0), pads: raw.pads, level: raw.level.clamp(0.0, 1.0), bar_phase: raw.bar_phase.clamp(-1.0, 1.0) }
}

// `raw` is what the eval callback received: a JSON string literal containing the snapshot JSON.
// None = malformed (skip); empty / null = unloaded.
fn parse_snapshot(raw: &str) -> Option<Snapshot> {
    if raw.len() > RAW_MAX { return None; }
    let inner = match serde_json::from_str::<String>(raw) { Ok(inner) => inner, Err(_) if raw.trim() == "null" => return Some(Snapshot::default()), Err(_) => return None };
    if inner.len() > JSON_MAX { return None; }
    if inner.trim().is_empty() || inner.trim() == "null" { return Some(Snapshot::default()); }
    let snap = serde_json::from_str::<RawSnapshot>(&inner).ok()?;
    Some(Snapshot { tag_route: snap.tag_route, decks: [snap.a.map(deck), snap.b.map(deck)] })
}

// Mixxx encodeNumToArray: eight nibbles, `drop` leading ones removed, then the sign nibble (08 for n >= 0).
fn raw_nibbles(n: u32) -> Vec<u8> { (0..8).rev().map(|i| ((n >> (i * 4)) & 0x0F) as u8).collect() }
fn nibbles(n: u32, drop: usize) -> Vec<u8> { let mut v = raw_nibbles(n).split_off(drop); v[0] = 0x08; v }
// Mixxx encodeNumToArray for negatives: two's-complement nibbles, sign nibble 07 for n < 0, 08 otherwise.
fn signed_nibbles(n: i32, drop: usize) -> Vec<u8> { let mut v = raw_nibbles(n as u32).split_off(drop); v[0] = if n < 0 { 0x07 } else { 0x08 }; v }
// BPM (Mixxx sendScreenBpmMidi): sign set first, then two nibbles shifted off, so the sign is gone.
fn bpm_nibbles(n: u32) -> Vec<u8> { raw_nibbles(n).split_off(2) }

fn sysex(no: u8, cmd: u8, data: Vec<u8>) -> Vec<u8> {
    let mut m = vec![0xF0, 0x00, 0x20, 0x7F, no, cmd];
    m.extend(data);
    m.push(0xF7);
    m
}

fn ring(pos_ms: u32, dur_ms: u32) -> u8 { if dur_ms == 0 { 0 } else { ((f64::from(pos_ms) / f64::from(dur_ms)).clamp(0.0, 1.0) * 52.0).round() as u8 } }
// Outer spinner ring (Mixxx: CC 0x06, 64..=115); 0 turns it off.
fn spinner(phase: f64) -> u8 { if phase < 0.0 { 0 } else { 64 + (phase * 52.0).floor().min(51.0) as u8 } }
fn vu(level: f64) -> u8 { (level.clamp(0.0, 1.0) * 90.0).round() as u8 }

// Every output message for one deck (ch 0/1); `None` is the unloaded state.
fn deck_messages(ch: u8, deck: Option<&Deck>, tag_route: bool) -> Vec<Vec<u8>> {
    let d = deck.cloned().unwrap_or_default();
    let led = |on: bool| if on { LED_ON } else { LED_DIM };
    let mut m = vec![
        vec![0x90 + ch, 0x00, led(d.playing)],
        vec![0x90 + ch, 0x01, LED_DIM],
        vec![0x90 + ch, 0x02, LED_DIM],
        vec![0x94 + ch, 0x00, led(deck.is_some())],
    ];
    let kl = if d.keylock { LED_ON } else { 0x00 };
    m.extend([vec![0x80 + ch, 0x0D, kl], vec![0x90 + ch, 0x0D, kl], vec![0x90 + ch, 0x0E, 8]]);
    m.extend([0x0D, 0x07, 0x0B, 0x0F, 0x02].map(|c| vec![0x94 + ch, c, LED_DIM]));
    m.extend((0..8u8).map(|i| vec![0x94 + ch, 0x14 + i, led(d.pads[i as usize] && !tag_route)]));
    let no = ch + 1;
    m.push(sysex(no, 0x01, bpm_nibbles(d.bpm_x100)));
    m.push(sysex(no, 0x02, signed_nibbles(d.pitch_x10000, 2)));
    m.push(sysex(no, 0x03, nibbles(d.dur_ms.max(1) - 1, 0)));
    m.push(sysex(no, 0x04, nibbles(d.pos_ms, 0)));
    m.push(vec![0xB0 + ch, 0x3F, ring(d.pos_ms, d.dur_ms)]);
    m.push(vec![0xB0 + ch, 0x1F, vu(d.level)]);
    m.push(vec![0xB0 + ch, 0x06, deck.map_or(0, |d| spinner(d.bar_phase))]);
    m
}

fn snapshot_messages(snap: &Snapshot) -> Vec<Vec<u8>> {
    (0..2u8).flat_map(|ch| deck_messages(ch, snap.decks[usize::from(ch)].as_ref(), snap.tag_route)).collect()
}

// Remembers the last message sent per control so only changes go out.
#[derive(Default)]
struct Feedback { sent: HashMap<Vec<u8>, Vec<u8>> }
impl Feedback {
    fn clear(&mut self) { self.sent.clear(); }
    fn changed(&mut self, msgs: Vec<Vec<u8>>) -> Vec<Vec<u8>> {
        msgs.into_iter().filter(|m| {
            let key = m[..if m[0] == 0xF0 { 6 } else { 2 }].to_vec();
            match self.sent.get(&key) {
                Some(prev) if prev == m => return false,
                // Small VU moves are skipped, but a drop to 0 always goes out so the meter never sticks.
                Some(prev) if m[0] & 0xF0 == 0xB0 && m[1] == 0x1F && m[2] != 0 && prev[2].abs_diff(m[2]) < 2 => return false,
                _ => {}
            }
            self.sent.insert(key, m.clone());
            true
        }).collect()
    }
}

// A failed send forgets the remembered state so the next diff resends everything.
fn send_all(active: &mut Option<Active>, fb: &mut Feedback, msgs: &[Vec<u8>]) {
    if let Some((_, Some(out), _)) = active {
        for m in msgs { if out.send(m).is_err() { fb.clear(); break; } }
    }
}

#[derive(Debug, PartialEq)]
struct Step { reset: bool, request: Option<u64> }
// Single in-flight snapshot request, tagged with a generation so late callbacks from an old generation are discarded.
#[derive(Default)]
struct Link { gen: u64, pending: Option<(u64, Instant)>, was_ready: bool }
impl Link {
    fn restart(&mut self) { self.gen += 1; self.pending = None; }
    fn step(&mut self, ready: bool, now: Instant) -> Step {
        let mut step = Step { reset: false, request: None };
        if !ready {
            if self.was_ready { self.was_ready = false; self.restart(); step.reset = true; }
            return step;
        }
        if !self.was_ready { self.was_ready = true; self.restart(); step.reset = true; }
        else if self.pending.is_some_and(|(_, t)| now.duration_since(t) > STALE) { self.restart(); step.reset = true; }
        if self.pending.is_none() { self.pending = Some((self.gen, now)); step.request = Some(self.gen); }
        step
    }
    fn accept(&mut self, gen: u64) -> bool {
        let ok = gen == self.gen && self.pending.is_some_and(|(g, _)| g == gen);
        if ok { self.pending = None; }
        ok
    }
}

// Lights-off state (the controller's own "waiting for a host" look): unloaded messages with every LED at 0x00.
fn off_messages() -> Vec<Vec<u8>> {
    snapshot_messages(&Snapshot::default()).into_iter().map(|mut m| { if matches!(m[0] & 0xF0, 0x90 | 0x94) { m[2] = 0x00; } m }).collect()
}

fn shutdown(active: &mut Option<Active>, fb: &mut Feedback) {
    // Last thing sent, so it bypasses the diff.
    send_all(active, fb, &off_messages());
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
            if allowed.lock().is_ok_and(|g| g.is_some()) {
                if batch.len() >= 16 { eprintln!("CrateMind midi: forwarded {} messages", batch.len()); }
                let _ = window.eval(script(&batch));
            } else {
                eprintln!("CrateMind midi: dropped {} messages (page not ready)", batch.len());
            }
        }
    });
    std::thread::spawn(move || {
        let (window, allowed) = (status_window, status_allowed);
        let lister = match input() { Ok(i) => i, Err(e) => { eprintln!("CrateMind midi: unavailable: {e}"); return; } };
        let mut active: Option<Active> = None;
        let mut was_loaded = false;
        let (cb_tx, cb_rx) = mpsc::sync_channel::<(u64, String)>(1);
        let cur_gen = Arc::new(AtomicU64::new(0));
        let (mut link, mut fb, mut tick) = (Link::default(), Feedback::default(), 0u32);
        while !stop.load(Ordering::Acquire) {
            if tick % STATUS_EVERY == 0 {
                if let Some((_, _, name)) = &active {
                    if !lister.ports().iter().any(|p| lister.port_name(p).is_ok_and(|n| &n == name)) {
                        eprintln!("CrateMind midi: disconnected {name}");
                        active = None;
                    }
                }
                if active.is_none() {
                    match connect(&tx) {
                        Ok(Some((conn, out, name))) => { eprintln!("CrateMind midi: connected {name}"); active = Some((conn, out, name)); fb.clear(); link.restart();
                            let msgs = fb.changed(snapshot_messages(&Snapshot::default())); send_all(&mut active, &mut fb, &msgs);
                        }
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
            }
            // Feedback: ready = output connected, authenticated origin set, page loaded (diagnostic() clears the origin but not `loaded`).
            let ready = matches!(&active, Some((_, Some(_), _))) && allowed.lock().is_ok_and(|g| g.is_some()) && loaded.load(Ordering::Acquire);
            let step = link.step(ready, Instant::now());
            if step.reset { let msgs = fb.changed(snapshot_messages(&Snapshot::default())); send_all(&mut active, &mut fb, &msgs); }
            cur_gen.store(link.gen, Ordering::Release);
            if let Some(gen) = step.request {
                let (cb_tx, cur_gen) = (cb_tx.clone(), cur_gen.clone());
                // A stale generation must not occupy the single slot and starve the current response.
                let _ = window.eval_with_callback(SNAPSHOT_JS, move |raw| { if gen == cur_gen.load(Ordering::Acquire) && raw.len() <= RAW_MAX { let _ = cb_tx.try_send((gen, raw)); } });
            }
            while let Ok((gen, raw)) = cb_rx.try_recv() {
                if !link.accept(gen) { continue; }
                if let Some(snap) = parse_snapshot(&raw) { let msgs = fb.changed(snapshot_messages(&snap)); send_all(&mut active, &mut fb, &msgs); }
            }
            tick = tick.wrapping_add(1);
            std::thread::sleep(TICK);
        }
        shutdown(&mut active, &mut fb);
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

    #[test]
    fn plan_table_messages_are_exact() {
        assert_eq!(sysex(1, 0x01, bpm_nibbles(12800)), [0xF0, 0, 0x20, 0x7F, 1, 1, 0, 0, 3, 2, 0, 0, 0xF7]);
        assert_eq!(sysex(1, 0x02, nibbles(0, 2)), [0xF0, 0, 0x20, 0x7F, 1, 2, 8, 0, 0, 0, 0, 0, 0xF7]);
        assert_eq!(sysex(1, 0x04, nibbles(330_000, 0)), [0xF0, 0, 0x20, 0x7F, 1, 4, 8, 0, 0, 5, 0, 9, 1, 0, 0xF7]);
        assert_eq!(sysex(1, 0x03, nibbles(1 - 1, 0)), [0xF0, 0, 0x20, 0x7F, 1, 3, 8, 0, 0, 0, 0, 0, 0, 0, 0xF7]);
    }

    fn loaded() -> Deck { Deck { playing: true, bpm_x100: 12800, pos_ms: 330_000, dur_ms: 660_000, pads: [true, false, false, false, false, false, false, true], level: 0.5, bar_phase: 0.5, pitch_x10000: 0, keylock: false } }

    #[test]
    fn deck_messages_cover_leds_screens_ring_and_vu() {
        let m = deck_messages(1, Some(&loaded()), false);
        for want in [
            vec![0x91, 0x00, 0x7F], vec![0x91, 0x01, 0x01], vec![0x91, 0x02, 0x01], // play, cue, sync
            vec![0x95, 0x00, 0x7F], vec![0x95, 0x0D, 0x01], vec![0x95, 0x07, 0x01], vec![0x95, 0x0B, 0x01], vec![0x95, 0x0F, 0x01], vec![0x95, 0x02, 0x01], // pad modes
            vec![0x95, 0x14, 0x7F], vec![0x95, 0x15, 0x01], vec![0x95, 0x1B, 0x7F],
            vec![0xB1, 0x3F, 26], vec![0xB1, 0x1F, 45], vec![0xB1, 0x06, 90],
            sysex(2, 0x01, vec![0, 0, 3, 2, 0, 0]),
            sysex(2, 0x04, vec![8, 0, 0, 5, 0, 9, 1, 0]),
        ] { assert!(m.contains(&want), "missing {want:02X?}"); }
        assert_eq!(m.len(), 4 + 3 + 5 + 8 + 4 + 3);
        assert!(m.contains(&sysex(2, 0x03, nibbles(659_999, 0))));
        assert_eq!(nibbles(659_999, 0), [8, 0, 0, 0xA, 0x1, 0x2, 0x1, 0xF]);
    }

    #[test]
    fn tag_route_dims_pads_and_unloaded_dims_everything() {
        let m = deck_messages(0, Some(&loaded()), true);
        assert!((0..8u8).all(|i| m.contains(&vec![0x94, 0x14 + i, 0x01])));
        let u = deck_messages(0, None, false);
        assert!(u.contains(&vec![0x90, 0x00, 0x01]) && u.contains(&vec![0x94, 0x00, 0x01]) && u.contains(&vec![0xB0, 0x1F, 0]) && u.contains(&vec![0xB0, 0x3F, 0]) && u.contains(&vec![0xB0, 0x06, 0]));
        assert!(u.contains(&sysex(1, 0x01, vec![0; 6])) && u.contains(&sysex(1, 0x04, vec![8, 0, 0, 0, 0, 0, 0, 0])));
    }

    #[test]
    fn off_messages_turn_every_led_off_and_zero_ring_vu_spinner() {
        let m = off_messages();
        assert_eq!(m.len(), snapshot_messages(&Snapshot::default()).len());
        let leds: Vec<_> = m.iter().filter(|m| matches!(m[0] & 0xF0, 0x90 | 0x94)).collect();
        assert_eq!(leds.len(), 2 * (3 + 2 + 1 + 5 + 8)); // + key-lock and range on 0x9n
        assert!(leds.iter().all(|m| m[2] == 0x00));
        assert!(m.contains(&vec![0x80, 0x0D, 0]) && m.contains(&vec![0x91, 0x0D, 0]) && m.contains(&vec![0x91, 0x0E, 0]));
        assert!(m.contains(&vec![0xB0, 0x3F, 0]) && m.contains(&vec![0xB1, 0x3F, 0]) && m.contains(&vec![0xB0, 0x1F, 0]) && m.contains(&vec![0xB1, 0x06, 0]));
        assert!(m.contains(&sysex(1, 0x01, vec![0; 6])) && m.contains(&sysex(2, 0x04, vec![8, 0, 0, 0, 0, 0, 0, 0])));
    }

    #[test]
    fn ring_and_vu_ranges() {
        assert_eq!(ring(5, 0), 0);
        assert_eq!(ring(0, 100), 0);
        assert_eq!(ring(50, 100), 26);
        assert_eq!(ring(200, 100), 52);
        assert_eq!(vu(0.0), 0);
        assert_eq!(vu(1.0), 90);
        assert_eq!(vu(7.0), 90);
    }

    #[test]
    fn spinner_range() {
        assert_eq!((spinner(0.0), spinner(0.5), spinner(0.999), spinner(-1.0)), (64, 90, 115, 0));
        assert_eq!(spinner(1.0), 115);
    }

    fn wrap(json: &str) -> String { serde_json::to_string(json).unwrap() }
    const DECK: &str = r#"{"playing":true,"bpm":128.004,"positionMs":1000.4,"durationMs":5000,"pads":[true,false,false,false,false,false,false,false],"level":0.25,"barPhase":0.5,"rate":1.08,"keylock":true}"#;

    #[test]
    fn parses_double_encoded_snapshot_and_clamps() {
        let snap = parse_snapshot(&wrap(&format!(r#"{{"tagRoute":true,"A":{DECK},"B":null}}"#))).unwrap();
        assert!(snap.tag_route && snap.decks[1].is_none());
        let a = snap.decks[0].clone().unwrap();
        assert_eq!((a.bpm_x100, a.pos_ms, a.dur_ms, a.level), (13824, 1000, 5000, 0.25));
        let wild = r#"{"tagRoute":false,"A":{"playing":false,"bpm":5000,"positionMs":-3,"durationMs":1e12,"pads":[false,false,false,false,false,false,false,false],"level":9,"barPhase":3,"rate":9,"keylock":false},"B":null}"#;
        let a = parse_snapshot(&wrap(wild)).unwrap().decks[0].clone().unwrap();
        assert_eq!((a.bpm_x100, a.pos_ms, a.dur_ms, a.level), (99_900, 0, 86_400_000, 1.0));
        assert_eq!(a.bar_phase, 1.0);
    }

    #[test]
    fn rate_drives_bpm_pitch_and_keylock() {
        let a = parse_snapshot(&wrap(&format!(r#"{{"tagRoute":false,"A":{DECK},"B":null}}"#))).unwrap().decks[0].clone().unwrap();
        assert_eq!((a.bpm_x100, a.pitch_x10000, a.keylock), (13824, 800, true)); // 128.004 * 1.08 = 138.24
        let rate = |r: &str| parse_snapshot(&wrap(&format!(r#"{{"tagRoute":false,"A":{},"B":null}}"#, DECK.replace("1.08", r)))).unwrap().decks[0].clone().unwrap();
        assert_eq!((rate("9").pitch_x10000, rate("0.1").pitch_x10000, rate("0.92").pitch_x10000), (5000, -5000, -800));
        assert_eq!(rate("0.92").bpm_x100, 11776);
        let raw = |rate: f64| deck(RawDeck { playing: false, bpm: 100.0, position_ms: 0.0, duration_ms: 0.0, pads: [false; 8], level: 0.0, bar_phase: 0.0, rate, keylock: false });
        assert_eq!((raw(f64::NAN).pitch_x10000, raw(f64::INFINITY).bpm_x100), (0, 10_000));
        assert_eq!(Deck::default().pitch_x10000, 0);
    }

    #[test]
    fn pitch_screen_bytes_are_exact() {
        let pitch = |p: i32| deck_messages(0, Some(&Deck { pitch_x10000: p, ..loaded() }), false).into_iter().find(|m| m[0] == 0xF0 && m[5] == 0x02).unwrap();
        assert_eq!(pitch(800), [0xF0, 0, 0x20, 0x7F, 1, 2, 0x08, 0, 0, 3, 2, 0, 0xF7]);
        assert_eq!(pitch(-800), [0xF0, 0, 0x20, 0x7F, 1, 2, 0x07, 0x0F, 0x0F, 0x0C, 0x0E, 0, 0xF7]);
        assert_eq!(pitch(0), [0xF0, 0, 0x20, 0x7F, 1, 2, 8, 0, 0, 0, 0, 0, 0xF7]);
        assert_eq!(deck_messages(1, None, false).into_iter().find(|m| m[0] == 0xF0 && m[5] == 0x02).unwrap(), sysex(2, 0x02, vec![8, 0, 0, 0, 0, 0]));
    }

    #[test]
    fn keylock_led_range_and_distinct_diff_keys() {
        let kl = |on: bool, ch: u8| deck_messages(ch, Some(&Deck { keylock: on, ..loaded() }), false);
        let (on, off) = (kl(true, 1), kl(false, 1));
        assert!(on.contains(&vec![0x81, 0x0D, 0x7F]) && on.contains(&vec![0x91, 0x0D, 0x7F]));
        assert!(off.contains(&vec![0x81, 0x0D, 0x00]) && off.contains(&vec![0x91, 0x0D, 0x00]));
        assert!(on.contains(&vec![0x91, 0x0E, 8]) && deck_messages(0, None, false).contains(&vec![0x90, 0x0E, 8]));
        assert!(deck_messages(0, None, false).contains(&vec![0x80, 0x0D, 0x00]));
        // Both statuses are separate diff entries: toggling key lock resends exactly both.
        let mut fb = Feedback::default();
        fb.changed(off);
        assert_eq!(fb.changed(on), vec![vec![0x81, 0x0D, 0x7F], vec![0x91, 0x0D, 0x7F]]);
    }

    #[test]
    fn empty_and_null_are_unloaded_and_garbage_is_skipped() {
        for raw in [r#""""#, r#""null""#, "null"] { assert_eq!(parse_snapshot(raw), Some(Snapshot::default()), "{raw}"); }
        let ok = format!(r#"{{"tagRoute":false,"A":{DECK},"B":null}}"#);
        assert!(parse_snapshot(&ok).is_none(), "raw JSON (single-encoded) rejected");
        assert!(parse_snapshot(&wrap(&format!(r#"{{"tagRoute":false,"A":{DECK},"B":null,"x":1}}"#))).is_none(), "unknown key");
        assert!(parse_snapshot(&wrap(&format!(r#"{{"tagRoute":false,"A":{},"B":null}}"#, DECK.replace(r#","rate":1.08"#, "")))).is_none(), "missing rate");
        assert!(parse_snapshot(&wrap(&format!(r#"{{"tagRoute":false,"A":{},"B":null}}"#, DECK.replace(r#","keylock":true"#, "")))).is_none(), "missing keylock");
        assert!(parse_snapshot(&wrap(&format!(r#"{{"tagRoute":false,"A":{},"B":null}}"#, DECK.replace(r#""keylock":true"#, r#""keylock":true,"extra":1"#)))).is_none(), "unknown deck key");
        assert!(parse_snapshot(&wrap(&format!(r#"{{"tagRoute":false,"A":{},"B":null}}"#, DECK.replace("128.004", "\"128\"")))).is_none(), "non-number");
        assert!(parse_snapshot(&wrap(&DECK.replace("true", "1"))).is_none());
        assert!(parse_snapshot(&wrap(&"x".repeat(JSON_MAX + 1))).is_none(), "inner cap");
        assert!(parse_snapshot(&" ".repeat(RAW_MAX + 1)).is_none(), "raw cap");
        assert!(parse_snapshot("not json").is_none());
    }

    #[test]
    fn diff_sends_only_changes_and_always_sends_vu_zero() {
        let mut fb = Feedback::default();
        let mut snap = Snapshot { tag_route: false, decks: [Some(loaded()), None] };
        assert_eq!(fb.changed(snapshot_messages(&snap)).len(), snapshot_messages(&snap).len());
        assert!(fb.changed(snapshot_messages(&snap)).is_empty());
        // VU 45 -> 46 skipped; 45 -> 47 sent; then drop to level 0 sent.
        snap.decks[0].as_mut().unwrap().level = 46.0 / 90.0;
        assert!(fb.changed(snapshot_messages(&snap)).is_empty());
        snap.decks[0].as_mut().unwrap().level = 47.0 / 90.0;
        assert_eq!(fb.changed(snapshot_messages(&snap)), vec![vec![0xB0, 0x1F, 47]]);
        snap.decks[0].as_mut().unwrap().level = 1.0 / 90.0;
        assert_eq!(fb.changed(snapshot_messages(&snap)), vec![vec![0xB0, 0x1F, 1]]);
        snap.decks[0].as_mut().unwrap().level = 0.0;
        assert_eq!(fb.changed(snapshot_messages(&snap)), vec![vec![0xB0, 0x1F, 0]]);
        snap.decks[0].as_mut().unwrap().playing = false;
        assert_eq!(fb.changed(snapshot_messages(&snap)), vec![vec![0x90, 0x00, 0x01]]);
        fb.clear();
        assert_eq!(fb.changed(snapshot_messages(&snap)).len(), snapshot_messages(&snap).len());
    }

    #[test]
    fn late_callbacks_from_old_generations_are_discarded() {
        let (mut link, t0) = (Link::default(), Instant::now());
        assert_eq!(link.step(false, t0), Step { reset: false, request: None });
        let first = link.step(true, t0);
        assert_eq!(first, Step { reset: true, request: Some(link.gen) });
        let g1 = link.gen;
        assert_eq!(link.step(true, t0 + Duration::from_millis(100)), Step { reset: false, request: None }); // one in flight
        // Stale: reset, new generation, new request; the old callback is dropped.
        let stale = link.step(true, t0 + Duration::from_millis(600));
        assert!(stale.reset && stale.request == Some(link.gen) && link.gen != g1);
        assert!(!link.accept(g1));
        let g2 = link.gen;
        assert!(link.accept(g2) && !link.accept(g2));
    }

    #[test]
    fn losing_readiness_resets_exactly_once() {
        let (mut link, t0) = (Link::default(), Instant::now());
        link.step(true, t0);
        let g = link.gen;
        assert_eq!(link.step(false, t0), Step { reset: true, request: None });
        assert_eq!(link.step(false, t0), Step { reset: false, request: None });
        assert!(!link.accept(g), "callback after readiness loss is discarded");
        let back = link.step(true, t0);
        assert!(back.reset && back.request.is_some());
    }
}

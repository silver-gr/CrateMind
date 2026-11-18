//! Standalone check of the VST3 host (macOS):
//! `cargo run --example master_host -- <path.vst3> [--slot deck_a|deck_b|master] [--offline] [--editor] [--silent]`
//!
//! `--offline` runs without an audio device: it pushes a generated signal through the plugin on the
//! master slot in device-sized blocks; then the PDC check (the plugin on Deck A, a burst on Deck A
//! only and one on Deck B only must come out at the same delay, wet and bypassed); then checks that a
//! changed parameter is saved and restored through a throwaway state folder, in the `--slot` slot's
//! own subfolder. Otherwise the main thread plays the app's role (it runs the dispatched closures
//! and, with `--editor`, pumps AppKit events), a worker thread plays the supervisor's, and a
//! WebSocket client streams a tone (silence with `--silent`) on both decks to the default output,
//! through the plugin on the `--slot` slot (master by default), with its bypass toggled midway.

#[cfg(target_os = "macos")]
fn main() {
    use cratemind_native::native_actions::HostSlot;
    let args: Vec<String> = std::env::args().skip(1).collect();
    let flag = |name: &str| args.iter().any(|a| a == name);
    let slot_at = args.iter().position(|a| a == "--slot");
    let slot = match slot_at.map(|at| args.get(at + 1).and_then(|key| HostSlot::parse(key))) {
        None => Some(HostSlot::Master),
        Some(slot) => slot,
    };
    let path = args.iter().enumerate().find(|(i, a)| !a.starts_with("--") && slot_at.is_none_or(|at| *i != at + 1)).map(|(_, a)| std::path::PathBuf::from(a));
    let (Some(path), Some(slot)) = (path, slot) else {
        eprintln!("usage: master_host <path.vst3> [--slot deck_a|deck_b|master] [--offline] [--editor] [--silent]");
        std::process::exit(2);
    };
    let result = if flag("--offline") { macos::offline(&path, slot) } else { macos::device(path, slot, flag("--editor"), flag("--silent")) };
    if let Err(e) = result {
        eprintln!("error: {e}");
        std::process::exit(1);
    }
}

#[cfg(not(target_os = "macos"))]
fn main() {
    eprintln!("master_host runs on macOS only");
    std::process::exit(2);
}

#[cfg(target_os = "macos")]
mod macos {
    use cpal::traits::{DeviceTrait, HostTrait};
    use cratemind_native::{
        master_host::{self, MainThread, SlotReply},
        native_actions::HostSlot,
    };
    use objc2::MainThreadMarker;
    use objc2_app_kit::{NSApplication, NSApplicationActivationPolicy, NSEventMask};
    use objc2_foundation::{NSDate, NSDefaultRunLoopMode};
    use std::{
        net::{TcpListener, TcpStream},
        path::{Path, PathBuf},
        sync::{mpsc, Arc},
        thread,
        time::{Duration, Instant},
    };
    use tungstenite::{client::IntoClientRequest, Message};

    const OFFLINE_RATE: u32 = 48_000;
    const DEVICE_FRAMES: usize = 480; // not a multiple of the plugin block, so partial chunks run too
    const FRAME: usize = 256; // frames per WebSocket message, as the page sends them
    const HEADER: usize = 32; // the frame's per-deck transport header, zero in stage 1
    const ORIGIN: &str = "http://127.0.0.1:1";

    pub fn offline(path: &Path, slot: HostSlot) -> Result<(), String> {
        // 4 s of a 110 Hz + 2.5 kHz mix whose level ramps from -40 dBFS to 0 dBFS.
        let frames = 4 * OFFLINE_RATE as usize;
        let input: Vec<f32> = (0..frames)
            .flat_map(|i| {
                let t = i as f32 / OFFLINE_RATE as f32;
                let gain = 10f32.powf((-40.0 + 40.0 * i as f32 / frames as f32) / 20.0);
                let s = gain * (0.7 * (std::f32::consts::TAU * 110.0 * t).sin() + 0.3 * (std::f32::consts::TAU * 2500.0 * t).sin());
                [s, s]
            })
            .collect();
        let t = Instant::now();
        let r = master_host::offline_check(path, OFFLINE_RATE, DEVICE_FRAMES, &input)?;
        let audio = r.frames_out as f64 / f64::from(OFFLINE_RATE);
        println!("plugin: {}", r.name);
        println!("latency: {} samples", r.latency_samples);
        println!("peak in: {:.3} ({:.1} dBFS), peak out: {:.3} ({:.1} dBFS)", r.peak_in, db(r.peak_in), r.peak_out, db(r.peak_out));
        println!("non-finite output samples: {}, underruns: {}", r.non_finite, r.underruns);
        println!(
            "processed {:.2} s of audio in {:.1} ms ({:.0}x real time); load + run {:.0} ms",
            audio,
            r.elapsed.as_secs_f64() * 1000.0,
            audio / r.elapsed.as_secs_f64(),
            t.elapsed().as_secs_f64() * 1000.0
        );
        println!("pdc: {}", master_host::offline_pdc_check(path, OFFLINE_RATE, DEVICE_FRAMES)?);
        let dir = std::env::temp_dir().join(format!("cratemind-master-host-example-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        let state = master_host::offline_state_check(path, OFFLINE_RATE, &master_host::slot_state_dir(&dir, slot));
        let _ = std::fs::remove_dir_all(&dir);
        println!("state ({}): {}", slot.key(), state?);
        Ok(())
    }

    fn db(x: f32) -> f32 {
        20.0 * x.max(1e-9).log10()
    }

    pub fn device(path: PathBuf, slot: HostSlot, editor: bool, silent: bool) -> Result<(), String> {
        let (tx, rx) = mpsc::channel::<Box<dyn FnOnce() + Send>>();
        let main: MainThread = Arc::new(move |f| {
            let _ = tx.send(f);
        });
        let app = editor.then(|| {
            let app = NSApplication::sharedApplication(MainThreadMarker::new().expect("main thread"));
            app.setActivationPolicy(NSApplicationActivationPolicy::Accessory);
            app.finishLaunching();
            app
        });
        let worker = thread::spawn(move || supervise(path, slot, editor, silent, &main));
        while !worker.is_finished() {
            match &app {
                Some(app) => {
                    pump(app);
                    while let Ok(f) = rx.try_recv() {
                        f();
                    }
                }
                None => {
                    if let Ok(f) = rx.recv_timeout(Duration::from_millis(10)) {
                        f();
                    }
                }
            }
        }
        while let Ok(f) = rx.try_recv() {
            f();
        }
        worker.join().map_err(|_| "worker thread panicked".to_string())?
    }

    fn pump(app: &NSApplication) {
        let until = NSDate::dateWithTimeIntervalSinceNow(0.01);
        while let Some(event) = unsafe { app.nextEventMatchingMask_untilDate_inMode_dequeue(NSEventMask::Any, Some(&until), NSDefaultRunLoopMode, true) } {
            app.sendEvent(&event);
        }
    }

    // The supervisor's role: start, (editor), stream for a while with the slot's bypass toggled, stop.
    fn supervise(path: PathBuf, slot: HostSlot, editor: bool, silent: bool, main: &MainThread) -> Result<(), String> {
        let device = cpal::default_host().default_output_device().ok_or("no output device")?;
        let config = device.default_output_config().map_err(|e| e.to_string())?;
        let rate = config.sample_rate();
        println!("device: {} Hz, {} channels, {}", rate, config.channels(), config.sample_format());
        let listener = TcpListener::bind("127.0.0.1:0").map_err(|e| e.to_string())?;
        let mut paths: [Option<PathBuf>; 3] = Default::default();
        paths[slot.index()] = Some(path);
        let t = Instant::now();
        let started = master_host::start(&paths, rate, ORIGIN, &listener, main, None)?;
        println!("started in {:.0} ms, port {}", t.elapsed().as_secs_f64() * 1000.0, started.port);
        for (key, reply) in &started.slots {
            match reply {
                Some(SlotReply::Loaded { name, latency_samples, restored }) => println!("{key}: {name}, latency {latency_samples} samples, restored {restored}"),
                Some(SlotReply::Failed { error }) => println!("{key}: failed: {error}"),
                None => println!("{key}: empty"),
            }
        }
        let refused = connect(started.port, &started.token, "http://evil.example").is_err();
        println!("wrong Origin refused: {refused}");
        let result = connect(started.port, &started.token, ORIGIN).and_then(|mut socket| {
            if editor {
                master_host::open_editor(main, slot)?;
                println!("editor window opened");
            }
            let mut n = 0;
            stream(&mut socket, rate, 1, silent, &mut n)?;
            master_host::set_bypass(main, slot, true)?;
            println!("bypassed");
            stream(&mut socket, rate, 1, silent, &mut n)?;
            master_host::set_bypass(main, slot, false)?;
            println!("bypass off");
            stream(&mut socket, rate, if editor { 8 } else { 1 }, silent, &mut n)?;
            let _ = socket.close(None);
            let _ = socket.flush();
            Ok(())
        });
        master_host::stop(main)?;
        println!("stopped");
        result
    }

    fn connect(port: u16, token: &str, origin: &str) -> Result<tungstenite::WebSocket<TcpStream>, String> {
        let stream = TcpStream::connect(("127.0.0.1", port)).map_err(|e| e.to_string())?;
        let mut request = format!("ws://127.0.0.1:{port}/{token}").into_client_request().map_err(|e| e.to_string())?;
        request.headers_mut().insert("Origin", origin.parse().map_err(|_| "bad origin")?);
        let (socket, _) = tungstenite::client(request, stream).map_err(|e| e.to_string())?;
        Ok(socket)
    }

    // The page's role: 256-frame binary messages (a zero header, then the same signal on both decks) at
    // real-time pace; prints the stats frames.
    fn stream(socket: &mut tungstenite::WebSocket<TcpStream>, rate: u32, seconds: u64, silent: bool, n: &mut u64) -> Result<(), String> {
        socket.get_ref().set_read_timeout(Some(Duration::from_millis(1))).map_err(|e| e.to_string())?;
        let period = Duration::from_secs_f64(FRAME as f64 / f64::from(rate));
        let (start, mut next) = (Instant::now(), Instant::now());
        let mut bytes = Vec::with_capacity(HEADER + FRAME * 16);
        while start.elapsed() < Duration::from_secs(seconds) {
            bytes.clear();
            bytes.resize(HEADER, 0);
            for _ in 0..FRAME {
                let s = if silent { 0.0 } else { 0.1 * (std::f32::consts::TAU * 440.0 * *n as f32 / rate as f32).sin() };
                *n += 1;
                for _ in 0..4 {
                    bytes.extend_from_slice(&s.to_le_bytes());
                }
            }
            socket.send(Message::binary(bytes.clone())).map_err(|e| format!("send: {e}"))?;
            loop {
                match socket.read() {
                    Ok(Message::Text(stats)) => println!("{:5.2} s  {stats}", start.elapsed().as_secs_f64()),
                    Ok(Message::Close(_)) => return Err("the host closed the socket".into()),
                    Ok(_) => {}
                    Err(tungstenite::Error::Io(e)) if matches!(e.kind(), std::io::ErrorKind::WouldBlock | std::io::ErrorKind::TimedOut) => break,
                    Err(e) => return Err(format!("read: {e}")),
                }
            }
            next += period;
            thread::sleep(next.saturating_duration_since(Instant::now()));
        }
        Ok(())
    }
}

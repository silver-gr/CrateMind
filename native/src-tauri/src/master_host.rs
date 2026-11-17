//! Experimental VST3 master host (macOS): the page streams the master bus over a local
//! WebSocket into a ring, a VST3 plugin processes it and cpal plays it on the default output.
//! Plugin load, editor and teardown run on the main thread through a `MainThread` dispatcher.
use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
use rtrb::{Consumer, Producer, RingBuffer};
use std::{
    cell::RefCell,
    io::{ErrorKind, Read, Write},
    net::{TcpListener, TcpStream},
    path::{Component, Path, PathBuf},
    sync::{
        atomic::{AtomicBool, AtomicU32, AtomicU64, Ordering::SeqCst},
        mpsc, Arc, Mutex, TryLockError,
    },
    thread,
    time::{Duration, Instant},
};
use tungstenite::{
    handshake::server::{ErrorResponse, Request, Response},
    http::StatusCode,
    Message, WebSocket,
};
use vst3_host::{AudioBuffers, Plugin, PluginWindow, Vst3Host};

/// Runs a closure on the app's main thread (in the app: `AppHandle::run_on_main_thread`).
pub type MainThread = Arc<dyn Fn(Box<dyn FnOnce() + Send>) + Send + Sync>;

const MAX_BLOCK: usize = 512; // plugin max block; device buffers are processed in chunks of this
const PREFILL_EXTRA_FRAMES: usize = 512; // smallest cushion: ring prefill = 2 device buffers + the cushion
const MAX_CUSHION_FRAMES: usize = 16_384; // largest cushion at any rate: above ~250 kHz, 120 ms would not fit the ring
const MAX_CUSHION_SECS: f64 = 0.12; // largest cushion the delivery jitter may ask for
const RING_FRAMES: usize = 32_768; // a full ring drops incoming frames
const LATE_GAP: Duration = Duration::from_millis(20); // a wait between audio frames counted as late
const WARMUP: Duration = Duration::from_secs(3); // gaps while the page starts streaming leave the cushion alone
const TRIM_WINDOW_SECS: usize = 2; // how long the fill must stay above the target before the excess is dropped
const MAX_FRAME_FRAMES: usize = 4096; // largest binary frame accepted (frames)
const LOAD_TIMEOUT: Duration = Duration::from_secs(20);
const MAIN_TIMEOUT: Duration = Duration::from_secs(20);
const CONNECT_TIMEOUT: Duration = Duration::from_secs(5); // no client by then: the host stops itself
const HANDSHAKE_TIMEOUT: Duration = Duration::from_secs(2);
const WRITE_TIMEOUT: Duration = Duration::from_secs(1);
const POLL: Duration = Duration::from_millis(20);
const STATS_EVERY: Duration = Duration::from_millis(500);
const EDITOR_SERVICE_EVERY: Duration = Duration::from_millis(33);
const REPLY_BUDGET: usize = 96 * 1024; // the scan's NATIVE_RESULT line must stay under protocol::MAX_RECORD
const STATE_MAGIC: &[u8; 8] = b"CMVST3S1";
const STATE_HEADER: usize = 48; // magic | uid (32 ASCII hex digits) | FNV-1a 64 of the blob (u64 LE)
const MAX_STATE_BYTES: usize = 16 * 1024 * 1024; // largest plugin state blob saved or restored
const NOT_RUNNING: &str = "Το plugin master δεν τρέχει.";
const SUPERSEDED: &str = "Η φόρτωση του plugin ακυρώθηκε.";

/// Bumped by every start and stop; a load or socket thread of an older generation unwinds itself.
static GENERATION: AtomicU64 = AtomicU64::new(0);
/// Set while an editor service task waits for the main thread, so a busy main thread never piles them up.
static EDITOR_SERVICE_QUEUED: AtomicBool = AtomicBool::new(false);

thread_local! {
    // Main thread only: the running plugin, its stream and its editor window.
    static SESSION: RefCell<Option<Session>> = const { RefCell::new(None) };
}

#[derive(Debug, Clone, serde::Serialize)]
pub struct PluginEntry {
    pub name: String,
    pub path: PathBuf,
}

#[derive(Debug, Clone, serde::Serialize)]
pub struct Started {
    pub token: String,
    pub port: u16,
    pub latency_samples: u32,
    pub name: String,
    pub restored: bool,
}

#[derive(Debug)]
pub struct OfflineReport {
    pub name: String,
    pub latency_samples: u32,
    pub peak_in: f32,
    pub peak_out: f32,
    pub non_finite: usize,
    pub frames_out: u64,
    pub underruns: u64,
    pub elapsed: Duration,
}

// Shared by the audio callback, the socket thread and teardown; counters only, no locks.
#[derive(Default)]
struct Link {
    stop: AtomicBool,
    underruns: AtomicU64,
    frames_out: AtomicU64,
    device_frames: AtomicU32,
    fill_sum: AtomicU64,
    fill_count: AtomicU64,
    trims: AtomicU64,
    // Extra frames kept queued against delivery gaps; 0 means the minimum. Set by the socket thread,
    // grow-only for the session.
    cushion_frames: AtomicU32,
    // The plugin's reported latency: set at start, refreshed by the editor service.
    plugin_latency: AtomicU32,
}

struct Session {
    generation: u64,
    window: Option<PluginWindow>,
    stream: cpal::Stream,
    plugin: Arc<Mutex<Plugin>>,
    link: Arc<Link>,
    // The plugin's state file, saved by teardown; `None` for a plugin without a usable uid.
    state: Option<PathBuf>,
}

/// The two VST3 folders a plugin may be loaded from.
pub fn plugin_dirs() -> Vec<PathBuf> {
    let mut dirs = vec![PathBuf::from("/Library/Audio/Plug-Ins/VST3")];
    if let Some(home) = std::env::var_os("HOME") {
        dirs.push(PathBuf::from(home).join("Library/Audio/Plug-Ins/VST3"));
    }
    dirs
}

/// Lists the `*.vst3` bundles directly inside the VST3 folders, without loading any.
pub fn scan() -> Vec<PluginEntry> {
    let dirs = plugin_dirs();
    let mut found: Vec<PluginEntry> = dirs
        .iter()
        .filter_map(|dir| std::fs::read_dir(dir).ok())
        .flatten()
        .filter_map(|entry| validate_in(&entry.ok()?.path(), &dirs).ok())
        .map(|path| PluginEntry { name: path.file_stem().unwrap_or_default().to_string_lossy().into_owned(), path })
        .collect();
    found.sort_by_key(|p| p.name.to_lowercase());
    fit_reply(found)
}

/// Keeps the alphabetical prefix whose JSON fits `REPLY_BUDGET`: a larger reply would end the backend.
fn fit_reply(mut found: Vec<PluginEntry>) -> Vec<PluginEntry> {
    let mut used = 0;
    let keep = found
        .iter()
        .position(|p| {
            used += serde_json::to_string(p).map_or(REPLY_BUDGET, |json| json.len()) + 1;
            used > REPLY_BUDGET
        })
        .unwrap_or(found.len());
    found.truncate(keep);
    found
}

/// Logs the library's (English) error and gives the user `message`.
fn logged<E: std::fmt::Display>(message: &'static str) -> impl Fn(E) -> String + Copy {
    move |e| {
        eprintln!("CrateMind master host: {message} ({e})");
        message.to_string()
    }
}

/// Accepts only a `*.vst3` directory that is a direct child of one of `plugin_dirs()`.
pub fn validate_path(path: &Path) -> Result<PathBuf, String> {
    validate_in(path, &plugin_dirs())
}

fn validate_in(path: &Path, roots: &[PathBuf]) -> Result<PathBuf, String> {
    let ok = path.is_absolute()
        && path.components().all(|c| matches!(c, Component::RootDir | Component::Normal(_)))
        && path.extension().is_some_and(|e| e.eq_ignore_ascii_case("vst3"))
        && path.parent().is_some_and(|parent| roots.iter().any(|root| root == parent))
        && path.is_dir();
    if ok { Ok(path.to_path_buf()) } else { Err("Μη έγκυρη διαδρομή plugin VST3.".into()) }
}

/// Loads `path` on the main thread and starts playing it on the default output, fed by the
/// WebSocket client that connects to `listener` (put in non-blocking mode) at `/<token>` with
/// `Origin: origin`. Refuses before loading when the device rate is not `sample_rate`.
/// A running host is replaced. `path` must already be validated by the caller. With `state_dir`,
/// the plugin's state is restored from it at load and saved to it at teardown.
pub fn start(path: &Path, sample_rate: u32, origin: &str, listener: &TcpListener, main: &MainThread, state_dir: Option<&Path>) -> Result<Started, String> {
    let generation = GENERATION.fetch_add(1, SeqCst) + 1;
    let socket_err = logged::<std::io::Error>("Η τοπική σύνδεση ήχου απέτυχε.");
    let port = listener.local_addr().map_err(socket_err)?.port();
    let listener = listener.try_clone().map_err(socket_err)?;
    listener.set_nonblocking(true).map_err(socket_err)?;
    let (ring, consumer) = RingBuffer::new(RING_FRAMES * 2);
    let link = Arc::new(Link::default());
    let (path, main_link, state_dir) = (path.to_path_buf(), link.clone(), state_dir.map(Path::to_path_buf));
    let loaded = on_main(main, LOAD_TIMEOUT, move || load_session(generation, &path, sample_rate, state_dir.as_deref(), consumer, main_link));
    let (name, latency_samples, restored) = match loaded {
        Ok(result) => result?,
        Err(e) => {
            // Timed out: a late load sees the newer generation and unloads itself; the queued
            // teardown covers a load that finished between the timeout and this bump.
            if GENERATION.compare_exchange(generation, generation + 1, SeqCst, SeqCst).is_ok() {
                main(Box::new(move || {
                    if let Some(session) = take_session(Some(generation)) {
                        teardown(session);
                    }
                }));
            }
            return Err(e);
        }
    };
    let token = uuid::Uuid::new_v4().simple().to_string();
    link.plugin_latency.store(latency_samples, SeqCst);
    let server = Server { generation, token: token.clone(), origin: origin.to_owned(), sample_rate, link, ring, main: main.clone(), last_frame: None, max_gap: Duration::ZERO, session_gap: Duration::ZERO, late: 0, first_frame: None };
    thread::spawn(move || server.run(listener));
    Ok(Started { token, port, latency_samples, name, restored })
}

/// Stops the host (editor window, then the stream, then the plugin, on the main thread).
pub fn stop(main: &MainThread) -> Result<(), String> {
    GENERATION.fetch_add(1, SeqCst);
    on_main(main, MAIN_TIMEOUT, || take_session(None).map(teardown)).map(|_| ())
}

/// Opens (or re-opens) the plugin's own editor window.
pub fn open_editor(main: &MainThread) -> Result<(), String> {
    on_main(main, MAIN_TIMEOUT, || {
        let (generation, plugin, old) = SESSION
            .with(|s| s.borrow_mut().as_mut().map(|s| (s.generation, s.plugin.clone(), s.window.take())))
            .ok_or(NOT_RUNNING)?;
        drop(old); // detach a previous editor before attaching a new one
        let mut window = PluginWindow::new(plugin);
        window.open().map_err(logged("Το παράθυρο του plugin δεν άνοιξε."))?;
        SESSION.with(|s| match s.borrow_mut().as_mut() {
            Some(s) if s.generation == generation => {
                s.window = Some(window);
                Ok(())
            }
            _ => Err(NOT_RUNNING.to_string()),
        })
    })?
}

/// Loads `path` on the calling (main) thread and pushes interleaved stereo `input` through the
/// same ring and render path as the device callback, in `device_frames` blocks, without a device.
pub fn offline_check(path: &Path, sample_rate: u32, device_frames: usize, input: &[f32]) -> Result<OfflineReport, String> {
    let plugin = Arc::new(Mutex::new(load(path, sample_rate, None)?.0));
    let (name, latency_samples) = describe(&plugin);
    let (mut ring, consumer) = RingBuffer::new(RING_FRAMES * 2);
    let link = Arc::new(Link::default());
    let mut render = Render::new(plugin, consumer, link.clone(), sample_rate);
    let mut out = vec![0.0f32; device_frames * 2];
    let (mut peak_out, mut non_finite, mut elapsed) = (0.0f32, 0, Duration::ZERO);
    let mut step = |render: &mut Render| {
        let t = Instant::now();
        render.render(&mut out, 2);
        elapsed += t.elapsed();
        non_finite += out.iter().filter(|s| !s.is_finite()).count();
        peak_out = out.iter().fold(peak_out, |m, s| m.max(s.abs()));
    };
    for chunk in input.chunks_exact(device_frames * 2) {
        ring.push_entire_slice(chunk).map_err(|_| "Ο ring buffer γέμισε.".to_string())?;
        step(&mut render);
    }
    while !render.prefilling && render.ring.slots() >= device_frames * 2 {
        step(&mut render);
    }
    Ok(OfflineReport {
        name,
        latency_samples,
        peak_in: input.iter().fold(0.0, |m, s| m.max(s.abs())),
        peak_out,
        non_finite,
        frames_out: link.frames_out.load(SeqCst),
        underruns: link.underruns.load(SeqCst),
        elapsed,
    })
}

fn on_main<T: Send + 'static>(main: &MainThread, timeout: Duration, f: impl FnOnce() -> T + Send + 'static) -> Result<T, String> {
    if unsafe { libc::pthread_main_np() } != 0 {
        return Ok(f());
    }
    let (tx, rx) = mpsc::sync_channel(1);
    main(Box::new(move || {
        let _ = tx.send(f());
    }));
    rx.recv_timeout(timeout).map_err(|e| match e {
        mpsc::RecvTimeoutError::Timeout => "Το plugin master δεν απάντησε εγκαίρως.".to_string(),
        mpsc::RecvTimeoutError::Disconnected => "Η εφαρμογή κλείνει.".to_string(),
    })
}

/// Example check of the state file, on the calling (main) thread: a parameter changed and saved as
/// teardown saves it comes back on the next load from the empty folder `dir`, byte for byte.
pub fn offline_state_check(path: &Path, sample_rate: u32, dir: &Path) -> Result<String, String> {
    let (mut plugin, restored) = load(path, sample_rate, Some(dir))?;
    if restored {
        return Err("restored from an empty folder".into());
    }
    let uid = plugin.info().uid.clone();
    let file = state_file(dir, &uid).ok_or("the plugin's uid is not 32 hex digits")?;
    let parameters = plugin.get_parameters().map_err(|e| e.to_string())?;
    // Not the program-change parameter (VST3 `kIsProgramChange`): it is writable but not saved state.
    let program_change = 1 << 15;
    let parameter = parameters.iter().find(|p| !p.is_read_only && !p.is_bypass && p.flags & program_change == 0).ok_or("no writable parameter")?;
    let value = if parameter.default < 0.5 { 1.0 } else { 0.0 };
    plugin.set_parameter(parameter.id, value).map_err(|e| e.to_string())?;
    // One block of silence, so the processor takes the change before its state is saved.
    plugin.process_audio(&mut AudioBuffers::new(2, 2, MAX_BLOCK, f64::from(sample_rate))).map_err(|e| e.to_string())?;
    save_state(&plugin, &file);
    drop(plugin);
    let bytes = std::fs::read(&file).map_err(|e| e.to_string())?;
    let saved = decode_state(&bytes, &uid)?;
    let (plugin, restored) = load(path, sample_rate, Some(dir))?;
    let got = plugin.get_parameter(parameter.id).map_err(|e| e.to_string())?;
    if !restored {
        return Err("the saved state was not restored".into());
    }
    if (got - value).abs() > 1e-6 {
        return Err(format!("«{}» came back as {got}, not {value} (default {})", parameter.name, parameter.default));
    }
    if plugin.save_state().map_err(|e| e.to_string())? != saved {
        return Err("the restored plugin saves different state bytes".into());
    }
    Ok(format!("«{}» set to {value} (default {}) came back; {} state bytes reproduced", parameter.name, parameter.default, saved.len()))
}

/// Loads and starts the plugin; with `state_dir`, first restores its saved state (true if it did).
fn load(path: &Path, sample_rate: u32, state_dir: Option<&Path>) -> Result<(Plugin, bool), String> {
    let failed = logged::<vst3_host::Error>("Το plugin δεν φορτώθηκε.");
    let mut host = Vst3Host::builder().sample_rate(f64::from(sample_rate)).block_size(MAX_BLOCK).build().map_err(failed)?;
    let mut plugin = host.load_plugin(path).map_err(failed)?;
    let uid = plugin.info().uid.clone();
    let mut restored = false;
    if let Some(file) = state_dir.and_then(|dir| state_file(dir, &uid)) {
        if let Some(blob) = read_state(&file, &uid) {
            match plugin.load_state(&blob) {
                Ok(()) => {
                    restored = true;
                    let _ = plugin.service_host_requests(); // a latency changed by the state is read now
                }
                Err(e) => {
                    // A failed restore can leave the instance half-changed, and teardown would save that.
                    reject_state(&file, e);
                    drop(plugin);
                    plugin = host.load_plugin(path).map_err(failed)?;
                }
            }
        }
    }
    plugin.start_processing().map_err(failed)?;
    Ok((plugin, restored))
}

/// `<dir>/<uid>.state`, only for a uid that is a canonical class id (32 hex digits).
fn state_file(dir: &Path, uid: &str) -> Option<PathBuf> {
    (uid.len() == 32 && uid.bytes().all(|b| b.is_ascii_hexdigit())).then(|| dir.join(format!("{uid}.state")))
}

fn fnv1a64(bytes: &[u8]) -> u64 {
    bytes.iter().fold(0xcbf2_9ce4_8422_2325, |hash, b| (hash ^ u64::from(*b)).wrapping_mul(0x0100_0000_01b3))
}

/// The state file: `CMVST3S1` | uid (32 ASCII bytes) | FNV-1a 64 of the blob (u64 LE) | blob.
fn encode_state(uid: &str, blob: &[u8]) -> Vec<u8> {
    [STATE_MAGIC.as_slice(), uid.as_bytes(), &fnv1a64(blob).to_le_bytes(), blob].concat()
}

/// The blob of a state file written for `uid`, or why it cannot be used.
fn decode_state<'a>(bytes: &'a [u8], uid: &str) -> Result<&'a [u8], &'static str> {
    if bytes.len() < STATE_HEADER || bytes.len() > STATE_HEADER + MAX_STATE_BYTES {
        return Err("size out of range");
    }
    let (header, blob) = bytes.split_at(STATE_HEADER);
    if &header[..8] != STATE_MAGIC {
        Err("not a CrateMind state file")
    } else if &header[8..40] != uid.as_bytes() {
        Err("another plugin's state")
    } else if header[40..] != fnv1a64(blob).to_le_bytes() {
        Err("checksum mismatch")
    } else {
        Ok(blob)
    }
}

/// The saved blob for `uid`; `None` when there is none. A file that cannot be used is set aside.
fn read_state(file: &Path, uid: &str) -> Option<Vec<u8>> {
    let mut bytes = Vec::new();
    let limit = (STATE_HEADER + MAX_STATE_BYTES + 1) as u64; // the file may grow after any size check
    match std::fs::File::open(file).and_then(|f| f.take(limit).read_to_end(&mut bytes)) {
        Ok(_) => {}
        Err(e) if e.kind() == ErrorKind::NotFound => return None,
        Err(e) => {
            reject_state(file, e); // a rename needs no read access: kept aside before teardown's save replaces it
            return None;
        }
    }
    match decode_state(&bytes, uid) {
        Ok(blob) => Some(blob.to_vec()),
        Err(reason) => {
            reject_state(file, reason);
            None
        }
    }
}

/// Keeps one copy of a rejected state file as `<uid>.state.rejected`, out of the next save's way.
fn reject_state(file: &Path, reason: impl std::fmt::Display) {
    eprintln!("CrateMind master host: plugin state rejected ({reason}): {}", file.display());
    let _ = std::fs::rename(file, file.with_extension("state.rejected"));
}

/// Main thread: saves the plugin's state over `file` (through a temporary file); logs a failure.
fn save_state(plugin: &Plugin, file: &Path) {
    let result = plugin.save_state().map_err(|e| e.to_string()).and_then(|blob| write_state(file, &plugin.info().uid, &blob));
    if let Err(e) = result {
        eprintln!("CrateMind master host: plugin state not saved ({e}): {}", file.display());
    }
}

/// A blob over the limit is refused and the previous file kept.
fn write_state(file: &Path, uid: &str, blob: &[u8]) -> Result<(), String> {
    if blob.len() > MAX_STATE_BYTES {
        return Err(format!("{} bytes, over the limit", blob.len()));
    }
    let temp = file.with_extension("state.tmp");
    file.parent()
        .map_or(Ok(()), std::fs::create_dir_all)
        .and_then(|()| {
            let mut f = std::fs::File::create(&temp)?;
            f.write_all(&encode_state(uid, blob))?;
            f.sync_all() // F_FULLFSYNC on macOS: the data is on disk before the rename replaces the old file
        })
        .and_then(|()| std::fs::rename(&temp, file))
        .map_err(|e| e.to_string())
}

fn describe(plugin: &Mutex<Plugin>) -> (String, u32) {
    let plugin = plugin.lock().unwrap_or_else(|p| p.into_inner());
    (plugin.info().name.clone(), plugin.latency_samples())
}

// Main thread.
fn load_session(generation: u64, path: &Path, sample_rate: u32, state_dir: Option<&Path>, ring: Consumer<f32>, link: Arc<Link>) -> Result<(String, u32, bool), String> {
    if let Some(old) = take_session(None) {
        teardown(old);
    }
    if GENERATION.load(SeqCst) != generation {
        return Err(SUPERSEDED.into());
    }
    let device = cpal::default_host().default_output_device().ok_or("Δεν βρέθηκε συσκευή εξόδου ήχου.")?;
    let config = device.default_output_config().map_err(logged("Η συσκευή εξόδου ήχου δεν απάντησε."))?;
    if config.sample_rate() != sample_rate {
        return Err(format!("Η συσκευή εξόδου τρέχει στα {} Hz, όχι στα {sample_rate} Hz.", config.sample_rate()));
    }
    if config.sample_format() != cpal::SampleFormat::F32 {
        return Err(format!("Η συσκευή εξόδου δεν δέχεται δείγματα f32 ({}).", config.sample_format()));
    }
    let (plugin, restored) = load(path, sample_rate, state_dir)?;
    let state = state_dir.and_then(|dir| state_file(dir, &plugin.info().uid));
    let plugin = Arc::new(Mutex::new(plugin));
    let (name, latency_samples) = describe(&plugin);
    let channels = usize::from(config.channels());
    let mut render = Render::new(plugin.clone(), ring, link.clone(), sample_rate);
    let failed = link.clone();
    let stream = device
        .build_output_stream::<f32, _, _>(
            config.config(),
            move |out, _| render.render(out, channels),
            // Never drop the stream here: signal, and the socket thread stops the host.
            move |e| {
                if !matches!(e.kind(), cpal::ErrorKind::Xrun | cpal::ErrorKind::RealtimeDenied) {
                    failed.stop.store(true, SeqCst);
                }
            },
            None,
        )
        .map_err(logged("Η έξοδος ήχου δεν άνοιξε."))?;
    stream.play().map_err(logged("Η έξοδος ήχου δεν ξεκίνησε."))?;
    let session = Session { generation, window: None, stream, plugin, link, state };
    if GENERATION.load(SeqCst) != generation {
        teardown(session);
        return Err(SUPERSEDED.into());
    }
    SESSION.with(|s| *s.borrow_mut() = Some(session));
    Ok((name, latency_samples, restored))
}

// Main thread. `None` takes any session.
fn take_session(generation: Option<u64>) -> Option<Session> {
    SESSION.with(|s| {
        let mut s = s.borrow_mut();
        if generation.is_none_or(|g| s.as_ref().is_some_and(|s| s.generation == g)) { s.take() } else { None }
    })
}

// Main thread. Editor window, then the stream (and its callback), then the plugin's state, then
// the last plugin reference.
fn teardown(session: Session) {
    session.link.stop.store(true, SeqCst);
    let Session { window, stream, plugin, state, .. } = session;
    drop(window);
    drop(stream);
    if let Some(file) = state {
        save_state(&plugin.lock().unwrap_or_else(|p| p.into_inner()), &file);
    }
    drop(plugin);
}

// Main thread: applies plugin-initiated editor resizes and dispatches non-background IDataExchange queues.
fn service_editor(generation: u64) {
    EDITOR_SERVICE_QUEUED.store(false, SeqCst);
    SESSION.with(|s| {
        let s = s.borrow();
        let Some(s) = s.as_ref().filter(|s| s.generation == generation) else { return };
        let Some(window) = s.window.as_ref() else { return };
        let _ = window.service_platform_events(); // try_locks the plugin itself
        if let Ok(mut plugin) = s.plugin.try_lock() {
            let _ = plugin.take_data_exchange_blocks(); // delivers to the controller; snapshots unused
            // A latency change (look-ahead, oversampling) applies the plugin's restart request here,
            // under the lock: the audio thread passes those buffers through dry.
            let _ = plugin.service_host_requests();
            s.link.plugin_latency.store(plugin.latency_samples(), SeqCst);
        };
    });
}

// Stops the host only if no newer start/stop happened since `generation` began.
fn stop_generation(generation: u64, main: &MainThread) {
    if GENERATION.compare_exchange(generation, generation + 1, SeqCst, SeqCst).is_ok() {
        let _ = on_main(main, MAIN_TIMEOUT, move || take_session(Some(generation)).map(teardown));
    }
}

fn prefill_frames(device_frames: usize, cushion_frames: usize) -> usize {
    2 * device_frames + cushion_frames.max(PREFILL_EXTRA_FRAMES)
}

/// The largest cushion: 120 ms, within `MAX_CUSHION_FRAMES` so the prefill always fits the ring.
fn cushion_cap(sample_rate: u32) -> usize {
    ((f64::from(sample_rate) * MAX_CUSHION_SECS) as usize).min(MAX_CUSHION_FRAMES)
}

/// The cushion that rides out a wait between two audio frames, with a quarter to spare.
fn cushion_for(gap: Duration, sample_rate: u32) -> usize {
    let frames = (gap.as_secs_f64() * 1.25 * f64::from(sample_rate)) as usize;
    frames.clamp(PREFILL_EXTRA_FRAMES, cushion_cap(sample_rate))
}

/// The cushion after a gap: it only grows during a session. Gaps in the warm-up are ignored, and so
/// is a gap longer than the cap plus a device buffer: no cushion under the cap rides it out.
fn next_cushion(current: u32, gap: Duration, since_first_frame: Duration, sample_rate: u32, device_frames: u32) -> u32 {
    let gap_frames = gap.as_secs_f64() * f64::from(sample_rate);
    if since_first_frame < WARMUP || gap_frames > (cushion_cap(sample_rate) + device_frames as usize) as f64 {
        return current;
    }
    current.max(cushion_for(gap, sample_rate) as u32)
}

/// Queued audio that is pure delay: the fill never dipped within one device buffer of the target for a whole window.
fn excess_frames(min_fill: usize, target: usize, device_frames: usize) -> usize {
    if min_fill != usize::MAX && min_fill > target + device_frames { min_fill - target } else { 0 }
}

/// Estimated added latency: mean ring fill + plugin latency + one device buffer.
fn latency_ms(mean_fill_frames: f64, plugin_latency: u32, device_frames: u32, sample_rate: u32) -> f64 {
    (mean_fill_frames + f64::from(plugin_latency) + f64::from(device_frames)) * 1000.0 / f64::from(sample_rate)
}

/// Decodes one binary frame (interleaved stereo f32 LE) into `out`; non-finite samples become 0.
fn decode_frame(bytes: &[u8], out: &mut Vec<f32>) -> bool {
    if bytes.is_empty() || !bytes.len().is_multiple_of(8) || bytes.len() > MAX_FRAME_FRAMES * 8 {
        return false;
    }
    out.clear();
    out.extend(bytes.as_chunks::<4>().0.iter().map(|b| {
        let s = f32::from_le_bytes(*b);
        if s.is_finite() { s } else { 0.0 }
    }));
    true
}

/// Writes stereo into an interleaved device buffer: L/R on channels 0/1, silence on the rest.
fn write_frames(out: &mut [f32], channels: usize, left: &[f32], right: &[f32]) {
    for ((frame, l), r) in out.chunks_exact_mut(channels).zip(left).zip(right) {
        if channels == 1 {
            frame[0] = 0.5 * (l + r);
        } else {
            frame.fill(0.0);
            frame[0] = *l;
            frame[1] = *r;
        }
    }
}

fn handshake_allowed(path: &str, origin: Option<&str>, token: &str, expected_origin: &str) -> bool {
    path.strip_prefix('/') == Some(token) && origin == Some(expected_origin)
}

// The device callback: prefill, pop, process in chunks ≤ MAX_BLOCK. No allocation, no blocking lock.
struct Render {
    plugin: Arc<Mutex<Plugin>>,
    ring: Consumer<f32>,
    buffers: AudioBuffers,
    prefilling: bool,
    // Lowest fill seen at a callback in the current window, and callbacks left in it.
    min_fill: usize,
    window_left: usize,
    sample_rate: u32,
    link: Arc<Link>,
}

impl Render {
    fn new(plugin: Arc<Mutex<Plugin>>, ring: Consumer<f32>, link: Arc<Link>, sample_rate: u32) -> Self {
        Self { plugin, ring, buffers: AudioBuffers::new(2, 2, MAX_BLOCK, f64::from(sample_rate)), prefilling: true, min_fill: usize::MAX, window_left: 0, sample_rate, link }
    }

    // Drops queued audio down to `keep` frames; returns the fill afterwards.
    fn trim_to(&mut self, available: usize, keep: usize) -> usize {
        if available <= keep {
            return available;
        }
        let Ok(chunk) = self.ring.read_chunk((available - keep) * 2) else { return available };
        chunk.commit_all();
        self.link.trims.fetch_add(1, SeqCst);
        keep
    }

    fn reset_window(&mut self, frames: usize) {
        self.min_fill = usize::MAX;
        self.window_left = (TRIM_WINDOW_SECS * self.sample_rate as usize / frames.max(1)).max(1);
    }

    fn render(&mut self, out: &mut [f32], channels: usize) {
        let frames = out.len() / channels;
        let available = self.ring.slots() / 2;
        self.link.device_frames.store(frames as u32, SeqCst);
        self.link.fill_sum.fetch_add(available as u64, SeqCst);
        self.link.fill_count.fetch_add(1, SeqCst);
        let target = prefill_frames(frames, self.link.cushion_frames.load(SeqCst) as usize);
        let mut available = available;
        if self.prefilling {
            if available < target {
                out.fill(0.0);
                return;
            }
            // Whatever arrived beyond the target while waiting would stay as delay for good.
            self.prefilling = false;
            available = self.trim_to(available, target);
            self.reset_window(frames);
        }
        self.min_fill = self.min_fill.min(available);
        self.window_left = self.window_left.saturating_sub(1);
        if self.window_left == 0 {
            let excess = excess_frames(self.min_fill, target, frames);
            if excess > 0 {
                available = self.trim_to(available, available - excess);
            }
            self.reset_window(frames);
        }
        if available < frames {
            out.fill(0.0);
            self.link.underruns.fetch_add(1, SeqCst);
            self.prefilling = true;
            return;
        }
        // A busy lock (editor/main thread) passes this buffer through dry.
        let mut plugin = match self.plugin.try_lock() {
            Ok(guard) => Some(guard),
            Err(TryLockError::Poisoned(poison)) => Some(poison.into_inner()),
            Err(TryLockError::WouldBlock) => None,
        };
        let mut done = 0;
        while done < frames {
            let n = (frames - done).min(MAX_BLOCK);
            let Ok(chunk) = self.ring.read_chunk(n * 2) else { break };
            for c in 0..2 {
                self.buffers.inputs[c].resize(n, 0.0);
                self.buffers.outputs[c].resize(n, 0.0);
            }
            let (a, b) = chunk.as_slices();
            for (i, s) in a.iter().chain(b).enumerate() {
                self.buffers.inputs[i & 1][i >> 1] = *s;
            }
            chunk.commit_all();
            let wet = plugin.as_mut().is_some_and(|p| p.process_audio(&mut self.buffers).is_ok());
            let src = if wet { &self.buffers.outputs } else { &self.buffers.inputs };
            write_frames(&mut out[done * channels..(done + n) * channels], channels, &src[0], &src[1]);
            done += n;
        }
        self.link.frames_out.fetch_add(frames as u64, SeqCst);
    }
}

// The socket thread: accepts one client, feeds the ring, sends stats; stops the host when it ends.
struct Server {
    generation: u64,
    token: String,
    origin: String,
    sample_rate: u32,
    link: Arc<Link>,
    ring: Producer<f32>,
    main: MainThread,
    // Longest wait between two audio frames since the last stats message (delivery jitter).
    last_frame: Option<Instant>,
    max_gap: Duration,
    session_gap: Duration,
    late: u64,
    first_frame: Option<Instant>, // the warm-up runs from here
}

impl Server {
    fn run(mut self, listener: TcpListener) {
        if let Some(socket) = self.accept(&listener) {
            self.serve(socket);
        }
        stop_generation(self.generation, &self.main);
    }

    fn current(&self) -> bool {
        !self.link.stop.load(SeqCst) && GENERATION.load(SeqCst) == self.generation
    }

    fn accept(&self, listener: &TcpListener) -> Option<WebSocket<TcpStream>> {
        let deadline = Instant::now() + CONNECT_TIMEOUT;
        while self.current() && Instant::now() < deadline {
            match listener.accept() {
                Ok((stream, _)) => {
                    if let Some(socket) = self.handshake(stream) {
                        return Some(socket);
                    }
                }
                Err(e) if e.kind() == ErrorKind::WouldBlock => thread::sleep(POLL),
                Err(_) => return None,
            }
        }
        None
    }

    #[allow(clippy::result_large_err)] // the callback's error type is tungstenite's
    fn handshake(&self, stream: TcpStream) -> Option<WebSocket<TcpStream>> {
        // Accepted sockets inherit the listener's non-blocking mode on macOS.
        stream.set_nonblocking(false).ok()?;
        stream.set_read_timeout(Some(HANDSHAKE_TIMEOUT)).ok()?;
        stream.set_write_timeout(Some(WRITE_TIMEOUT)).ok()?;
        stream.set_nodelay(true).ok()?;
        let check = |request: &Request, response: Response| {
            let origin = request.headers().get("origin").and_then(|v| v.to_str().ok());
            if handshake_allowed(request.uri().path(), origin, &self.token, &self.origin) {
                Ok(response)
            } else {
                let mut refused = ErrorResponse::new(None);
                *refused.status_mut() = StatusCode::FORBIDDEN;
                Err(refused)
            }
        };
        let socket = tungstenite::accept_hdr(stream, check).ok()?;
        socket.get_ref().set_read_timeout(Some(POLL)).ok()?;
        Some(socket)
    }

    fn serve(&mut self, mut socket: WebSocket<TcpStream>) {
        let mut samples = Vec::with_capacity(MAX_FRAME_FRAMES * 2);
        let (mut last_stats, mut last_service) = (Instant::now(), Instant::now());
        while self.current() {
            match socket.read() {
                Ok(Message::Binary(bytes)) => {
                    let now = Instant::now();
                    let first = *self.first_frame.get_or_insert(now);
                    if let Some(last) = self.last_frame.replace(now) {
                        self.note_gap(now - last, now - first);
                    }
                    if !decode_frame(&bytes, &mut samples) {
                        break;
                    }
                    let _ = self.ring.push_entire_slice(&samples); // full ring: drop the frame
                }
                Ok(Message::Close(_)) => break,
                Ok(_) => {}
                Err(tungstenite::Error::Io(e)) if matches!(e.kind(), ErrorKind::WouldBlock | ErrorKind::TimedOut) => {}
                Err(_) => break,
            }
            // Fire and forget: blocking on the main thread here would stall the ring.
            if last_service.elapsed() >= EDITOR_SERVICE_EVERY && !EDITOR_SERVICE_QUEUED.swap(true, SeqCst) {
                last_service = Instant::now();
                let generation = self.generation;
                (self.main)(Box::new(move || service_editor(generation)));
            }
            if last_stats.elapsed() >= STATS_EVERY {
                last_stats = Instant::now();
                if socket.send(Message::text(self.stats())).is_err() {
                    break;
                }
            }
        }
        let _ = socket.close(None);
        let _ = socket.flush();
    }

    fn note_gap(&mut self, gap: Duration, since_first_frame: Duration) {
        self.max_gap = self.max_gap.max(gap);
        self.session_gap = self.session_gap.max(gap);
        self.late += u64::from(gap > LATE_GAP);
        let (current, device_frames) = (self.link.cushion_frames.load(SeqCst), self.link.device_frames.load(SeqCst));
        let next = next_cushion(current, gap, since_first_frame, self.sample_rate, device_frames);
        self.link.cushion_frames.store(next, SeqCst);
    }

    fn stats(&mut self) -> String {
        let max_gap_ms = std::mem::take(&mut self.max_gap).as_secs_f64() * 1000.0;
        let (sum, count) = (self.link.fill_sum.swap(0, SeqCst), self.link.fill_count.swap(0, SeqCst));
        let mean_fill = if count == 0 { 0.0 } else { sum as f64 / count as f64 };
        let (device_frames, plugin_latency) = (self.link.device_frames.load(SeqCst), self.link.plugin_latency.load(SeqCst));
        let latency = latency_ms(mean_fill, plugin_latency, device_frames, self.sample_rate);
        serde_json::json!({
            "ring_fill": mean_fill.round() as u64,
            "underruns": self.link.underruns.load(SeqCst),
            "frames_out": self.link.frames_out.load(SeqCst),
            "sample_rate": self.sample_rate,
            "device_buffer": device_frames,
            "plugin_latency": plugin_latency,
            "trims": self.link.trims.load(SeqCst),
            "max_gap_ms": (max_gap_ms * 10.0).round() / 10.0,
            "gap_session_ms": (self.session_gap.as_secs_f64() * 10_000.0).round() / 10.0,
            "late": self.late,
            "cushion_ms": (self.link.cushion_frames.load(SeqCst).max(PREFILL_EXTRA_FRAMES as u32) as f64 * 10_000.0 / f64::from(self.sample_rate)).round() / 10.0,
            "cushion_max_ms": (cushion_cap(self.sample_rate) as f64 * 10_000.0 / f64::from(self.sample_rate)).round() / 10.0,
            "latency_ms": (latency * 10.0).round() / 10.0,
        })
        .to_string()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn decode_frame_reads_interleaved_le_f32_and_zeroes_non_finite() {
        let bytes: Vec<u8> = [0.5f32, -0.25, f32::NAN, f32::INFINITY].iter().flat_map(|s| s.to_le_bytes()).collect();
        let mut out = Vec::new();
        assert!(decode_frame(&bytes, &mut out));
        assert_eq!(out, [0.5, -0.25, 0.0, 0.0]);
        assert!(decode_frame(&[0; 256 * 8], &mut out));
        assert_eq!(out.len(), 512);
    }

    #[test]
    fn decode_frame_rejects_partial_empty_and_oversized_frames() {
        let mut out = Vec::new();
        assert!(!decode_frame(&[], &mut out));
        assert!(!decode_frame(&[0; 4], &mut out)); // half a stereo frame
        assert!(!decode_frame(&[0; 12], &mut out));
        assert!(!decode_frame(&vec![0; (MAX_FRAME_FRAMES + 1) * 8], &mut out));
    }

    #[test]
    fn validate_in_accepts_only_direct_vst3_directories_of_a_root() {
        let base = std::env::temp_dir().join(format!("cratemind-master-host-{}", uuid::Uuid::new_v4()));
        let root = base.join("VST3");
        for dir in ["Good.vst3", "Upper.VST3", "Nested/Deep.vst3", "Other.component"] {
            std::fs::create_dir_all(root.join(dir)).unwrap();
        }
        std::fs::create_dir_all(base.join("Outside.vst3")).unwrap();
        std::fs::write(root.join("File.vst3"), b"").unwrap();
        let roots = [root.clone()];
        assert_eq!(validate_in(&root.join("Good.vst3"), &roots), Ok(root.join("Good.vst3")));
        assert!(validate_in(&root.join("Upper.VST3"), &roots).is_ok());
        for bad in [
            root.join("File.vst3"),
            root.join("Nested/Deep.vst3"),
            root.join("Other.component"),
            root.join("Missing.vst3"),
            root.join("../Outside.vst3"),
            base.join("Outside.vst3"),
            PathBuf::from("VST3/Good.vst3"),
        ] {
            assert!(validate_in(&bad, &roots).is_err(), "{}", bad.display());
        }
        std::fs::remove_dir_all(base).unwrap();
    }

    #[test]
    fn latency_adds_ring_plugin_and_device_buffer() {
        assert_eq!(latency_ms(1536.0, 0, 512, 48_000), 2048.0 * 1000.0 / 48_000.0);
        assert_eq!(latency_ms(0.0, 441, 0, 44_100), 10.0);
        assert_eq!(prefill_frames(512, 0), 1536);
        assert_eq!(prefill_frames(512, 4000), 5024);
        // The cushion covers the gap plus a quarter, within its limits (120 ms at 48 kHz).
        assert_eq!(cushion_for(Duration::from_millis(8), 44_100), PREFILL_EXTRA_FRAMES);
        assert_eq!(cushion_for(Duration::from_millis(80), 48_000), 4800);
        assert_eq!(cushion_for(Duration::from_secs(5), 48_000), 5760);
        // Excess is dropped only when the lowest fill stayed more than one device buffer above the target.
        assert_eq!(excess_frames(6000, 1536, 512), 4464);
        assert_eq!(excess_frames(2048, 1536, 512), 0);
        assert_eq!(excess_frames(usize::MAX, 1536, 512), 0);
    }

    #[test]
    fn cushion_cap_is_120_ms_and_the_prefill_always_fits_the_ring() {
        assert_eq!(cushion_cap(44_100), 5292);
        assert_eq!(cushion_cap(48_000), 5760);
        assert_eq!(cushion_cap(384_000), MAX_CUSHION_FRAMES);
        assert!(prefill_frames(4096, cushion_cap(384_000)) < RING_FRAMES);
    }

    #[test]
    fn next_cushion_only_grows_after_the_warm_up_and_stays_under_the_cap() {
        let (rate, device, after) = (48_000, 512, Duration::from_secs(10));
        let ms = Duration::from_millis;
        // The warm-up and a gap longer than cap + device buffer (5760 + 512 frames) leave it alone.
        assert_eq!(next_cushion(0, ms(50), ms(2900), rate, device), 0);
        assert_eq!(next_cushion(1000, ms(140), after, rate, device), 1000);
        // It grows to cover a gap, and a smaller gap later never shrinks it.
        assert_eq!(next_cushion(0, ms(50), WARMUP, rate, device), 3000);
        assert_eq!(next_cushion(3000, ms(8), after, rate, device), 3000);
        assert_eq!(next_cushion(3000, ms(60), after, rate, device), 3600);
        // A gap the cap still rides out raises it to the cap, never past it.
        assert_eq!(next_cushion(3000, ms(125), after, rate, device), 5760);
        assert_eq!(next_cushion(5760, ms(130), after, rate, device), 5760);
    }

    #[test]
    fn state_file_needs_a_32_hex_digit_uid() {
        let dir = Path::new("/state");
        let uid = "0123456789abcdefABCDEF0123456789";
        assert_eq!(state_file(dir, uid), Some(dir.join(format!("{uid}.state"))));
        for bad in ["", "0123456789abcdef", "0123456789abcdefABCDEF012345678g", "../3456789abcdefABCDEF0123456789", "0123456789abcdefABCDEF01234567890"] {
            assert_eq!(state_file(dir, bad), None, "{bad}");
        }
    }

    #[test]
    fn state_round_trips_and_every_damaged_file_is_refused() {
        let (uid, other) = ("0123456789abcdef0123456789ABCDEF", "fedcba9876543210fedcba9876543210");
        let blob = b"plugin state".to_vec();
        let bytes = encode_state(uid, &blob);
        assert_eq!(bytes.len(), STATE_HEADER + blob.len());
        assert_eq!(decode_state(&bytes, uid), Ok(blob.as_slice()));
        assert_eq!(decode_state(&encode_state(uid, &[]), uid), Ok(&[][..]));
        assert!(decode_state(&bytes, other).is_err());
        assert!(decode_state(&bytes[..STATE_HEADER - 1], uid).is_err());
        assert!(decode_state(&encode_state(uid, &vec![0; MAX_STATE_BYTES + 1]), uid).is_err());
        let damaged = |at: usize| {
            let mut bad = bytes.clone();
            bad[at] ^= 1;
            decode_state(&bad, uid).map(<[u8]>::to_vec)
        };
        assert_eq!(damaged(0), Err("not a CrateMind state file"));
        assert_eq!(damaged(8), Err("another plugin's state"));
        assert_eq!(damaged(40), Err("checksum mismatch"));
        assert_eq!(damaged(STATE_HEADER), Err("checksum mismatch"));
        // The FNV-1a 64 reference values.
        assert_eq!(fnv1a64(b""), 0xcbf2_9ce4_8422_2325);
        assert_eq!(fnv1a64(b"a"), 0xaf63_dc4c_8601_ec8c);
    }

    #[test]
    fn state_files_are_saved_restored_and_set_aside_when_rejected() {
        let dir = std::env::temp_dir().join(format!("cratemind-master-host-state-{}", uuid::Uuid::new_v4()));
        let (uid, other) = ("0123456789abcdef0123456789abcdef", "fedcba9876543210fedcba9876543210");
        let file = state_file(&dir.join("master-host"), uid).unwrap();
        let rejected = file.with_extension("state.rejected");
        assert_eq!(read_state(&file, uid), None); // missing: not restored, nothing set aside
        assert!(!rejected.exists());
        write_state(&file, uid, b"first").unwrap(); // creates the folder
        write_state(&file, uid, b"second").unwrap();
        assert_eq!(read_state(&file, uid).as_deref(), Some(&b"second"[..]));
        assert!(!file.with_extension("state.tmp").exists());
        // A blob over the limit is refused and the previous file kept.
        assert!(write_state(&file, uid, &vec![0; MAX_STATE_BYTES + 1]).is_err());
        assert_eq!(read_state(&file, uid).as_deref(), Some(&b"second"[..]));
        // A file over the read limit, or written for another plugin, is renamed aside (one copy kept).
        std::fs::write(&file, vec![0; STATE_HEADER + MAX_STATE_BYTES + 1]).unwrap();
        assert_eq!(read_state(&file, uid), None);
        assert!(!file.exists() && rejected.exists());
        std::fs::write(&file, encode_state(other, b"theirs")).unwrap();
        assert_eq!(read_state(&file, uid), None);
        assert!(!file.exists());
        assert_eq!(std::fs::read(&rejected).unwrap(), encode_state(other, b"theirs"));
        // A file that exists but cannot be read is set aside too, so teardown's save cannot overwrite it.
        std::fs::remove_file(&rejected).unwrap();
        std::fs::create_dir(&file).unwrap(); // opens, but the read fails (not NotFound)
        assert_eq!(read_state(&file, uid), None);
        assert!(!file.exists() && rejected.is_dir());
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn write_frames_puts_stereo_on_the_first_two_channels() {
        let mut out = [9.0; 8];
        write_frames(&mut out, 4, &[0.1, 0.2], &[0.3, 0.4]);
        assert_eq!(out, [0.1, 0.3, 0.0, 0.0, 0.2, 0.4, 0.0, 0.0]);
        let mut stereo = [0.0; 4];
        write_frames(&mut stereo, 2, &[0.1, 0.2], &[0.3, 0.4]);
        assert_eq!(stereo, [0.1, 0.3, 0.2, 0.4]);
        let mut mono = [0.0; 2];
        write_frames(&mut mono, 1, &[0.2, 1.0], &[0.4, 0.0]);
        assert_eq!(mono, [0.5 * (0.2 + 0.4), 0.5]);
    }

    #[test]
    fn fit_reply_keeps_the_scan_record_under_the_protocol_limit() {
        let entry = |i: usize| PluginEntry {
            name: format!("{i:05}{}", "ä".repeat(200)),
            path: PathBuf::from(format!("/Library/Audio/Plug-Ins/VST3/{i:05}{}.vst3", "x".repeat(200))),
        };
        let kept = fit_reply((0..3000).map(entry).collect());
        assert!(!kept.is_empty() && kept.len() < 3000);
        assert_eq!(kept[0].name, entry(0).name);
        let record = crate::native_actions::result_record("id", Ok((false, serde_json::json!(kept))));
        assert!(record.to_string().len() <= crate::protocol::MAX_RECORD);
        assert_eq!(fit_reply((0..3).map(entry).collect()).len(), 3);
    }

    #[test]
    fn handshake_needs_the_token_path_and_the_exact_origin() {
        let origin = "http://127.0.0.1:8123";
        assert!(handshake_allowed("/abc", Some(origin), "abc", origin));
        assert!(!handshake_allowed("/abc", None, "abc", origin));
        assert!(!handshake_allowed("/abc", Some("http://127.0.0.1:9999"), "abc", origin));
        assert!(!handshake_allowed("/abd", Some(origin), "abc", origin));
        assert!(!handshake_allowed("/abc/x", Some(origin), "abc", origin));
        assert!(!handshake_allowed("abc", Some(origin), "abc", origin));
    }
}

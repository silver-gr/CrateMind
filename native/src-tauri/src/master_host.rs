//! Experimental VST3 master host (macOS): the page streams the master bus over a local
//! WebSocket into a ring, a VST3 plugin processes it and cpal plays it on the default output.
//! Plugin load, editor and teardown run on the main thread through a `MainThread` dispatcher.
use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
use rtrb::{Consumer, Producer, RingBuffer};
use std::{
    cell::RefCell,
    io::ErrorKind,
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
const PREFILL_EXTRA_FRAMES: usize = 512; // ring prefill = 2 device buffers + this (tunable)
const RING_FRAMES: usize = 16_384; // a full ring drops incoming frames
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
}

struct Session {
    generation: u64,
    window: Option<PluginWindow>,
    stream: cpal::Stream,
    plugin: Arc<Mutex<Plugin>>,
    link: Arc<Link>,
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
/// A running host is replaced. `path` must already be validated by the caller.
pub fn start(path: &Path, sample_rate: u32, origin: &str, listener: &TcpListener, main: &MainThread) -> Result<Started, String> {
    let generation = GENERATION.fetch_add(1, SeqCst) + 1;
    let socket_err = logged::<std::io::Error>("Η τοπική σύνδεση ήχου απέτυχε.");
    let port = listener.local_addr().map_err(socket_err)?.port();
    let listener = listener.try_clone().map_err(socket_err)?;
    listener.set_nonblocking(true).map_err(socket_err)?;
    let (ring, consumer) = RingBuffer::new(RING_FRAMES * 2);
    let link = Arc::new(Link::default());
    let (path, main_link) = (path.to_path_buf(), link.clone());
    let loaded = on_main(main, LOAD_TIMEOUT, move || load_session(generation, &path, sample_rate, consumer, main_link));
    let (name, latency_samples) = match loaded {
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
    let server = Server { generation, token: token.clone(), origin: origin.to_owned(), sample_rate, latency_samples, link, ring, main: main.clone(), last_frame: None, max_gap: Duration::ZERO };
    thread::spawn(move || server.run(listener));
    Ok(Started { token, port, latency_samples, name })
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
    let plugin = Arc::new(Mutex::new(load(path, sample_rate)?));
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

fn load(path: &Path, sample_rate: u32) -> Result<Plugin, String> {
    let failed = logged::<vst3_host::Error>("Το plugin δεν φορτώθηκε.");
    let mut host = Vst3Host::builder().sample_rate(f64::from(sample_rate)).block_size(MAX_BLOCK).build().map_err(failed)?;
    let mut plugin = host.load_plugin(path).map_err(failed)?;
    plugin.start_processing().map_err(failed)?;
    Ok(plugin)
}

fn describe(plugin: &Mutex<Plugin>) -> (String, u32) {
    let plugin = plugin.lock().unwrap_or_else(|p| p.into_inner());
    (plugin.info().name.clone(), plugin.latency_samples())
}

// Main thread.
fn load_session(generation: u64, path: &Path, sample_rate: u32, ring: Consumer<f32>, link: Arc<Link>) -> Result<(String, u32), String> {
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
    let plugin = Arc::new(Mutex::new(load(path, sample_rate)?));
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
    let session = Session { generation, window: None, stream, plugin, link };
    if GENERATION.load(SeqCst) != generation {
        teardown(session);
        return Err(SUPERSEDED.into());
    }
    SESSION.with(|s| *s.borrow_mut() = Some(session));
    Ok((name, latency_samples))
}

// Main thread. `None` takes any session.
fn take_session(generation: Option<u64>) -> Option<Session> {
    SESSION.with(|s| {
        let mut s = s.borrow_mut();
        if generation.is_none_or(|g| s.as_ref().is_some_and(|s| s.generation == g)) { s.take() } else { None }
    })
}

// Main thread. Editor window, then the stream (and its callback), then the last plugin reference.
fn teardown(session: Session) {
    session.link.stop.store(true, SeqCst);
    let Session { window, stream, plugin, .. } = session;
    drop(window);
    drop(stream);
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
        };
    });
}

// Stops the host only if no newer start/stop happened since `generation` began.
fn stop_generation(generation: u64, main: &MainThread) {
    if GENERATION.compare_exchange(generation, generation + 1, SeqCst, SeqCst).is_ok() {
        let _ = on_main(main, MAIN_TIMEOUT, move || take_session(Some(generation)).map(teardown));
    }
}

fn prefill_frames(device_frames: usize) -> usize {
    2 * device_frames + PREFILL_EXTRA_FRAMES
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
        let target = prefill_frames(frames);
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
    latency_samples: u32,
    link: Arc<Link>,
    ring: Producer<f32>,
    main: MainThread,
    // Longest wait between two audio frames since the last stats message (delivery jitter).
    last_frame: Option<Instant>,
    max_gap: Duration,
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
                    if let Some(last) = self.last_frame.replace(now) {
                        self.max_gap = self.max_gap.max(now - last);
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

    fn stats(&mut self) -> String {
        let max_gap_ms = std::mem::take(&mut self.max_gap).as_secs_f64() * 1000.0;
        let (sum, count) = (self.link.fill_sum.swap(0, SeqCst), self.link.fill_count.swap(0, SeqCst));
        let mean_fill = if count == 0 { 0.0 } else { sum as f64 / count as f64 };
        let device_frames = self.link.device_frames.load(SeqCst);
        let latency = latency_ms(mean_fill, self.latency_samples, device_frames, self.sample_rate);
        serde_json::json!({
            "ring_fill": mean_fill.round() as u64,
            "underruns": self.link.underruns.load(SeqCst),
            "frames_out": self.link.frames_out.load(SeqCst),
            "sample_rate": self.sample_rate,
            "device_buffer": device_frames,
            "plugin_latency": self.latency_samples,
            "trims": self.link.trims.load(SeqCst),
            "max_gap_ms": (max_gap_ms * 10.0).round() / 10.0,
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
        assert_eq!(prefill_frames(512), 1536);
        // Excess is dropped only when the lowest fill stayed more than one device buffer above the target.
        assert_eq!(excess_frames(6000, 1536, 512), 4464);
        assert_eq!(excess_frames(2048, 1536, 512), 0);
        assert_eq!(excess_frames(usize::MAX, 1536, 512), 0);
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

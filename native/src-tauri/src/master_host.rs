//! Experimental VST3 host (macOS): the page streams each deck's audio over a local WebSocket into a
//! ring; Deck A, Deck B and Master each pass through their own VST3 slot, aligned by plugin delay
//! compensation (PDC), and cpal plays the mix on the default output.
//! Plugin load, editor and teardown run on the main thread through a `MainThread` dispatcher.
use crate::native_actions::HostSlot;
use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
use rtrb::{Consumer, Producer, RingBuffer};
use std::{
    cell::RefCell,
    collections::{BTreeMap, BTreeSet},
    ffi::CString,
    io::{ErrorKind, Read, Write},
    net::{TcpListener, TcpStream},
    os::unix::ffi::OsStrExt,
    path::{Component, Path, PathBuf},
    sync::{
        atomic::{AtomicBool, AtomicU32, AtomicU64, AtomicU8, Ordering::SeqCst},
        mpsc, Arc, Mutex, MutexGuard, TryLockError,
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

const CH: usize = 4; // samples per ring frame: Deck A left and right, then Deck B left and right
const FRAME_HEADER: usize = 32; // each binary frame's per-deck transport header: reserved, zero in stage 1
const MAX_BLOCK: usize = 512; // plugin max block; device buffers are processed in chunks of this
const PREFILL_EXTRA_FRAMES: usize = 512; // smallest cushion: ring prefill = 2 device buffers + the cushion
const MAX_CUSHION_FRAMES: usize = 16_384; // largest cushion at any rate: above ~250 kHz, 120 ms would not fit the ring
const MAX_CUSHION_SECS: f64 = 0.12; // largest cushion the delivery jitter may ask for
const RING_FRAMES: usize = 32_768; // a full ring drops incoming frames
const LATE_GAP: Duration = Duration::from_millis(20); // a wait between audio frames counted as late
const WARMUP: Duration = Duration::from_secs(3); // gaps while the page starts streaming leave the cushion alone
const TRIM_WINDOW_SECS: usize = 2; // how long the fill must stay above the target before the excess is dropped
const MAX_FRAME_FRAMES: usize = 4096; // largest binary frame accepted (frames)
const STEP_TIMEOUT: Duration = Duration::from_secs(20); // the longest wait for one main-thread step of a start
const START_BUDGET: Duration = Duration::from_secs(60); // the whole start, under the page's 65 s
const MAIN_TIMEOUT: Duration = Duration::from_secs(20);
const CONNECT_TIMEOUT: Duration = Duration::from_secs(5); // no client by then: the host stops itself
const HANDSHAKE_TIMEOUT: Duration = Duration::from_secs(2);
const WRITE_TIMEOUT: Duration = Duration::from_secs(1);
const POLL: Duration = Duration::from_millis(20);
const STATS_EVERY: Duration = Duration::from_millis(500);
const SERVICE_OPEN_EVERY: Duration = Duration::from_millis(33); // while a plugin window is open
const SERVICE_EVERY: Duration = Duration::from_millis(250); // otherwise, and for every slot without an open window
const PDC_MAX_FRAMES: u32 = 16_384; // with a quarter second: the budget for D + L_master
const ERROR_RUN: u32 = 8; // process errors in a row that bypass a slot
const SLOW_RUN: u32 = 32; // overloaded chunks (or callbacks) in a row that bypass a slot
const SLOW_SHARE: f64 = 0.5; // a slot's own share of its chunk's time
const CALLBACK_SHARE: f64 = 0.9; // the whole callback's share of its buffer's time
const WEDGED_AFTER: Duration = Duration::from_secs(1); // a callback inside a plugin this long is stuck
const REPLY_BUDGET: usize = 96 * 1024; // the scan's NATIVE_RESULT line must stay under protocol::MAX_RECORD
const STATE_MAGIC: &[u8; 8] = b"CMVST3S1";
const STATE_HEADER: usize = 48; // magic | uid (32 ASCII hex digits) | FNV-1a 64 of the blob (u64 LE)
const MAX_STATE_BYTES: usize = 16 * 1024 * 1024; // largest plugin state blob saved or restored
const FAULT_NONE: u8 = 0;
const FAULT_ERROR: u8 = 1;
const FAULT_SLOW: u8 = 2;
const FAULT_RELOAD: u8 = 3;
const NOT_RUNNING: &str = "Τα plugins VST3 δεν τρέχουν.";
const SUPERSEDED: &str = "Η φόρτωση του plugin ακυρώθηκε.";
const LOAD_FAILED: &str = "Το plugin δεν φορτώθηκε (ίσως χρειάζεται ενεργοποίηση άδειας).";
const TOO_LATE: &str = "Η καθυστέρηση του plugin είναι πολύ μεγάλη για ευθυγράμμιση.";
const EMPTY_SLOT: &str = "Το slot είναι άδειο.";
const RELOAD: &str = "Το plugin ζήτησε επαναφόρτωση· σταμάτησε και ξεκίνησε ξανά τα plugins.";
const NO_PLUGIN: &str = "Διάλεξε τουλάχιστον ένα plugin.";
const RESTART_FAILED: &str = "Το plugin δεν ξεκίνησε ξανά.";

/// Bumped by every start and stop; a load or socket thread of an older generation unwinds itself.
static GENERATION: AtomicU64 = AtomicU64::new(0);
/// Set while a service task waits for the main thread, so a busy main thread never piles them up.
static SERVICE_QUEUED: AtomicBool = AtomicBool::new(false);

thread_local! {
    // Main thread only: the running plugins, their stream and their editor windows.
    static SESSION: RefCell<Option<Session>> = const { RefCell::new(None) };
    // Main thread only: the plugins a start has loaded so far, before its stream exists.
    static STAGING: RefCell<Option<Staging>> = const { RefCell::new(None) };
}

#[derive(Debug, Clone, serde::Serialize)]
pub struct PluginEntry {
    pub name: String,
    pub path: PathBuf,
}

/// One slot's start result; a slot that failed stays empty and the others go on.
#[derive(Debug, Clone, PartialEq, serde::Serialize)]
#[serde(untagged)]
pub enum SlotReply {
    Loaded { name: String, latency_samples: u32, restored: bool },
    Failed { error: String },
}

#[derive(Debug, Clone, serde::Serialize)]
pub struct Started {
    pub token: String,
    pub port: u16,
    /// Keyed by `HostSlot::key`; `None` (null) for a slot that was not asked for.
    pub slots: BTreeMap<&'static str, Option<SlotReply>>,
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

/// The time base of `Link::entered`.
struct Epoch(Instant);

impl Default for Epoch {
    fn default() -> Self {
        Self(Instant::now())
    }
}

impl Epoch {
    /// Nanoseconds since the epoch, plus one, so a stamp is never 0 (0 means "not inside").
    fn stamp(&self, at: Instant) -> u64 {
        at.saturating_duration_since(self.0).as_nanos() as u64 + 1
    }
}

// Shared by the audio callback, the socket thread and the main thread; counters only, no locks.
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
    // D + L_master: what the plugins add to the output's latency (the page's visual delay follows it).
    plugin_latency: AtomicU32,
    // D: both decks come out this late, the highest deck slot latency of the session.
    pdc: AtomicU32,
    // Highest whole-callback load (‰ of its buffer's time) since the last stats.
    callback_permille: AtomicU32,
    // Set (an `Epoch` stamp) while the callback runs, cleared on every exit.
    entered: AtomicU64,
    base: Epoch,
    // A plugin window is open: the service runs every 33 ms instead of 250 ms.
    windows_open: AtomicBool,
}

/// What the audio callback, the socket thread and the main thread share about one slot. The name and
/// uid are set at start and never change; the atomics carry the live state.
#[derive(Default)]
struct SlotShared {
    loaded: bool,
    name: String,
    uid: String,
    bypass: AtomicBool,
    fault: AtomicU8,
    // L: what the slot's dry path is aligned to.
    latency: AtomicU32,
    // Highest per-callback load (‰ of the buffer's time) since the last stats.
    load_permille: AtomicU32,
}

impl SlotShared {
    /// Every fault bypasses the slot; a reload request is never replaced by a lesser fault.
    fn trip(&self, fault: u8) {
        self.bypass.store(true, SeqCst);
        if self.fault.load(SeqCst) != FAULT_RELOAD {
            self.fault.store(fault, SeqCst);
        }
    }

    /// Bypassed by the user, not by a fault: the callback still feeds it (its output unused).
    fn user_bypassed(&self) -> bool {
        self.bypass.load(SeqCst) && self.fault.load(SeqCst) == FAULT_NONE
    }

    /// Bypassed by a fault: the callback no longer calls it, as it may be broken or slow.
    fn fault_bypassed(&self) -> bool {
        self.bypass.load(SeqCst) && self.fault.load(SeqCst) != FAULT_NONE
    }
}

type Slots = Arc<[SlotShared; 3]>;
/// Indexed by `HostSlot::index`; the audio callback only borrows them under `try_lock`.
type Plugins = [Option<Arc<Mutex<Plugin>>>; 3];

/// What the callback and un-bypass ask of a slot's plugin (a fake stands in for it in the tests).
trait Processor {
    /// One chunk; true when the plugin processed it.
    fn process(&mut self, buffers: &mut AudioBuffers) -> bool;
    fn latency(&self) -> u32;
    /// Stop and start processing (main thread): the plugin drops what its delay line still holds.
    fn restart(&mut self) -> Result<(), String>;
}

impl Processor for Plugin {
    fn process(&mut self, buffers: &mut AudioBuffers) -> bool {
        self.process_audio(buffers).is_ok()
    }

    fn latency(&self) -> u32 {
        self.latency_samples()
    }

    fn restart(&mut self) -> Result<(), String> {
        let failed = logged::<vst3_host::Error>(RESTART_FAILED);
        self.stop_processing().map_err(failed)?;
        self.start_processing().map_err(failed)
    }
}

struct Session {
    generation: u64,
    windows: [Option<PluginWindow>; 3],
    stream: cpal::Stream,
    plugins: Plugins,
    slots: Slots,
    link: Arc<Link>,
    // Each slot's state file, saved by teardown; `None` for an empty slot or a plugin without a usable uid.
    states: [Option<PathBuf>; 3],
    sample_rate: u32,
    serviced: [Instant; 3],
    // Each plugin's latency when it was last read.
    reported: [u32; 3],
}

struct Staged {
    plugin: Plugin,
    state: Option<PathBuf>,
    name: String,
    uid: String,
}

struct Staging {
    generation: u64,
    slots: [Option<Staged>; 3],
    pdc: Pdc,
}

/// The alignment: each slot's latency `L`, and `d` (D), the highest deck slot latency so far.
#[derive(Debug, Clone, Copy, Default, PartialEq)]
struct Pdc {
    latency: [u32; 3],
    d: u32,
}

impl Pdc {
    /// D + L_master: what the plugins add to the output's latency.
    fn total(self) -> u32 {
        self.d + self.latency[HostSlot::Master.index()]
    }
}

/// The budget for D + L_master: 16,384 frames, and at most a quarter second.
fn pdc_budget(sample_rate: u32) -> u32 {
    PDC_MAX_FRAMES.min(sample_rate / 4)
}

/// A slot's latency becomes `latency` (at load, or when the plugin changes it): a deck slot raises D
/// to it (D never shrinks within a session), and D + L_master must stay within `budget`. Over the
/// budget nothing changes.
fn apply_latency(pdc: Pdc, slot: HostSlot, latency: u32, budget: u32) -> Result<Pdc, &'static str> {
    let mut next = pdc;
    next.latency[slot.index()] = latency;
    if slot.is_deck() {
        next.d = next.d.max(latency);
    }
    let total = u64::from(next.d) + u64::from(next.latency[HostSlot::Master.index()]);
    if total > u64::from(budget) { Err(TOO_LATE) } else { Ok(next) }
}

/// Un-bypass: refused after a reload request, and while the plugin's latency breaks the budget.
fn unbypass(fault: u8, pdc: Pdc, slot: HostSlot, latency: u32, budget: u32) -> Result<Pdc, &'static str> {
    if fault == FAULT_RELOAD {
        return Err(RELOAD);
    }
    apply_latency(pdc, slot, latency, budget)
}

fn read_pdc(slots: &[SlotShared; 3], link: &Link) -> Pdc {
    Pdc { latency: [0, 1, 2].map(|i| slots[i].latency.load(SeqCst)), d: link.pdc.load(SeqCst) }
}

// D first: the callback never sees a deck slot's L above D for long, and `align` clamps it anyway.
fn store_pdc(pdc: Pdc, slots: &[SlotShared; 3], link: &Link) {
    link.pdc.store(pdc.d, SeqCst);
    for (slot, latency) in slots.iter().zip(pdc.latency) {
        slot.latency.store(latency, SeqCst);
    }
    link.plugin_latency.store(pdc.total(), SeqCst);
}

/// `<state_dir>` keeps the master slot's state files (as before the deck slots existed); each deck
/// keeps its own in a subfolder, so the same plugin on two slots keeps two states.
pub fn slot_state_dir(state_dir: &Path, slot: HostSlot) -> PathBuf {
    match slot {
        HostSlot::Master => state_dir.to_path_buf(),
        HostSlot::DeckA => state_dir.join("deck-a"),
        HostSlot::DeckB => state_dir.join("deck-b"),
    }
}

/// Keeps a loaded bundle's code mapped for the app's lifetime: one `dlopen(RTLD_NOLOAD)` handle per
/// bundle, never closed. Each plugin instance's module unloads the bundle's executable when it is
/// dropped; with this handle that cannot unmap the code of another instance of the same plugin.
/// True when the bundle is pinned.
fn pin_bundle(bundle: &Path) -> bool {
    static PINNED: Mutex<BTreeSet<PathBuf>> = Mutex::new(BTreeSet::new());
    let mut pinned = PINNED.lock().unwrap_or_else(|p| p.into_inner());
    if pinned.contains(bundle) {
        return true;
    }
    let Ok(entries) = std::fs::read_dir(bundle.join("Contents/MacOS")) else { return false };
    let mut held = false;
    for entry in entries.flatten() {
        let Ok(file) = CString::new(entry.path().as_os_str().as_bytes()) else { continue };
        // SAFETY: RTLD_NOLOAD never loads anything or runs an initialiser; it only adds a reference to
        // an image that is already loaded (null otherwise). The handle is deliberately never closed.
        let handle = unsafe { libc::dlopen(file.as_ptr(), libc::RTLD_LAZY | libc::RTLD_NOLOAD) };
        held |= !handle.is_null();
    }
    if held {
        pinned.insert(bundle.to_path_buf());
    } else {
        eprintln!("CrateMind master host: plugin code not pinned: {}", bundle.display());
    }
    held
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

/// Loads each slot's plugin on the main thread (Deck A, Deck B, then Master) and starts playing the
/// mix on the default output, fed by the WebSocket client that connects to `listener` (put in
/// non-blocking mode) at `/<token>` with `Origin: origin`. Refuses before loading when the device
/// rate is not `sample_rate`. A running host is replaced. The paths must already be validated by the
/// caller. A slot that fails to load (or breaks the PDC budget) is reported and stays empty; the start
/// fails only when every requested slot fails. With `state_dir`, each slot's plugin state is restored
/// from its folder at load and saved to it at teardown.
pub fn start(paths: &[Option<PathBuf>; 3], sample_rate: u32, origin: &str, listener: &TcpListener, main: &MainThread, state_dir: Option<&Path>) -> Result<Started, String> {
    if paths.iter().all(Option::is_none) {
        return Err(NO_PLUGIN.into());
    }
    let generation = GENERATION.fetch_add(1, SeqCst) + 1;
    let deadline = Instant::now() + START_BUDGET;
    let socket_err = logged::<std::io::Error>("Η τοπική σύνδεση ήχου απέτυχε.");
    let port = listener.local_addr().map_err(socket_err)?.port();
    let listener = listener.try_clone().map_err(socket_err)?;
    listener.set_nonblocking(true).map_err(socket_err)?;
    start_step(generation, main, deadline, move || prepare(generation, sample_rate))?;
    let mut replies: [Option<SlotReply>; 3] = Default::default();
    for slot in HostSlot::ALL {
        let Some(path) = paths[slot.index()].clone() else { continue };
        let dir = state_dir.map(|dir| slot_state_dir(dir, slot));
        let reply = start_step(generation, main, deadline, move || stage_slot(generation, slot, &path, sample_rate, dir.as_deref()))?;
        replies[slot.index()] = Some(reply);
    }
    if let Some(error) = all_failed(&replies) {
        abandon(generation, main);
        return Err(error);
    }
    let (ring, consumer) = RingBuffer::new(RING_FRAMES * CH);
    let link = Arc::new(Link::default());
    let build_link = link.clone();
    let slots = start_step(generation, main, deadline, move || build(generation, sample_rate, consumer, build_link))?;
    let token = uuid::Uuid::new_v4().simple().to_string();
    let server = Server { generation, token: token.clone(), origin: origin.to_owned(), sample_rate, link, slots, ring, main: main.clone(), last_frame: None, max_gap: Duration::ZERO, session_gap: Duration::ZERO, late: 0, first_frame: None };
    thread::spawn(move || server.run(listener));
    let slots = HostSlot::ALL.into_iter().zip(replies).map(|(slot, reply)| (slot.key(), reply)).collect();
    Ok(Started { token, port, slots })
}

/// The first slot error when every requested slot failed (none requested counts as failed too).
fn all_failed(replies: &[Option<SlotReply>; 3]) -> Option<String> {
    let mut first = None;
    for reply in replies.iter().flatten() {
        match reply {
            SlotReply::Loaded { .. } => return None,
            SlotReply::Failed { error } => {
                first.get_or_insert_with(|| error.clone());
            }
        }
    }
    Some(first.unwrap_or_else(|| NO_PLUGIN.into()))
}

/// One main-thread step of a start, within what is left of its 60 s budget (at most 20 s). A timeout
/// or an error abandons the whole start: when main is stuck, later steps would only queue behind it.
fn start_step<T: Send + 'static>(generation: u64, main: &MainThread, deadline: Instant, f: impl FnOnce() -> Result<T, String> + Send + 'static) -> Result<T, String> {
    let wait = deadline.saturating_duration_since(Instant::now()).min(STEP_TIMEOUT);
    let result = on_main(main, wait, f).and_then(|result| result);
    if result.is_err() {
        abandon(generation, main);
    }
    result
}

/// Ends a start of `generation`: the generation moves on (a late load sees it and unloads itself) and
/// main drops what that start staged (never played, so not saved) or tears down what it built.
fn abandon(generation: u64, main: &MainThread) {
    let _ = GENERATION.compare_exchange(generation, generation + 1, SeqCst, SeqCst);
    main(Box::new(move || {
        drop(take_staging(Some(generation)));
        if let Some(session) = take_session(Some(generation)) {
            teardown(session);
        }
    }));
}

/// Stops the host (editor windows, then the stream, then the plugins, on the main thread).
pub fn stop(main: &MainThread) -> Result<(), String> {
    GENERATION.fetch_add(1, SeqCst);
    on_main(main, MAIN_TIMEOUT, || {
        drop(take_staging(None));
        take_session(None).map(teardown)
    })
    .map(|_| ())
}

/// Opens (or re-opens) a slot's plugin editor window. The crate titles every window «{name} - VST3»,
/// so another slot's open window of the same plugin is closed first: two would look identical.
pub fn open_editor(main: &MainThread, slot: HostSlot) -> Result<(), String> {
    on_main(main, MAIN_TIMEOUT, move || {
        let i = slot.index();
        let (generation, plugin, old) = SESSION.with(|s| {
            let mut s = s.borrow_mut();
            let s = s.as_mut().ok_or(NOT_RUNNING)?;
            let plugin = s.plugins[i].clone().ok_or(EMPTY_SLOT)?;
            let uid = s.slots[i].uid.clone();
            let old: Vec<PluginWindow> = (0..3).filter(|&j| j == i || s.slots[j].uid == uid).filter_map(|j| s.windows[j].take()).collect();
            Ok::<_, &str>((s.generation, plugin, old))
        })?;
        drop(old); // detach the previous editors before attaching a new one
        let mut window = PluginWindow::new(plugin);
        window.open().map_err(logged("Το παράθυρο του plugin δεν άνοιξε."))?;
        SESSION.with(|s| match s.borrow_mut().as_mut() {
            Some(s) if s.generation == generation => {
                s.windows[i] = Some(window);
                s.link.windows_open.store(true, SeqCst);
                Ok(())
            }
            _ => Err(NOT_RUNNING.to_string()),
        })
    })?
}

/// Bypasses a slot, or brings it back: un-bypass clears an error or slow fault, is refused after a
/// reload request, and re-reads the plugin's latency through the PDC rule (refused while over budget).
pub fn set_bypass(main: &MainThread, slot: HostSlot, bypassed: bool) -> Result<(), String> {
    on_main(main, MAIN_TIMEOUT, move || {
        SESSION.with(|s| {
            let mut s = s.borrow_mut();
            let s = s.as_mut().ok_or(NOT_RUNNING)?;
            let i = slot.index();
            let plugin = s.plugins[i].clone().ok_or(EMPTY_SLOT)?;
            if bypassed {
                s.slots[i].bypass.store(true, SeqCst);
                return Ok(());
            }
            resume(&plugin, &s.slots, &s.link, slot, pdc_budget(s.sample_rate), &mut s.reported[i])
        })
    })?
}

/// Un-bypass under the plugin's lock. A slot a fault bypassed was not fed, so its delay line still
/// holds the audio from before the fault: it restarts first and un-bypass replays at most L frames of
/// silence. A refusal leaves the slot bypassed and its fault as it was.
fn resume<P: Processor>(plugin: &Mutex<P>, slots: &[SlotShared; 3], link: &Link, slot: HostSlot, budget: u32, reported: &mut u32) -> Result<(), String> {
    let shared = &slots[slot.index()];
    let fault = shared.fault.load(SeqCst);
    let latency = {
        let mut plugin = plugin.lock().unwrap_or_else(|p| p.into_inner());
        if shared.bypass.load(SeqCst) && matches!(fault, FAULT_ERROR | FAULT_SLOW) {
            plugin.restart()?;
        }
        plugin.latency()
    };
    *reported = latency;
    let pdc = unbypass(fault, read_pdc(slots, link), slot, latency, budget)?;
    store_pdc(pdc, slots, link);
    shared.fault.store(FAULT_NONE, SeqCst);
    shared.bypass.store(false, SeqCst);
    Ok(())
}

/// The offline rig: `path` loaded into `slot` on the calling (main) thread, and the render path the
/// device callback runs, fed through the ring by the caller.
struct Rig {
    ring: Producer<f32>,
    render: Render,
    link: Arc<Link>,
    name: String,
    latency: u32,
    pinned: bool,
}

fn offline_rig(slot: HostSlot, path: &Path, sample_rate: u32) -> Result<Rig, String> {
    let (plugin, _) = load(path, sample_rate, None)?;
    let pinned = pin_bundle(path);
    let (name, latency) = (plugin.info().name.clone(), plugin.latency_samples());
    let pdc = apply_latency(Pdc::default(), slot, latency, pdc_budget(sample_rate))?;
    let mut plugins: Plugins = Default::default();
    plugins[slot.index()] = Some(Arc::new(Mutex::new(plugin)));
    let mut shared: [SlotShared; 3] = Default::default();
    shared[slot.index()] = SlotShared { loaded: true, name: name.clone(), ..Default::default() };
    let slots: Slots = Arc::new(shared);
    let link = Arc::new(Link::default());
    store_pdc(pdc, &slots, &link);
    let (ring, consumer) = RingBuffer::new(RING_FRAMES * CH);
    let render = Render::new(plugins, slots, consumer, link.clone(), sample_rate);
    Ok(Rig { ring, render, link, name, latency, pinned })
}

/// Loads `path` into the master slot on the calling (main) thread and pushes interleaved stereo
/// `input` (on Deck A) through the same ring and render path as the device callback, in
/// `device_frames` blocks, without a device.
pub fn offline_check(path: &Path, sample_rate: u32, device_frames: usize, input: &[f32]) -> Result<OfflineReport, String> {
    let Rig { mut ring, mut render, link, name, latency, .. } = offline_rig(HostSlot::Master, path, sample_rate)?;
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
        let frames: Vec<f32> = chunk.as_chunks::<2>().0.iter().flat_map(|&[l, r]| [l, r, 0.0, 0.0]).collect();
        ring.push_entire_slice(&frames).map_err(|_| "Ο ring buffer γέμισε.".to_string())?;
        step(&mut render);
    }
    while !render.prefilling && render.ring.slots() >= device_frames * CH {
        step(&mut render);
    }
    Ok(OfflineReport {
        name,
        latency_samples: latency,
        peak_in: input.iter().fold(0.0, |m, s| m.max(s.abs())),
        peak_out,
        non_finite,
        frames_out: link.frames_out.load(SeqCst),
        underruns: link.underruns.load(SeqCst),
        elapsed,
    })
}

/// Example check of the plugin delay compensation, on the calling (main) thread: the plugin on Deck
/// A, a short band-limited burst on Deck A only and then one on Deck B only, then silence until both
/// have come out. Each burst's onset (its first output sample within 20 dB of that burst's own output
/// peak, so the plugin's gain does not move it) must sit at the same delay within 1 frame, with Deck A
/// wet and with it bypassed.
pub fn offline_pdc_check(path: &Path, sample_rate: u32, device_frames: usize) -> Result<String, String> {
    let mut lines = Vec::new();
    for bypassed in [false, true] {
        let Rig { mut ring, mut render, link, latency, pinned, .. } = offline_rig(HostSlot::DeckA, path, sample_rate)?;
        render.slots[HostSlot::DeckA.index()].bypass.store(bypassed, SeqCst);
        let d = link.pdc.load(SeqCst) as usize;
        // A 2 kHz tone under a 4 ms Hann window.
        let rate = sample_rate as usize;
        let burst: Vec<f32> = (0..rate / 250)
            .map(|k| {
                let x = k as f32 / (rate / 250) as f32;
                0.5 * (std::f32::consts::PI * x).sin().powi(2) * (std::f32::consts::TAU * 2000.0 * k as f32 / sample_rate as f32).sin()
            })
            .collect();
        // Each span outlasts the prefill, the alignment, a device buffer and the burst itself.
        let span = (prefill_frames(device_frames, 0) + d + device_frames + burst.len()).next_multiple_of(device_frames);
        let (a_at, b_at, total) = (span, 2 * span, 3 * span);
        let mut input = vec![0.0f32; total * CH];
        for (k, s) in burst.iter().enumerate() {
            input[(a_at + k) * CH..][..2].fill(*s);
            input[(b_at + k) * CH + 2..][..2].fill(*s);
        }
        let mut out = vec![0.0f32; device_frames * 2];
        let mut left = Vec::with_capacity(total);
        for chunk in input.chunks_exact(device_frames * CH) {
            ring.push_entire_slice(chunk).map_err(|_| "the ring is full")?;
            render.render(&mut out, 2);
            if out.iter().any(|s| !s.is_finite()) {
                return Err("non-finite output".into());
            }
            left.extend(out.as_chunks::<2>().0.iter().map(|lr| lr[0]));
        }
        if link.underruns.load(SeqCst) > 0 {
            return Err("underruns in the offline run".into());
        }
        let (Some(a), Some(b)) = (onset(&left, a_at, b_at), onset(&left, b_at, total)) else { return Err("a burst never came out".into()) };
        let (delay_a, delay_b) = (a - a_at, b - b_at);
        let state = if bypassed { "bypassed" } else { "wet" };
        if delay_a.abs_diff(delay_b) > 1 {
            return Err(format!("Deck A ({state}) came out {delay_a} frames late and Deck B {delay_b}: not aligned (L {latency}, D {d})"));
        }
        lines.push(format!("Deck A {state} {delay_a} / Deck B {delay_b} frames (L {latency}, D {d}, bundle pinned {pinned})"));
    }
    Ok(lines.join("; "))
}

/// The first sample in `out[from..to]` within 20 dB of that range's peak; `None` for silence.
fn onset(out: &[f32], from: usize, to: usize) -> Option<usize> {
    let range = out.get(from..to)?;
    let peak = range.iter().fold(0.0f32, |m, s| m.max(s.abs()));
    if peak < 1e-6 {
        return None;
    }
    range.iter().position(|s| s.abs() >= 0.1 * peak).map(|k| from + k)
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
        mpsc::RecvTimeoutError::Timeout => "Τα plugins VST3 δεν απάντησαν εγκαίρως.".to_string(),
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
    let failed = logged::<vst3_host::Error>(LOAD_FAILED);
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

/// The default output device and its config, refused unless it runs at `sample_rate` in f32.
fn output_device(sample_rate: u32) -> Result<(cpal::Device, cpal::SupportedStreamConfig), String> {
    let device = cpal::default_host().default_output_device().ok_or("Δεν βρέθηκε συσκευή εξόδου ήχου.")?;
    let config = device.default_output_config().map_err(logged("Η συσκευή εξόδου ήχου δεν απάντησε."))?;
    if config.sample_rate() != sample_rate {
        return Err(format!("Η συσκευή εξόδου τρέχει στα {} Hz, όχι στα {sample_rate} Hz.", config.sample_rate()));
    }
    if config.sample_format() != cpal::SampleFormat::F32 {
        return Err(format!("Η συσκευή εξόδου δεν δέχεται δείγματα f32 ({}).", config.sample_format()));
    }
    Ok((device, config))
}

// Main thread, the start's first step: replaces a running session, then checks the device, so a
// mismatch refuses before any load.
fn prepare(generation: u64, sample_rate: u32) -> Result<(), String> {
    if let Some(old) = take_session(None) {
        teardown(old);
    }
    drop(take_staging(None));
    if GENERATION.load(SeqCst) != generation {
        return Err(SUPERSEDED.into());
    }
    output_device(sample_rate)?;
    STAGING.with(|s| *s.borrow_mut() = Some(Staging { generation, slots: Default::default(), pdc: Pdc::default() }));
    Ok(())
}

// Main thread, one step per slot: loads the plugin into the staging slot and returns only data, so no
// plugin ever leaves the main thread. A failed load or a PDC refusal is the slot's own reply; only a
// superseded start is an error.
fn stage_slot(generation: u64, slot: HostSlot, path: &Path, sample_rate: u32, state_dir: Option<&Path>) -> Result<SlotReply, String> {
    if GENERATION.load(SeqCst) != generation {
        return Err(SUPERSEDED.into());
    }
    let (plugin, restored) = match load(path, sample_rate, state_dir) {
        Ok(loaded) => loaded,
        Err(error) => return Ok(SlotReply::Failed { error }),
    };
    pin_bundle(path);
    let (name, uid, latency) = (plugin.info().name.clone(), plugin.info().uid.clone(), plugin.latency_samples());
    let state = state_dir.and_then(|dir| state_file(dir, &uid));
    STAGING.with(|s| {
        let mut s = s.borrow_mut();
        let Some(staging) = s.as_mut().filter(|s| s.generation == generation && GENERATION.load(SeqCst) == generation) else {
            return Err(SUPERSEDED.to_string());
        };
        match apply_latency(staging.pdc, slot, latency, pdc_budget(sample_rate)) {
            Ok(pdc) => {
                staging.pdc = pdc;
                staging.slots[slot.index()] = Some(Staged { plugin, state, name: name.clone(), uid });
                Ok(SlotReply::Loaded { name, latency_samples: latency, restored })
            }
            Err(error) => Ok(SlotReply::Failed { error: error.into() }),
        }
    })
}

// Main thread, the start's last step: the stream and the session from the staged plugins.
fn build(generation: u64, sample_rate: u32, ring: Consumer<f32>, link: Arc<Link>) -> Result<Slots, String> {
    let staging = take_staging(Some(generation)).ok_or(SUPERSEDED)?;
    if GENERATION.load(SeqCst) != generation {
        return Err(SUPERSEDED.into());
    }
    let (device, config) = output_device(sample_rate)?;
    let Staging { slots: staged, pdc, .. } = staging;
    let mut plugins: Plugins = Default::default();
    let mut shared: [SlotShared; 3] = Default::default();
    let mut states: [Option<PathBuf>; 3] = Default::default();
    for (i, staged) in staged.into_iter().enumerate() {
        let Some(Staged { plugin, state, name, uid }) = staged else { continue };
        plugins[i] = Some(Arc::new(Mutex::new(plugin)));
        shared[i] = SlotShared { loaded: true, name, uid, ..Default::default() };
        states[i] = state;
    }
    let slots: Slots = Arc::new(shared);
    store_pdc(pdc, &slots, &link);
    let channels = usize::from(config.channels());
    let mut render = Render::new(plugins.clone(), slots.clone(), ring, link.clone(), sample_rate);
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
    let now = Instant::now();
    let session = Session { generation, windows: Default::default(), stream, plugins, slots: slots.clone(), link, states, sample_rate, serviced: [now; 3], reported: pdc.latency };
    if GENERATION.load(SeqCst) != generation {
        teardown(session);
        return Err(SUPERSEDED.into());
    }
    SESSION.with(|s| *s.borrow_mut() = Some(session));
    Ok(slots)
}

// Main thread. `None` takes any staging.
fn take_staging(generation: Option<u64>) -> Option<Staging> {
    STAGING.with(|s| {
        let mut s = s.borrow_mut();
        if generation.is_none_or(|g| s.as_ref().is_some_and(|s| s.generation == g)) { s.take() } else { None }
    })
}

// Main thread. `None` takes any session.
fn take_session(generation: Option<u64>) -> Option<Session> {
    SESSION.with(|s| {
        let mut s = s.borrow_mut();
        if generation.is_none_or(|g| s.as_ref().is_some_and(|s| s.generation == g)) { s.take() } else { None }
    })
}

/// A callback that entered more than a second ago and has not left: a plugin is stuck inside it. A
/// cleared stamp (0) never is, so a callback that simply stopped coming (device gone, sleep) is not.
fn wedged(now: u64, entered: u64) -> bool {
    entered != 0 && now.saturating_sub(entered) > WEDGED_AFTER.as_nanos() as u64
}

// Main thread. Editor windows, then the stream (and its callback), then each slot's state, then the
// last plugin references. A wedged callback would block both the windows (they lock the plugin) and
// the stream's drop, so then everything is leaked instead of blocking the main thread.
fn teardown(session: Session) {
    session.link.stop.store(true, SeqCst);
    if wedged(session.link.base.stamp(Instant::now()), session.link.entered.load(SeqCst)) {
        eprintln!("CrateMind master host: the audio callback is stuck in a plugin; its stream, windows and plugins are leaked");
        std::mem::forget(session);
        return;
    }
    let Session { windows, stream, plugins, states, .. } = session;
    drop(windows);
    drop(stream);
    for (plugin, state) in plugins.iter().zip(&states) {
        if let (Some(plugin), Some(file)) = (plugin, state) {
            save_state(&plugin.lock().unwrap_or_else(|p| p.into_inner()), file);
        }
    }
    drop(plugins);
}

// Main thread: window events, plugin-initiated editor resizes, IDataExchange queues and restart
// requests. A slot with an open window is serviced on every call (33 ms), the others at most every
// 250 ms, so the main thread rarely holds a plugin lock (each hold turns that chunk dry).
fn service(generation: u64) {
    SERVICE_QUEUED.store(false, SeqCst);
    SESSION.with(|s| {
        let mut s = s.borrow_mut();
        let Some(s) = s.as_mut().filter(|s| s.generation == generation) else { return };
        // A window the user closed: detach its editor.
        for window in &mut s.windows {
            if window.as_ref().is_some_and(PluginWindow::closed_by_user) {
                *window = None;
            }
        }
        let now = Instant::now();
        let budget = pdc_budget(s.sample_rate);
        for slot in HostSlot::ALL {
            let i = slot.index();
            let Some(plugin) = s.plugins[i].as_ref() else { continue };
            let open = s.windows[i].as_ref().is_some_and(|window| {
                let _ = window.service_platform_events(); // try_locks the plugin itself
                window.is_open()
            });
            if !open && now.duration_since(s.serviced[i]) < SERVICE_EVERY {
                continue;
            }
            let Ok(mut plugin) = plugin.try_lock() else { continue };
            s.serviced[i] = now;
            let _ = plugin.take_data_exchange_blocks(); // delivers to the controller; snapshots unused
            // A latency change (look-ahead, oversampling) applies the plugin's restart request here,
            // under the lock: the audio thread passes those chunks through dry.
            let reload = plugin.service_host_requests().is_ok_and(|flags| flags.reload_component());
            let latency = plugin.latency_samples();
            drop(plugin);
            if reload {
                s.slots[i].trip(FAULT_RELOAD);
            }
            if latency != s.reported[i] {
                s.reported[i] = latency;
                latency_changed(&s.slots, &s.link, slot, latency, budget);
            }
        }
        s.link.windows_open.store(s.windows.iter().flatten().any(PluginWindow::is_open), SeqCst);
    });
}

/// A plugin reported a new latency. Over the budget, L stays (so the slot's dry path does not jump)
/// and the slot faults, unless the user had bypassed it: nothing faulted, and its un-bypass re-reads
/// the latency and refuses.
fn latency_changed(slots: &[SlotShared; 3], link: &Link, slot: HostSlot, latency: u32, budget: u32) {
    let shared = &slots[slot.index()];
    match apply_latency(read_pdc(slots, link), slot, latency, budget) {
        Ok(pdc) => store_pdc(pdc, slots, link),
        Err(_) if !shared.user_bypassed() => shared.trip(FAULT_ERROR),
        Err(_) => {}
    }
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

/// Estimated added latency: mean ring fill + the plugins' D + L_master + one device buffer.
fn latency_ms(mean_fill_frames: f64, plugin_latency: u32, device_frames: u32, sample_rate: u32) -> f64 {
    (mean_fill_frames + f64::from(plugin_latency) + f64::from(device_frames)) * 1000.0 / f64::from(sample_rate)
}

/// Decodes one binary frame into `out`: a 32-byte header (reserved for the decks' transport, ignored in
/// stage 1), then `N` frames of four f32 LE samples (AL, AR, BL, BR), 1 ≤ N ≤ 4096. Non-finite samples
/// become 0.
fn decode_frame(bytes: &[u8], out: &mut Vec<f32>) -> bool {
    let Some(samples) = bytes.get(FRAME_HEADER..) else { return false };
    if samples.is_empty() || !samples.len().is_multiple_of(CH * 4) || samples.len() > MAX_FRAME_FRAMES * CH * 4 {
        return false;
    }
    out.clear();
    out.extend(samples.as_chunks::<4>().0.iter().map(|b| {
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

/// A stereo delay line, allocated once: `push` a chunk, then `read` that chunk some frames late.
struct DelayLine {
    lines: [Vec<f32>; 2],
    pos: usize,
}

impl DelayLine {
    fn new(capacity: usize) -> Self {
        Self { lines: [vec![0.0; capacity], vec![0.0; capacity]], pos: 0 }
    }

    /// Appends one chunk (both channels the same length, at most the capacity).
    fn push(&mut self, input: &[Vec<f32>]) {
        let capacity = self.lines[0].len();
        for (line, input) in self.lines.iter_mut().zip(input) {
            for (k, s) in input.iter().enumerate() {
                line[(self.pos + k) % capacity] = *s;
            }
        }
        self.pos = (self.pos + input[0].len()) % capacity;
    }

    /// The chunk pushed last, `delay` frames late (at most the capacity less the chunk).
    fn read(&self, delay: usize, out: &mut [Vec<f32>]) {
        let capacity = self.lines[0].len();
        let n = out[0].len();
        let delay = delay.min(capacity - n);
        let start = self.pos + 2 * capacity - n - delay;
        for (line, out) in self.lines.iter().zip(out) {
            for (k, s) in out.iter_mut().enumerate() {
                *s = line[(start + k) % capacity];
            }
        }
    }
}

/// One slot's alignment. `out` holds the plugin's output when `wet`; otherwise (bypassed, empty, busy
/// or an error) the slot's dry line, read `min(l, d)` late, takes its place, so the slot's output is
/// its input `l` late either way. A deck's `comp` line then adds `d − min(l, d)`: whichever path a
/// chunk takes, the deck comes out exactly `d` late, so a chunk that goes dry changes content but
/// never repeats or skips. The master slot has no comp line and runs with `d = l`.
fn align(input: &[Vec<f32>], out: &mut [Vec<f32>], wet: bool, dry: &mut DelayLine, comp: Option<&mut DelayLine>, l: usize, d: usize) {
    let l = l.min(d);
    dry.push(input);
    if !wet {
        dry.read(l, out);
    }
    if let Some(comp) = comp {
        comp.push(out);
        comp.read(d - l, out);
    }
}

/// One slot's fault counters, kept by the audio callback.
#[derive(Default)]
struct Faults {
    errors: u32,
    slow: u32,
}

impl Faults {
    /// One processed chunk: 8 errors in a row is an error fault; 32 chunks in a row that took over
    /// half their own time is a slow one. A fault starts the counts over.
    fn note(&mut self, ok: bool, load: f64) -> Option<u8> {
        self.errors = if ok { 0 } else { self.errors + 1 };
        self.slow = if load > SLOW_SHARE { self.slow + 1 } else { 0 };
        let fault = if self.errors >= ERROR_RUN {
            Some(FAULT_ERROR)
        } else if self.slow >= SLOW_RUN {
            Some(FAULT_SLOW)
        } else {
            None
        };
        if fault.is_some() {
            self.reset();
        }
        fault
    }

    fn reset(&mut self) {
        *self = Self::default();
    }
}

/// The whole callback's overload count: two slots can overrun together without either passing 50%.
#[derive(Default)]
struct Overload {
    over: u32,
}

impl Overload {
    /// True once 32 callbacks in a row took over 90% of their buffer's time; the count then starts over,
    /// so the next slot goes only after 32 more.
    fn note(&mut self, load: f64) -> bool {
        self.over = if load > CALLBACK_SHARE { self.over + 1 } else { 0 };
        let act = self.over >= SLOW_RUN;
        if act {
            self.over = 0;
        }
        act
    }
}

/// The eligible slot that spent the most time in this callback.
fn heaviest(spent: [Duration; 3], eligible: [bool; 3]) -> Option<usize> {
    (0..3).filter(|&i| eligible[i]).max_by_key(|&i| spent[i])
}

fn permille(share: f64) -> u32 {
    (share * 1000.0).round() as u32
}

fn fault_name(fault: u8) -> Option<&'static str> {
    match fault {
        FAULT_ERROR => Some("error"),
        FAULT_SLOW => Some("slow"),
        FAULT_RELOAD => Some("reload"),
        _ => None,
    }
}

/// A slot's stats: `null` when empty. `latency` is its L and `comp` the extra delay its deck's comp
/// line adds (frames); `load_pct` is its highest share of a callback since the last stats.
fn slot_stats(shared: &SlotShared, slot: HostSlot, d: u32) -> serde_json::Value {
    if !shared.loaded {
        return serde_json::Value::Null;
    }
    let latency = shared.latency.load(SeqCst);
    serde_json::json!({
        "name": shared.name,
        "latency": latency,
        "comp": if slot.is_deck() { d - latency.min(d) } else { 0 },
        "bypassed": shared.bypass.load(SeqCst),
        "fault": fault_name(shared.fault.load(SeqCst)),
        "load_pct": f64::from(shared.load_permille.swap(0, SeqCst)) / 10.0,
    })
}

/// Runs one chunk through a slot's plugin, unless the slot is empty, busy or bypassed by a fault. True
/// when its output is the plugin's (wet). A slot the user bypassed is still fed, so un-bypass finds its
/// delay line in step, but its output is unused and it never counts toward a fault.
fn run_slot<P: Processor>(plugin: Option<&mut P>, buffers: &mut AudioBuffers, shared: &SlotShared, faults: &mut Faults, chunk_secs: f64, spent: &mut Duration) -> bool {
    let bypassed = shared.bypass.load(SeqCst);
    if bypassed {
        faults.reset(); // un-bypass starts the counts over
    }
    let Some(plugin) = plugin else { return false };
    let t = Instant::now();
    let ok = plugin.process(buffers);
    let took = t.elapsed();
    *spent += took;
    if bypassed {
        return false;
    }
    if let Some(fault) = faults.note(ok, took.as_secs_f64() / chunk_secs) {
        shared.trip(fault);
    }
    ok
}

// The device callback: prefill, pop, then per chunk of up to MAX_BLOCK frames run both deck slots,
// align them, sum them and run the master slot. No allocation, no blocking lock.
struct Render<P = Plugin> {
    plugins: [Option<Arc<Mutex<P>>>; 3],
    slots: Slots,
    ring: Consumer<f32>,
    // Deck A, Deck B, Master: each slot's input and output for one chunk.
    buffers: [AudioBuffers; 3],
    // Each slot's input, so a slot that is not wet still comes out `L` late.
    dry: [DelayLine; 3],
    // Each deck's comp line: `D − L` more, so both decks come out `D` late.
    comp: [DelayLine; 2],
    faults: [Faults; 3],
    overload: Overload,
    prefilling: bool,
    // Lowest fill seen at a callback in the current window, and callbacks left in it.
    min_fill: usize,
    window_left: usize,
    sample_rate: u32,
    link: Arc<Link>,
}

impl<P: Processor> Render<P> {
    fn new(plugins: [Option<Arc<Mutex<P>>>; 3], slots: Slots, ring: Consumer<f32>, link: Arc<Link>, sample_rate: u32) -> Self {
        let line = || DelayLine::new(pdc_budget(sample_rate) as usize + MAX_BLOCK);
        let buffers = || AudioBuffers::new(2, 2, MAX_BLOCK, f64::from(sample_rate));
        Self {
            plugins,
            slots,
            ring,
            buffers: [buffers(), buffers(), buffers()],
            dry: [line(), line(), line()],
            comp: [line(), line()],
            faults: Default::default(),
            overload: Overload::default(),
            prefilling: true,
            min_fill: usize::MAX,
            window_left: 0,
            sample_rate,
            link,
        }
    }

    // Drops queued audio down to `keep` frames (whole frames, so the channel order holds); returns the
    // fill afterwards.
    fn trim_to(&mut self, available: usize, keep: usize) -> usize {
        if available <= keep {
            return available;
        }
        let Ok(chunk) = self.ring.read_chunk((available - keep) * CH) else { return available };
        chunk.commit_all();
        self.link.trims.fetch_add(1, SeqCst);
        keep
    }

    fn reset_window(&mut self, frames: usize) {
        self.min_fill = usize::MAX;
        self.window_left = (TRIM_WINDOW_SECS * self.sample_rate as usize / frames.max(1)).max(1);
    }

    fn render(&mut self, out: &mut [f32], channels: usize) {
        // A stopped link never calls a plugin again.
        if self.link.stop.load(SeqCst) {
            out.fill(0.0);
            return;
        }
        let entered = Instant::now();
        self.link.entered.store(self.link.base.stamp(entered), SeqCst);
        self.mix(out, channels, entered);
        self.link.entered.store(0, SeqCst);
    }

    fn mix(&mut self, out: &mut [f32], channels: usize, entered: Instant) {
        let frames = out.len() / channels;
        let available = self.ring.slots() / CH;
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
        // A slot that a fault did not bypass is borrowed for the whole buffer; a busy lock (the main
        // thread) leaves it dry for this buffer.
        let mut plugins: [Option<MutexGuard<P>>; 3] = std::array::from_fn(|i| {
            let plugin = self.plugins[i].as_ref().filter(|_| !self.slots[i].fault_bypassed())?;
            match plugin.try_lock() {
                Ok(guard) => Some(guard),
                Err(TryLockError::Poisoned(poison)) => Some(poison.into_inner()),
                Err(TryLockError::WouldBlock) => None,
            }
        });
        let master = HostSlot::Master.index();
        let mut spent = [Duration::ZERO; 3];
        let mut done = 0;
        while done < frames {
            let n = (frames - done).min(MAX_BLOCK);
            let Ok(chunk) = self.ring.read_chunk(n * CH) else { break };
            for buffers in &mut self.buffers {
                for c in 0..2 {
                    buffers.inputs[c].resize(n, 0.0);
                    buffers.outputs[c].resize(n, 0.0);
                }
            }
            let (a, b) = chunk.as_slices();
            for (i, s) in a.iter().chain(b).enumerate() {
                let channel = i % CH;
                self.buffers[channel / 2].inputs[channel % 2][i / CH] = *s;
            }
            chunk.commit_all();
            let chunk_secs = n as f64 / f64::from(self.sample_rate);
            let d = self.link.pdc.load(SeqCst) as usize;
            for deck in 0..2 {
                let (shared, buffers) = (&self.slots[deck], &mut self.buffers[deck]);
                let wet = run_slot(plugins[deck].as_deref_mut(), buffers, shared, &mut self.faults[deck], chunk_secs, &mut spent[deck]);
                let l = shared.latency.load(SeqCst) as usize;
                align(&buffers.inputs, &mut buffers.outputs, wet, &mut self.dry[deck], Some(&mut self.comp[deck]), l, d);
            }
            // The two decks at unity, as the page's bus sums them.
            let [deck_a, deck_b, sum] = &mut self.buffers;
            for c in 0..2 {
                for ((s, a), b) in sum.inputs[c].iter_mut().zip(&deck_a.outputs[c]).zip(&deck_b.outputs[c]) {
                    *s = a + b;
                }
            }
            let shared = &self.slots[master];
            let wet = run_slot(plugins[master].as_deref_mut(), sum, shared, &mut self.faults[master], chunk_secs, &mut spent[master]);
            let l = shared.latency.load(SeqCst) as usize;
            align(&sum.inputs, &mut sum.outputs, wet, &mut self.dry[master], None, l, l);
            write_frames(&mut out[done * channels..(done + n) * channels], channels, &sum.outputs[0], &sum.outputs[1]);
            done += n;
        }
        drop(plugins);
        self.link.frames_out.fetch_add(frames as u64, SeqCst);
        self.note_load(entered.elapsed(), spent, frames as f64 / f64::from(self.sample_rate));
    }

    // Load stats, and the whole-callback guard: after 32 overloaded callbacks in a row the slot that
    // spent the most is bypassed as slow.
    fn note_load(&mut self, took: Duration, spent: [Duration; 3], period: f64) {
        let load = took.as_secs_f64() / period;
        self.link.callback_permille.fetch_max(permille(load), SeqCst);
        for (slot, spent) in self.slots.iter().zip(spent) {
            slot.load_permille.fetch_max(permille(spent.as_secs_f64() / period), SeqCst);
        }
        if self.overload.note(load) {
            let eligible = std::array::from_fn(|i| self.plugins[i].is_some() && !self.slots[i].bypass.load(SeqCst));
            if let Some(i) = heaviest(spent, eligible) {
                self.slots[i].trip(FAULT_SLOW);
            }
        }
    }
}

// The socket thread: accepts one client, feeds the ring, sends stats; stops the host when it ends.
struct Server {
    generation: u64,
    token: String,
    origin: String,
    sample_rate: u32,
    link: Arc<Link>,
    slots: Slots,
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
        let mut samples = Vec::with_capacity(MAX_FRAME_FRAMES * CH);
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
            let every = if self.link.windows_open.load(SeqCst) { SERVICE_OPEN_EVERY } else { SERVICE_EVERY };
            if last_service.elapsed() >= every && !SERVICE_QUEUED.swap(true, SeqCst) {
                last_service = Instant::now();
                let generation = self.generation;
                (self.main)(Box::new(move || service(generation)));
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
        let pdc = self.link.pdc.load(SeqCst);
        let slots: serde_json::Map<String, serde_json::Value> = HostSlot::ALL.into_iter().map(|slot| (slot.key().to_string(), slot_stats(&self.slots[slot.index()], slot, pdc))).collect();
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
            "pdc": pdc,
            "callback_load_pct": f64::from(self.link.callback_permille.swap(0, SeqCst)) / 10.0,
            "slots": slots,
        })
        .to_string()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn frame(header: u8, samples: &[f32]) -> Vec<u8> {
        std::iter::repeat_n(header, FRAME_HEADER).chain(samples.iter().flat_map(|s| s.to_le_bytes())).collect()
    }

    #[test]
    fn decode_frame_skips_the_header_and_reads_four_channel_le_f32() {
        let mut out = Vec::new();
        assert!(decode_frame(&frame(0, &[0.5, -0.25, f32::NAN, f32::INFINITY]), &mut out));
        assert_eq!(out, [0.5, -0.25, 0.0, 0.0]);
        // The reserved header is never read as audio, whatever it holds.
        assert!(decode_frame(&frame(0xff, &[1.0, 2.0, 3.0, 4.0, 5.0, 6.0, 7.0, 8.0]), &mut out));
        assert_eq!(out, [1.0, 2.0, 3.0, 4.0, 5.0, 6.0, 7.0, 8.0]);
        assert!(decode_frame(&frame(0, &vec![0.0; MAX_FRAME_FRAMES * CH]), &mut out));
        assert_eq!(out.len(), MAX_FRAME_FRAMES * CH);
    }

    #[test]
    fn decode_frame_rejects_empty_headless_partial_and_oversized_frames() {
        let mut out = Vec::new();
        assert!(!decode_frame(&[], &mut out));
        assert!(!decode_frame(&[0; FRAME_HEADER - 1], &mut out));
        assert!(!decode_frame(&[0; FRAME_HEADER], &mut out)); // a header alone: N = 0
        assert!(!decode_frame(&[0; 16], &mut out)); // one frame without its header
        for partial in [4, 8, 12, 20, 28] {
            assert!(!decode_frame(&vec![0; FRAME_HEADER + partial], &mut out), "{partial}");
        }
        assert!(!decode_frame(&frame(0, &vec![0.0; (MAX_FRAME_FRAMES + 1) * CH]), &mut out));
    }

    #[test]
    fn delay_line_is_identity_at_zero_delays_by_k_and_wraps() {
        let mut line = DelayLine::new(16);
        let mut out = vec![vec![0.0; 5]; 2];
        let chunk = |from: usize| vec![(from..from + 5).map(|i| i as f32).collect::<Vec<_>>(), (from..from + 5).map(|i| -(i as f32)).collect()];
        line.push(&chunk(1));
        line.read(0, &mut out);
        assert_eq!(out, chunk(1));
        line.read(3, &mut out);
        assert_eq!(out[0], [0.0, 0.0, 0.0, 1.0, 2.0]);
        assert_eq!(out[1], [0.0, 0.0, 0.0, -1.0, -2.0]);
        // Past the end of the buffer: 1..=30 pushed into 16 slots, still exact.
        for from in [6, 11, 16, 21, 26] {
            line.push(&chunk(from));
        }
        line.read(7, &mut out);
        assert_eq!(out[0], [19.0, 20.0, 21.0, 22.0, 23.0]);
        // A delay past the capacity is clamped to what the line still holds.
        line.read(100, &mut out);
        assert_eq!(out[0], [15.0, 16.0, 17.0, 18.0, 19.0]);
    }

    #[test]
    fn a_slot_comes_out_exactly_d_late_whether_wet_dry_or_busy() {
        // Deck slots (L ≤ D, comp line) and the master slot (no comp line, D = L).
        for (l, d, deck) in [(37, 100, true), (100, 100, true), (0, 64, true), (513, 700, true), (37, 37, false), (0, 0, false)] {
            let capacity = d + MAX_BLOCK;
            let (mut dry, mut comp, mut plugin) = (DelayLine::new(capacity), DelayLine::new(capacity), DelayLine::new(capacity));
            // A ramp: every sample unique, so a repeat or a skip cannot hide.
            let input: Vec<f32> = (1..=6000).map(|i| i as f32).collect();
            let sizes = [1, 512, 7, 300, 64, 511, 33, 128];
            let (mut at, mut k, mut got) = (0, 0, Vec::new());
            while at < input.len() {
                let n = sizes[k % sizes.len()].min(input.len() - at);
                let chunk = vec![input[at..at + n].to_vec(), input[at..at + n].iter().map(|s| -s).collect()];
                // The fake plugin outputs its input `l` late; 0 wet, 1 bypassed, 2 busy (both dry).
                plugin.push(&chunk);
                let wet = k % 3 == 0;
                let mut out = vec![vec![9.0; n]; 2];
                if wet {
                    plugin.read(l, &mut out);
                }
                align(&chunk, &mut out, wet, &mut dry, deck.then_some(&mut comp), l, d);
                assert!(out[0].iter().zip(&out[1]).all(|(a, b)| *a == -*b));
                got.extend_from_slice(&out[0]);
                (at, k) = (at + n, k + 1);
            }
            for (i, s) in got.iter().enumerate() {
                let want = if i < d { 0.0 } else { input[i - d] };
                assert_eq!(*s, want, "L {l} D {d} deck {deck}, frame {i}");
            }
        }
    }

    /// A stateful fake plugin: a pure `L`-frame delay per channel, as a look-ahead limiter's FIFO.
    struct FakeDelay {
        lines: [std::collections::VecDeque<f32>; 2],
        latency: u32,
        fed: usize,
    }

    impl FakeDelay {
        fn new(latency: u32) -> Self {
            let line = || std::iter::repeat_n(0.0, latency as usize).collect();
            Self { lines: [line(), line()], latency, fed: 0 }
        }
    }

    impl Processor for FakeDelay {
        fn process(&mut self, buffers: &mut AudioBuffers) -> bool {
            self.fed += 1;
            for ((line, input), output) in self.lines.iter_mut().zip(&buffers.inputs).zip(&mut buffers.outputs) {
                for (s, o) in input.iter().zip(output.iter_mut()) {
                    line.push_back(*s);
                    *o = line.pop_front().unwrap_or(0.0);
                }
            }
            true
        }

        fn latency(&self) -> u32 {
            self.latency
        }

        fn restart(&mut self) -> Result<(), String> {
            self.lines = Self::new(self.latency).lines;
            Ok(())
        }
    }

    const FAKE_L: u32 = 64;
    const FAKE_D: u32 = 100;
    const FAKE_FRAMES: usize = 700; // two chunks per callback (512 + 188)

    /// Deck A holds a `FakeDelay` of `FAKE_L` (D = `FAKE_D`); Deck A plays a ramp, Deck B silence.
    /// Runs `callbacks` device callbacks through `Render::render`, calling `between(k, …)` before each,
    /// and returns the left channel heard.
    fn run_fake(callbacks: usize, mut between: impl FnMut(usize, &Mutex<FakeDelay>, &[SlotShared; 3], &Link)) -> Vec<f32> {
        let fake = Arc::new(Mutex::new(FakeDelay::new(FAKE_L)));
        let mut shared: [SlotShared; 3] = Default::default();
        shared[0] = SlotShared { loaded: true, name: "Delay".into(), ..Default::default() };
        let slots: Slots = Arc::new(shared);
        let link = Arc::new(Link::default());
        store_pdc(Pdc { latency: [FAKE_L, 0, 0], d: FAKE_D }, &slots, &link);
        let (mut ring, consumer) = RingBuffer::new(RING_FRAMES * CH);
        let mut render = Render::new([Some(fake.clone()), None, None], slots.clone(), consumer, link.clone(), 48_000);
        let mut pushed = 0usize;
        let mut push = |ring: &mut Producer<f32>, frames: usize| {
            let block: Vec<f32> = (pushed..pushed + frames).flat_map(|i| [(i + 1) as f32, -((i + 1) as f32), 0.0, 0.0]).collect();
            ring.push_entire_slice(&block).unwrap();
            pushed += frames;
        };
        // The prefill target exactly, then one buffer per callback: the ring never trims.
        push(&mut ring, prefill_frames(FAKE_FRAMES, 0));
        let (mut out, mut heard) = (vec![9.0f32; FAKE_FRAMES * 2], Vec::new());
        for k in 0..callbacks {
            between(k, &fake, &slots, &link);
            render.render(&mut out, 2);
            push(&mut ring, FAKE_FRAMES);
            assert!(out.as_chunks::<2>().0.iter().all(|[l, r]| *l == -*r));
            heard.extend(out.as_chunks::<2>().0.iter().map(|[l, _]| *l));
        }
        assert_eq!((link.underruns.load(SeqCst), link.trims.load(SeqCst)), (0, 0));
        heard
    }

    /// The ramp `D` late: frame `i` heard is input frame `i − D` (value `i − D + 1`), silence before.
    fn ramp_d_late(i: usize) -> f32 {
        let d = FAKE_D as usize;
        if i < d { 0.0 } else { (i - d + 1) as f32 }
    }

    #[test]
    fn a_slot_the_user_bypassed_is_still_fed_so_un_bypass_replays_nothing_stale() {
        let budget = pdc_budget(48_000);
        let heard = run_fake(14, |k, fake, slots, link| {
            let deck = &slots[0];
            if k == 4 {
                deck.bypass.store(true, SeqCst);
            }
            if k == 9 {
                let mut reported = 0;
                resume(fake, slots, link, HostSlot::DeckA, budget, &mut reported).unwrap();
                assert_eq!(reported, FAKE_L);
            }
            // Fed on every callback, two chunks each, bypassed or not; never a fault.
            assert_eq!(fake.lock().unwrap().fed, 2 * k);
            assert_eq!(deck.fault.load(SeqCst), FAULT_NONE);
            assert_eq!(deck.bypass.load(SeqCst), (4..9).contains(&k));
        });
        for (i, s) in heard.iter().enumerate() {
            assert_eq!(*s, ramp_d_late(i), "frame {i}");
        }
    }

    #[test]
    fn a_slot_a_fault_bypassed_is_not_fed_and_restarts_on_un_bypass() {
        let budget = pdc_budget(48_000);
        let (from, back) = (4, 9);
        let heard = run_fake(14, |k, fake, slots, link| {
            if k == from {
                slots[0].trip(FAULT_ERROR);
            }
            if k == back {
                let mut reported = 0;
                resume(fake, slots, link, HostSlot::DeckA, budget, &mut reported).unwrap();
                assert_eq!(slots[0].fault.load(SeqCst), FAULT_NONE);
            }
            // Not fed while the fault holds it.
            assert_eq!(fake.lock().unwrap().fed, 2 * (k.min(from) + k.saturating_sub(back)));
        });
        // Back at frame `u`: the restarted delay gives L frames of silence (heard D − L later through
        // the comp line), never the audio it held from before the fault; everything else is exact.
        let u = back * FAKE_FRAMES;
        let silent = u + (FAKE_D - FAKE_L) as usize..u + FAKE_D as usize;
        for (i, s) in heard.iter().enumerate() {
            let want = if silent.contains(&i) { 0.0 } else { ramp_d_late(i) };
            assert_eq!(*s, want, "frame {i}");
        }
    }

    #[test]
    fn a_refused_un_bypass_or_a_late_latency_never_faults_a_slot_the_user_bypassed() {
        let budget = pdc_budget(48_000);
        let (slots, link): ([SlotShared; 3], Link) = Default::default();
        let fake = Mutex::new(FakeDelay::new(budget + 1));
        slots[0].bypass.store(true, SeqCst);
        let mut reported = 0;
        assert_eq!(resume(&fake, &slots, &link, HostSlot::DeckA, budget, &mut reported), Err(TOO_LATE.into()));
        assert_eq!(reported, budget + 1);
        assert!(slots[0].bypass.load(SeqCst));
        assert_eq!(slots[0].fault.load(SeqCst), FAULT_NONE);
        // The service's latency check: a user-bypassed slot keeps its L and no fault…
        latency_changed(&slots, &link, HostSlot::DeckA, budget + 1, budget);
        assert_eq!((slots[0].latency.load(SeqCst), slots[0].fault.load(SeqCst)), (0, FAULT_NONE));
        // …a playing one faults.
        latency_changed(&slots, &link, HostSlot::DeckB, budget + 1, budget);
        assert!(slots[1].bypass.load(SeqCst));
        assert_eq!(slots[1].fault.load(SeqCst), FAULT_ERROR);
        // A fault-bypassed slot refused for its latency keeps its own fault.
        slots[2].trip(FAULT_SLOW);
        let late = Mutex::new(FakeDelay::new(budget + 1));
        assert_eq!(resume(&late, &slots, &link, HostSlot::Master, budget, &mut reported), Err(TOO_LATE.into()));
        assert_eq!(slots[2].fault.load(SeqCst), FAULT_SLOW);
    }

    #[test]
    fn apply_latency_grows_d_only_and_refuses_what_breaks_the_budget() {
        assert_eq!(pdc_budget(44_100), 11_025);
        assert_eq!(pdc_budget(48_000), 12_000);
        assert_eq!(pdc_budget(96_000), PDC_MAX_FRAMES);
        let budget = pdc_budget(48_000);
        let (a, b, m) = (HostSlot::DeckA, HostSlot::DeckB, HostSlot::Master);
        let p = apply_latency(Pdc::default(), a, 1000, budget).unwrap();
        assert_eq!((p.d, p.total()), (1000, 1000));
        let p = apply_latency(p, b, 400, budget).unwrap();
        assert_eq!((p.latency, p.d), ([1000, 400, 0], 1000));
        // D never shrinks within a session.
        let p = apply_latency(p, a, 300, budget).unwrap();
        assert_eq!((p.latency, p.d), ([300, 400, 0], 1000));
        let p = apply_latency(p, m, 2000, budget).unwrap();
        assert_eq!(p.total(), 3000);
        // A deck rise within the budget grows D and the total.
        let p = apply_latency(p, b, 5000, budget).unwrap();
        assert_eq!((p.d, p.total()), (5000, 7000));
        // Over the budget, nothing changes (the caller keeps the previous L).
        assert_eq!(apply_latency(p, a, 10_001, budget), Err(TOO_LATE));
        assert_eq!(apply_latency(p, m, 7001, budget), Err(TOO_LATE));
        assert_eq!(apply_latency(p, a, u32::MAX, budget), Err(TOO_LATE));
        assert_eq!(apply_latency(p, m, 7000, budget).map(Pdc::total), Ok(budget));
        // Un-bypass: refused after a reload request and while over the budget.
        assert_eq!(unbypass(FAULT_ERROR, p, a, 10_001, budget), Err(TOO_LATE));
        assert_eq!(unbypass(FAULT_RELOAD, p, a, 0, budget), Err(RELOAD));
        assert_eq!(unbypass(FAULT_SLOW, p, a, 300, budget), Ok(p));
        // The atomics carry it, and the visual delay follows D + L_master.
        let (slots, link): ([SlotShared; 3], Link) = Default::default();
        store_pdc(p, &slots, &link);
        assert_eq!(read_pdc(&slots, &link), p);
        assert_eq!(link.plugin_latency.load(SeqCst), 7000);
    }

    #[test]
    fn faults_trip_after_their_runs_and_start_over() {
        let mut faults = Faults::default();
        for _ in 0..7 {
            assert_eq!(faults.note(false, 0.1), None);
        }
        assert_eq!(faults.note(true, 0.1), None); // a good chunk ends the run
        for _ in 0..7 {
            assert_eq!(faults.note(false, 0.1), None);
        }
        assert_eq!(faults.note(false, 0.1), Some(FAULT_ERROR));
        assert_eq!(faults.note(false, 0.1), None); // counted from zero again
        faults.reset();
        for _ in 0..31 {
            assert_eq!(faults.note(true, 0.6), None);
        }
        assert_eq!(faults.note(true, 0.5), None); // exactly half is not over
        for _ in 0..31 {
            assert_eq!(faults.note(true, 0.6), None);
        }
        assert_eq!(faults.note(true, 0.6), Some(FAULT_SLOW));
        assert_eq!((faults.errors, faults.slow), (0, 0));
        // A trip bypasses; a reload request is never replaced by a lesser fault.
        let slot = SlotShared::default();
        slot.trip(FAULT_SLOW);
        assert!(slot.bypass.load(SeqCst));
        assert_eq!(fault_name(slot.fault.load(SeqCst)), Some("slow"));
        slot.trip(FAULT_RELOAD);
        slot.trip(FAULT_ERROR);
        assert_eq!(fault_name(slot.fault.load(SeqCst)), Some("reload"));
        assert_eq!([FAULT_NONE, FAULT_ERROR, FAULT_SLOW, FAULT_RELOAD].map(fault_name), [None, Some("error"), Some("slow"), Some("reload")]);
    }

    #[test]
    fn the_callback_guard_acts_after_32_overloads_and_counts_again() {
        let mut overload = Overload::default();
        for _ in 0..31 {
            assert!(!overload.note(0.95));
        }
        assert!(!overload.note(0.9)); // a normal callback ends the run
        for _ in 0..31 {
            assert!(!overload.note(0.95));
        }
        assert!(overload.note(0.95));
        for _ in 0..31 {
            assert!(!overload.note(0.95)); // the next slot goes only after 32 more
        }
        assert!(overload.note(0.95));
        let ms = Duration::from_millis;
        assert_eq!(heaviest([ms(1), ms(3), ms(2)], [true; 3]), Some(1));
        assert_eq!(heaviest([ms(1), ms(3), ms(2)], [true, false, true]), Some(2));
        assert_eq!(heaviest([ms(1), ms(3), ms(2)], [false; 3]), None);
    }

    #[test]
    fn only_an_old_set_stamp_is_wedged() {
        let second = WEDGED_AFTER.as_nanos() as u64;
        assert!(!wedged(10 * second, 0)); // cleared: the callback left (or stopped coming)
        assert!(!wedged(10 * second, 10 * second - 1000));
        assert!(!wedged(second, 1));
        assert!(wedged(second + 2, 1));
        assert!(!wedged(5, 10)); // a stamp after `now` (read race) is not wedged
        let epoch = Epoch::default();
        assert!(epoch.stamp(epoch.0) >= 1);
    }

    #[test]
    fn each_slot_keeps_its_own_state_folder() {
        let dir = Path::new("/data/master-host");
        assert_eq!(slot_state_dir(dir, HostSlot::Master), dir);
        assert_eq!(slot_state_dir(dir, HostSlot::DeckA), dir.join("deck-a"));
        assert_eq!(slot_state_dir(dir, HostSlot::DeckB), dir.join("deck-b"));
        let uid = "0123456789abcdef0123456789abcdef";
        let files = HostSlot::ALL.map(|slot| state_file(&slot_state_dir(dir, slot), uid).unwrap());
        assert_eq!(files[2], dir.join(format!("{uid}.state"))); // the master's file is unchanged
        assert!(files[0] != files[1] && files[1] != files[2] && files[0] != files[2]);
    }

    #[test]
    fn the_ring_holds_four_channels_and_a_trim_keeps_their_order() {
        let (mut ring, mut render, _) = quiet_render(48_000);
        let frames: Vec<f32> = (0..11 * CH).map(|i| i as f32).collect();
        ring.push_entire_slice(&frames).unwrap();
        assert_eq!(render.ring.slots() / CH, 11);
        assert_eq!(render.trim_to(11, 4), 4); // drops 7 frames, an odd count
        let chunk = render.ring.read_chunk(CH).unwrap();
        let (a, b) = chunk.as_slices();
        assert_eq!([a, b].concat(), [28.0, 29.0, 30.0, 31.0]); // AL, AR, BL, BR of frame 7
        assert!(prefill_frames(4096, cushion_cap(384_000)) < RING_FRAMES);
    }

    fn quiet_render(sample_rate: u32) -> (Producer<f32>, Render, Arc<Link>) {
        let (ring, consumer) = RingBuffer::new(RING_FRAMES * CH);
        let link = Arc::new(Link::default());
        (ring, Render::new(Default::default(), Arc::new(Default::default()), consumer, link.clone(), sample_rate), link)
    }

    #[test]
    fn empty_slots_sum_the_decks_and_a_stopped_link_is_silent() {
        let (mut ring, mut render, link) = quiet_render(48_000);
        let block: Vec<f32> = (0..480).flat_map(|_| [1.0, 10.0, 2.0, 20.0]).collect();
        let mut out = vec![9.0f32; 480 * 2];
        let mut heard = Vec::new();
        for _ in 0..6 {
            ring.push_entire_slice(&block).unwrap();
            render.render(&mut out, 2);
            heard.extend_from_slice(&out);
        }
        // Silence while the ring prefills (2 buffers + 512 frames), then A + B at unity.
        assert!(heard[..3 * 480 * 2].iter().all(|s| *s == 0.0));
        assert!(heard[3 * 480 * 2..].as_chunks::<2>().0.iter().all(|lr| *lr == [3.0, 30.0]));
        assert_eq!(link.underruns.load(SeqCst), 0);
        assert_eq!(link.entered.load(SeqCst), 0); // cleared on the way out
        link.stop.store(true, SeqCst);
        ring.push_entire_slice(&block).unwrap();
        let queued = render.ring.slots();
        out.fill(9.0);
        render.render(&mut out, 2);
        assert!(out.iter().all(|s| *s == 0.0));
        assert_eq!(render.ring.slots(), queued);
    }

    #[test]
    fn the_start_reply_and_the_stats_keep_the_contract() {
        let loaded = SlotReply::Loaded { name: "Comp".into(), latency_samples: 64, restored: true };
        let failed = SlotReply::Failed { error: TOO_LATE.into() };
        let started = Started { token: "t".into(), port: 1, slots: [("deck_a", Some(loaded.clone())), ("deck_b", Some(failed.clone())), ("master", None)].into() };
        assert_eq!(
            serde_json::json!(started),
            serde_json::json!({"token":"t","port":1,"slots":{"deck_a":{"name":"Comp","latency_samples":64,"restored":true},"deck_b":{"error":TOO_LATE},"master":null}})
        );
        assert_eq!(all_failed(&[Some(failed.clone()), None, Some(loaded)]), None);
        assert_eq!(all_failed(&[None, Some(failed.clone()), Some(SlotReply::Failed { error: "x".into() })]), Some(TOO_LATE.into()));
        assert_eq!(all_failed(&[None, None, None]), Some(NO_PLUGIN.into()));
        let deck = SlotShared { loaded: true, name: "Comp".into(), ..Default::default() };
        deck.latency.store(64, SeqCst);
        deck.load_permille.store(125, SeqCst);
        deck.trip(FAULT_ERROR);
        assert_eq!(
            slot_stats(&deck, HostSlot::DeckA, 100),
            serde_json::json!({"name":"Comp","latency":64,"comp":36,"bypassed":true,"fault":"error","load_pct":12.5})
        );
        assert_eq!(deck.load_permille.load(SeqCst), 0); // a peak since the last stats
        assert_eq!(slot_stats(&deck, HostSlot::Master, 100)["comp"], 0);
        assert_eq!(slot_stats(&SlotShared::default(), HostSlot::DeckB, 100), serde_json::Value::Null);
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

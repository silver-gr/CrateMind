// Set recording («Εγγραφή»): master bus out → tap worklet (MessagePort, 256-frame interleaved stereo f32 blocks)
// → a main-thread queue → numbered POSTs of at most 5 s each, once a second → a 24-bit WAV the backend writes
// in the export folder. The tap hears exactly what goes to the speakers, after the Maximizer. It never runs with
// the experimental VST3 plugins: each refuses to start while the other is in use. A chunk's payload is frozen
// under its number and retried unchanged, so the backend never writes it twice and never drops blocks added later.
import { useSyncExternalStore } from "react";
import { toast } from "sonner";
import { api } from "./api";
import { addMasterTap, removeMasterTap } from "./audio/masterBus";
import { isDesktopRuntime, nativeAction } from "./desktopRuntime";
import { masterHostInUse } from "./masterHost";
import { playbackContext } from "./playbackAudio";
import { getPref } from "./prefs";
import { formatElapsed, isFatal, joinBlocks, takeBatch } from "./recordingCore";
import type { RecordingConverted, RecordingStatus } from "./types";

export type RecordingState =
  | { status: "off" }
  | { status: "starting" }
  | { status: "on" | "stopping"; seconds: number; clipped: number; armed: boolean };

const FLUSH_MS = 1000;
const BATCH_SECONDS = 5;
const SENDS_PER_TICK = 4; // catches up after a slow spell
const REQUEST_TIMEOUT_MS = 10_000;
const GIVE_UP_MS = 30_000; // nothing acknowledged this long: stop (the queue then holds ~11 MB at 48 kHz)
const MODULE_TIMEOUT_MS = 5000;
const STOP_FLUSH_MS = 15_000; // the last seconds may take this long to land at stop
const MAX_QUEUE_SECONDS = 60; // audio waiting in memory beyond this: the disk cannot keep up, stop
const TAP_FRAMES = 4096; // ~85 ms per worklet message at 48 kHz (the VST3 host keeps 256)
const ARM_MS = 3000;
const CLIP_HINT = "Κάποια σημεία ψαλιδίστηκαν· την επόμενη φορά άνοιξε τον Maximizer ή χαμήλωσε λίγο τα faders ή το trim.";

interface Session {
  id: string;
  file: string;
  /** Read at REC: changing the setting mid-set does not change this recording. */
  aacBitrate: 128 | 256 | null;
  ctx: AudioContext;
  tap: AudioWorkletNode;
  port: MessagePort;
  queue: Float32Array[];
  queuedSamples: number;
  /** Frames the tap delivered: the timer shows audio that really flows, not wall time. */
  capturedFrames: number;
  nextSeq: number;
  pending: { seq: number; data: Float32Array<ArrayBuffer> } | null;
  sending: Promise<void> | null;
  lastAck: number;
  startedAt: number;
  clipped: number;
  armed: boolean;
  timer?: ReturnType<typeof setInterval>;
  armTimer?: ReturnType<typeof setTimeout>;
}

let session: Session | null = null;
let state: RecordingState = { status: "off" };
const listeners = new Set<() => void>();
function publish(next: RecordingState) {
  state = next;
  listeners.forEach(listener => listener());
}
const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
};
const getState = () => state;
export const useRecording = () => useSyncExternalStore(subscribe, getState, getState);
/** Read inside the single-deck gate; not a hook dependency, so REC never re-routes a playing deck. */
export const recordingActive = () => state.status !== "off";

/** The backend's Greek detail; a timeout or a browser error in English becomes a Greek line. */
function messageOf(error: unknown): string {
  if (error instanceof DOMException && (error.name === "TimeoutError" || error.name === "AbortError")) return "ο server της εφαρμογής δεν απαντά";
  const text = (error instanceof Error ? error.message : String(error)).replace(/^\d{3}: /, "");
  return /[\u0370-\u03ff]/.test(text) ? text : "απρόσμενο σφάλμα";
}
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
const capturedSeconds = (s: Session) => s.capturedFrames / s.ctx.sampleRate;

function publishRunning(s: Session) {
  if (session !== s) return;
  publish({ status: state.status === "stopping" ? "stopping" : "on", seconds: capturedSeconds(s), clipped: s.clipped, armed: s.armed });
}

function revealAction(file: string) {
  return isDesktopRuntime()
    ? { label: "Εμφάνιση στον φάκελο", onClick: () => void nativeAction("reveal_path", { recording: file }).catch(error => toast.error(messageOf(error))) }
    : undefined;
}

/** Sends the pending chunk, or freezes the next batch from the queue as one. A retryable failure keeps it pending. */
function sendOnce(s: Session): Promise<void> {
  if (s.sending) return s.sending;
  if (!s.pending) {
    if (!s.queue.length) return Promise.resolve();
    const [batch, rest] = takeBatch(s.queue, s.ctx.sampleRate * 2 * BATCH_SECONDS);
    s.pending = { seq: s.nextSeq++, data: joinBlocks(batch) };
    s.queue = rest;
    s.queuedSamples -= s.pending.data.length;
  }
  const { seq, data } = s.pending;
  s.sending = api.recordingChunk(s.id, seq, data, AbortSignal.timeout(REQUEST_TIMEOUT_MS)).then(status => {
    s.pending = null;
    s.lastAck = performance.now();
    s.clipped = status.clipped;
  }, error => {
    if (isFatal(error) || performance.now() - s.lastAck > GIVE_UP_MS) throw error;
  }).finally(() => { s.sending = null; });
  return s.sending;
}

async function pump(s: Session) {
  for (let i = 0; i < SENDS_PER_TICK; i++) {
    await sendOnce(s);
    if (s.pending || !s.queue.length) return;
  }
}

// The tap stops posting; blocks it already posted still reach the port.
function release(s: Session) {
  clearInterval(s.timer);
  clearTimeout(s.armTimer);
  removeMasterTap(s.ctx, s.tap);
  s.tap.port.postMessage({ stop: true });
  s.tap.disconnect();
}

/** The final message: success, or a warning when the last seconds did not land. */
function saved(file: string, seconds: number, clipped: number, missing: string | null) {
  const description = [file, missing, clipped ? CLIP_HINT : null].filter(Boolean).join(" · ");
  if (missing === null) {
    toast.success(`Η εγγραφή αποθηκεύτηκε (${formatElapsed(seconds)})`, { description, action: revealAction(file), duration: 20_000 });
  } else {
    toast.warning(`Η εγγραφή αποθηκεύτηκε χωρίς τα τελευταία δευτερόλεπτα (${formatElapsed(seconds)})`,
      { description, action: revealAction(file), duration: Infinity });
  }
}

/** WAV → AAC after the recording; on failure the WAV stays and the message says so. */
async function convertThenSave(result: RecordingStatus, bitrate: 128 | 256, missing: string | null) {
  const loading = toast.loading(`Μετατροπή σε AAC ${bitrate} kbps…`, { description: result.file });
  let converted: RecordingConverted | null = null;
  try {
    converted = await api.recordingConvert(result.file, bitrate);
  } catch (error) {
    toast.dismiss(loading);
    toast.error(`Η μετατροπή σε AAC απέτυχε: ${messageOf(error)}`, {
      description: `Η εγγραφή κρατήθηκε ως WAV: ${result.file}`, action: revealAction(result.file), duration: Infinity,
    });
    return;
  }
  toast.dismiss(loading);
  saved(converted.file, converted.seconds, result.clipped, missing);
}

async function abort(s: Session, error: unknown) {
  if (session !== s || state.status !== "on") return;
  session = null;
  release(s);
  s.port.close();
  publish({ status: "off" });
  toast.error(`Η εγγραφή σταμάτησε: ${messageOf(error)}`, {
    description: `${s.file} κρατά ό,τι γράφτηκε ως τότε (${formatElapsed((s.lastAck - s.startedAt) / 1000)} περίπου).`,
    action: revealAction(s.file),
    duration: Infinity,
  });
  await api.recordingStop(s.id).catch(() => {}); // already closed when the backend stopped it
}

function withTimeout<T>(work: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("η μηχανή ήχου δεν απάντησε")), ms); });
  return Promise.race([work, late]).finally(() => clearTimeout(timer));
}

/** Call `unlockPlaybackAudio()` in the click first. */
export async function startRecording(): Promise<void> {
  const ctx = playbackContext();
  if (!ctx || session || state.status !== "off") return;
  // While the decks go through the VST3 plugins the bus carries nothing: the take would be silent.
  if (masterHostInUse()) {
    toast.error("Η εγγραφή δεν ξεκινά όσο ο ήχος περνά από plugins VST3· σταμάτησέ τα πρώτα στις Ρυθμίσεις → Αναπαραγωγή.");
    return;
  }
  publish({ status: "starting" });
  let started: RecordingStatus | null = null;
  try {
    const { default: tapUrl } = await import("./audio/master-tap.worklet.js?worker&url");
    await withTimeout(ctx.audioWorklet.addModule(tapUrl), MODULE_TIMEOUT_MS);
    started = await api.recordingStart(Math.round(ctx.sampleRate), AbortSignal.timeout(REQUEST_TIMEOUT_MS));
    const tap = new AudioWorkletNode(ctx, "cratemind-master-tap", {
      numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [2], channelCount: 2, channelCountMode: "explicit",
      processorOptions: { frames: TAP_FRAMES },
    });
    const channel = new MessageChannel();
    const now = performance.now();
    const format = getPref("recordingFormat");
    const s: Session = { id: started.id, file: started.file, aacBitrate: format === "aac256" ? 256 : format === "aac128" ? 128 : null,
      ctx, tap, port: channel.port2, queue: [], queuedSamples: 0,
      capturedFrames: 0, nextSeq: 0, pending: null, sending: null, lastAck: now, startedAt: now, clipped: 0, armed: false };
    channel.port2.onmessage = ({ data }) => {
      if (!(data instanceof Float32Array)) return;
      s.queue.push(data);
      s.queuedSamples += data.length;
      s.capturedFrames += data.length / 2;
    };
    tap.port.postMessage({ port: channel.port1 }, [channel.port1]);
    tap.connect(ctx.destination); // silent output: keeps the tap pulled
    addMasterTap(ctx, tap);
    session = s;
    s.timer = setInterval(() => {
      publishRunning(s);
      if (s.queuedSamples > MAX_QUEUE_SECONDS * ctx.sampleRate * 2) {
        void abort(s, new Error("ο δίσκος δεν προλαβαίνει να γράψει τον ήχο"));
        return;
      }
      pump(s).catch(error => void abort(s, error));
    }, FLUSH_MS);
    publishRunning(s);
  } catch (error) {
    publish({ status: "off" });
    if (started) void api.recordingStop(started.id).catch(() => {});
    toast.error(`Η εγγραφή δεν ξεκίνησε: ${messageOf(error)}`);
  }
}

async function stopWithRetries(id: string): Promise<RecordingStatus> {
  for (let tries = 0; ; tries++) {
    try {
      return await api.recordingStop(id, AbortSignal.timeout(REQUEST_TIMEOUT_MS));
    } catch (error) {
      if (isFatal(error) || tries >= 4) throw error;
      await sleep(250);
    }
  }
}

export async function stopRecording(): Promise<void> {
  const s = session;
  if (!s || state.status !== "on") return;
  publish({ status: "stopping", seconds: capturedSeconds(s), clipped: s.clipped, armed: false });
  release(s);
  await sleep(150); // the blocks already posted arrive
  s.port.onmessage = null;
  s.port.close();
  // The last seconds: retried 250 ms apart until they land or STOP_FLUSH_MS passes.
  let flushError: unknown = null;
  const deadline = performance.now() + STOP_FLUSH_MS;
  try {
    while ((s.sending || s.pending || s.queue.length) && performance.now() < deadline) {
      await pump(s);
      if (s.pending) await sleep(250);
    }
  } catch (error) {
    flushError = error;
  }
  const incomplete = Boolean(s.pending || s.queue.length);
  session = null;
  let result: RecordingStatus;
  try {
    result = await stopWithRetries(s.id);
  } catch (error) {
    // A 404 here means the backend already closed the file: its own reason is the flush error.
    toast.error(`Η εγγραφή σταμάτησε με σφάλμα: ${messageOf(flushError ?? error)}`, {
      description: `${s.file} κρατά ό,τι γράφτηκε.`,
      action: revealAction(s.file),
      duration: Infinity,
    });
    publish({ status: "off" });
    return;
  }
  publish({ status: "off" }); // a new recording may start while the last one converts
  const missing = incomplete ? (flushError ? messageOf(flushError) : "τα τελευταία δευτερόλεπτα δεν γράφτηκαν") : null;
  if (s.aacBitrate) await convertThenSave(result, s.aacBitrate, missing);
  else saved(result.file, result.seconds, result.clipped, missing);
}

/** The first press arms for 3 s, the second stops: a stray click mid-set never ends the recording. */
export function pressStop(): void {
  const s = session;
  if (!s || state.status !== "on") return;
  if (s.armed) {
    void stopRecording();
    return;
  }
  s.armed = true;
  publishRunning(s);
  s.armTimer = setTimeout(() => {
    s.armed = false;
    publishRunning(s);
  }, ARM_MS);
}

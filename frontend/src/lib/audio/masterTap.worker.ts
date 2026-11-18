// Experimental VST3 slots: owns the loopback WebSocket. Audio arrives from the tap worklet (`decks: true`) through
// the shared ring (masterRing.ts) or as headed frames on a MessagePort and goes out as binary frames (a 32-byte
// header, then AL, AR, BL, BR f32 per frame); the host's JSON stats come back to the page.
import { drainRing, ringViews, waitAsync, type RingViews } from "./masterRing";

const MAX_BUFFERED = 524288; // bytes queued in the socket (~0.7 s of 4-channel audio); above this, frames are dropped
const LATE_MS = 20;

type Scope = {
  onmessage: ((event: MessageEvent) => void) | null;
  postMessage(message: unknown): void;
  close(): void;
};
const scope = self as unknown as Scope;
let socket: WebSocket | null = null;
// Delivery jitter on the page's side, reported with each stats message from the host.
let lastFrame = 0, tapGap = 0, tapGapMax = 0, tapLate = 0, dropped = 0;
// Shared path only: overruns since the socket opened, and the deepest wait in the ring (frames) while open.
let overrunsAtOpen = 0, peakFill = 0;

function noteChunk() {
  const now = performance.now();
  if (lastFrame) {
    const gap = now - lastFrame;
    tapGap = Math.max(tapGap, gap);
    tapGapMax = Math.max(tapGapMax, gap);
    if (gap > LATE_MS) tapLate++;
  }
  lastFrame = now;
}

// Wakes when the worklet has written a whole chunk; each pass waits on the write position it loaded first,
// so a block written meanwhile returns at once and nothing spins while less than a chunk waits.
async function pump(views: RingViews, ws: WebSocket, send: (frame: ArrayBuffer) => void) {
  const wait = waitAsync()!;
  for (;;) {
    const w = Atomics.load(views.h, 0);
    if (ws.readyState >= WebSocket.CLOSING) return;
    try {
      // Until the socket opens, the backlog is discarded (a send while connecting would throw).
      if (ws.readyState === WebSocket.CONNECTING) Atomics.store(views.h, 1, w);
      else peakFill = Math.max(peakFill, drainRing(views, w, send));
    } catch { /* one bad pass never ends the loop */ }
    await wait(views.h, 0, w, 1000).value;
  }
}

scope.onmessage = event => {
  const { port, ring: shared, url, stop } = event.data as { port?: MessagePort; ring?: SharedArrayBuffer; url?: string; stop?: boolean };
  if (stop) {
    socket?.close();
    scope.close();
    return;
  }
  if ((!port && !shared) || !url || socket) return;
  const ws = socket = new WebSocket(url);
  ws.binaryType = "arraybuffer";
  const views = shared ? ringViews(shared) : null;
  ws.onopen = () => {
    if (views) overrunsAtOpen = Atomics.load(views.h, 2);
    scope.postMessage({ open: true });
  };
  ws.onmessage = message => {
    if (typeof message.data !== "string") return;
    const stats = JSON.parse(message.data);
    const rate = stats.sample_rate;
    scope.postMessage({ stats: {
      ...stats, tap_gap_ms: Math.round(tapGap * 10) / 10, tap_gap_session_ms: Math.round(tapGapMax * 10) / 10, tap_late: tapLate, dropped,
      path: views ? "shared" : "port", ring_overruns: views ? Atomics.load(views.h, 2) - overrunsAtOpen : 0,
      ring_peak_ms: rate > 0 ? Math.round(peakFill * 10_000 / rate) / 10 : 0,
    } });
    tapGap = 0;
  };
  ws.onclose = () => scope.postMessage({ closed: true });
  const send = (frame: ArrayBuffer) => {
    noteChunk();
    if (ws.bufferedAmount <= MAX_BUFFERED) ws.send(frame);
    else dropped++;
  };
  if (views) void pump(views, ws, send);
  else port!.onmessage = frame => {
    if (ws.readyState === WebSocket.OPEN) send(frame.data as ArrayBuffer);
    else noteChunk();
  };
};

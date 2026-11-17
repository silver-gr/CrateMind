// Experimental VST3 master host: owns the loopback WebSocket. Audio buffers arrive from the tap
// worklet on a MessagePort and go out as binary frames; the host's JSON stats come back to the page.
const MAX_BUFFERED = 262144; // bytes queued in the socket (~0.7 s of audio); above this, frames are dropped
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

scope.onmessage = event => {
  const { port, url, stop } = event.data as { port?: MessagePort; url?: string; stop?: boolean };
  if (stop) {
    socket?.close();
    scope.close();
    return;
  }
  if (!port || !url || socket) return;
  const ws = socket = new WebSocket(url);
  ws.binaryType = "arraybuffer";
  ws.onopen = () => scope.postMessage({ open: true });
  ws.onmessage = message => {
    if (typeof message.data !== "string") return;
    scope.postMessage({ stats: { ...JSON.parse(message.data), tap_gap_ms: Math.round(tapGap * 10) / 10, tap_gap_session_ms: Math.round(tapGapMax * 10) / 10, tap_late: tapLate, dropped } });
    tapGap = 0;
  };
  ws.onclose = () => scope.postMessage({ closed: true });
  port.onmessage = frame => {
    const now = performance.now();
    if (lastFrame) {
      const gap = now - lastFrame;
      tapGap = Math.max(tapGap, gap);
      tapGapMax = Math.max(tapGapMax, gap);
      if (gap > LATE_MS) tapLate++;
    }
    lastFrame = now;
    if (ws.readyState !== WebSocket.OPEN) return;
    if (ws.bufferedAmount <= MAX_BUFFERED) ws.send(frame.data as Float32Array<ArrayBuffer>);
    else dropped++;
  };
};

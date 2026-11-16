// Experimental VST3 master host: owns the loopback WebSocket. Audio buffers arrive from the tap
// worklet on a MessagePort and go out as binary frames; the host's JSON stats come back to the page.
const MAX_BUFFERED = 32768; // bytes queued in the socket; above this, frames are dropped

type Scope = {
  onmessage: ((event: MessageEvent) => void) | null;
  postMessage(message: unknown): void;
  close(): void;
};
const scope = self as unknown as Scope;
let socket: WebSocket | null = null;

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
    if (typeof message.data === "string") scope.postMessage({ stats: JSON.parse(message.data) });
  };
  ws.onclose = () => scope.postMessage({ closed: true });
  port.onmessage = frame => {
    if (ws.readyState === WebSocket.OPEN && ws.bufferedAmount <= MAX_BUFFERED) ws.send(frame.data as Float32Array<ArrayBuffer>);
  };
};

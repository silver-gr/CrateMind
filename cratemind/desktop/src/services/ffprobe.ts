// ffprobe JSON probing. In the Deno desktop port ffprobe is the ONLY source of
// both embedded tags (metadata.ts) and stream info (this file) — it replaces
// both Mutagen (backend/app/services/metadata_reader.py) and the Python
// ffprobe_reader.py in one subprocess call per file (see guide §11).
//
// Read-only: this module only ever spawns `ffprobe ... <path>`, never writes
// to, moves, or retags the probed file.

const PROBE_TIMEOUT_MS = 30_000;

export interface FfprobeFormat {
  filename?: string;
  format_name?: string;
  duration?: string;
  bit_rate?: string;
  tags?: Record<string, string>;
}

export interface FfprobeStream {
  codec_type?: string;
  codec_name?: string;
  sample_rate?: string;
  channels?: number;
  duration?: string;
  bit_rate?: string;
  tags?: Record<string, string>;
}

export interface FfprobeJson {
  format?: FfprobeFormat;
  streams?: FfprobeStream[];
}

export interface StreamInfo {
  duration?: number;
  bitrate?: number;
  sample_rate?: number;
  channels?: number;
  codec?: string;
  container?: string;
}

/** Runs ffprobe against `path` and returns the parsed JSON, or null if
 * ffprobe is unavailable, times out (30s, then killed), or fails to
 * produce parseable output. Never throws. */
export async function probe(
  ffprobePath: string | null,
  path: string,
): Promise<FfprobeJson | null> {
  if (!ffprobePath) return null;

  const command = new Deno.Command(ffprobePath, {
    args: ["-v", "quiet", "-print_format", "json", "-show_format", "-show_streams", path],
    stdout: "piped",
    stderr: "piped",
  });

  let child: Deno.ChildProcess;
  try {
    child = command.spawn();
  } catch {
    return null;
  }

  const timer = setTimeout(() => {
    try {
      child.kill("SIGKILL");
    } catch {
      // already exited
    }
  }, PROBE_TIMEOUT_MS);

  try {
    const output = await child.output();
    if (!output.success || output.stdout.byteLength === 0) return null;
    try {
      return JSON.parse(new TextDecoder().decode(output.stdout)) as FfprobeJson;
    } catch {
      return null;
    }
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

function asFloat(v: string | undefined): number | undefined {
  if (v === undefined) return undefined;
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
}

function asInt(v: string | number | undefined): number | undefined {
  if (v === undefined) return undefined;
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? Math.trunc(n) : undefined;
}

/** Derives duration/bitrate/sample_rate/channels/codec/container from an
 * already-parsed ffprobe JSON document. Port of ffprobe_reader.py:read_stream
 * minus the subprocess call (probe() above owns that). Returns {} when the
 * document has nothing usable — callers must not depend on stream info being
 * present. */
export function readStreamInfo(data: FfprobeJson | null): StreamInfo {
  if (!data) return {};
  const fmt = data.format ?? {};
  const streams = data.streams ?? [];
  const audio = streams.find((s) => s.codec_type === "audio") ?? {};

  const out: StreamInfo = {};

  const duration = asFloat(fmt.duration) ?? asFloat(audio.duration);
  if (duration !== undefined) out.duration = duration;

  const bitrate = asInt(fmt.bit_rate) ?? asInt(audio.bit_rate);
  if (bitrate !== undefined) out.bitrate = bitrate;

  const sampleRate = asInt(audio.sample_rate);
  if (sampleRate !== undefined) out.sample_rate = sampleRate;

  const channels = asInt(audio.channels);
  if (channels !== undefined) out.channels = channels;

  if (audio.codec_name) out.codec = audio.codec_name;

  const container = (fmt.format_name ?? "").split(",")[0];
  if (container) out.container = container;

  return out;
}

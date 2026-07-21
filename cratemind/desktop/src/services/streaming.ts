// HTTP byte-range streaming helpers for the audition player.
//
// Ported from backend/app/services/streaming.py. Pure, testable functions:
// content-type lookup, Range header parsing, and a chunked file stream that
// never loads a whole file into memory.
//
// AIFF/AIF are intentionally absent — browsers cannot decode them natively,
// so callers get an UnsupportedMediaError (route layer turns that into 415)
// rather than streaming bytes no <audio> element can play. Transcoding is
// left as a future enhancement.

const CHUNK = 64 * 1024;

/** extension (no dot, lowercase) -> Content-Type, restricted to browser-playable. */
export const AUDIO_MIME: Record<string, string> = {
  mp3: "audio/mpeg",
  m4a: "audio/mp4",
  mp4: "audio/mp4",
  aac: "audio/aac",
  ogg: "audio/ogg",
  opus: "audio/ogg",
  wav: "audio/wav",
  flac: "audio/flac",
};

function normalizeExt(extension: string): string {
  return extension.toLowerCase().replace(/^\./, "");
}

function contentTypeFor(extension: string): string | undefined {
  return AUDIO_MIME[normalizeExt(extension)];
}

/** Thrown by streamResponse() when the track's extension has no browser-playable
 * Content-Type (e.g. AIFF/AIF). Callers (route layer) should map this to a 415
 * `{detail}` response — the one place T2 does NOT produce the response itself,
 * since 415 uses the normal error shape rather than the audio-specific 416. */
export class UnsupportedMediaError extends Error {
  extension: string;

  constructor(extension: string) {
    super(`unsupported audio format for in-browser audition: .${normalizeExt(extension)}`);
    this.name = "UnsupportedMediaError";
    this.extension = extension;
  }
}

/** Parse result for a single-range `Range: bytes=...` header.
 *
 *   null              -> no Range header (serve full file, 200)
 *   [start, end]      -> inclusive byte range (serve 206)
 *   "invalid"         -> unsatisfiable / malformed (serve 416)
 */
export type RangeParse = [number, number] | null | "invalid";

function parseIntStrict(s: string): number | null {
  if (!/^-?\d+$/.test(s)) return null;
  const n = Number(s);
  return Number.isSafeInteger(n) ? n : null;
}

/** Parse a single-range `Range: bytes=...` header. Mirrors streaming.py:parse_range. */
export function parseRange(header: string | null | undefined, size: number): RangeParse {
  if (!header) return null;
  const trimmed = header.trim();
  if (!trimmed.startsWith("bytes=")) return "invalid";
  const spec = trimmed.slice("bytes=".length).trim();
  if (spec.includes(",") || !spec.includes("-")) return "invalid"; // multi-range unsupported
  const dashIndex = spec.indexOf("-");
  const startS = spec.slice(0, dashIndex);
  const endS = spec.slice(dashIndex + 1);

  let start: number;
  let end: number;
  if (startS === "") {
    // suffix form: bytes=-N -> last N bytes
    const n = parseIntStrict(endS);
    if (n === null || n <= 0) return "invalid";
    start = Math.max(0, size - n);
    end = size - 1;
  } else {
    const s = parseIntStrict(startS);
    if (s === null) return "invalid";
    start = s;
    if (endS === "") {
      end = size - 1;
    } else {
      const e = parseIntStrict(endS);
      if (e === null) return "invalid";
      end = e;
    }
  }

  if (start < 0 || start > end || start >= size) return "invalid";
  return [start, Math.min(end, size - 1)];
}

/** Streams bytes[start, end] (inclusive) from `path` in fixed-size chunks via
 * Deno.open, never buffering the whole file. cancel() closes the file handle. */
function streamFileRange(path: string, start: number, end: number): ReadableStream<Uint8Array> {
  let remaining = end - start + 1;
  let file: Deno.FsFile | null = null;

  return new ReadableStream<Uint8Array>({
    async start() {
      file = await Deno.open(path, { read: true });
      if (start > 0) {
        await file.seek(start, Deno.SeekMode.Start);
      }
    },
    async pull(controller) {
      if (remaining <= 0 || file === null) {
        file?.close();
        file = null;
        controller.close();
        return;
      }
      const buffer = new Uint8Array(Math.min(CHUNK, remaining));
      const bytesRead = await file.read(buffer);
      if (bytesRead === null || bytesRead === 0) {
        file.close();
        file = null;
        controller.close();
        return;
      }
      remaining -= bytesRead;
      controller.enqueue(buffer.subarray(0, bytesRead));
    },
    cancel() {
      file?.close();
      file = null;
    },
  });
}

/** Builds the full Response for `GET /api/tracks/:id/audio` given an already
 * -resolved file path/extension/size (404 track-not-found and 410 missing-file
 * are the route layer's responsibility, since those need a DB lookup + stat
 * this module doesn't own). Never loads a whole file into memory. */
export async function streamResponse(
  path: string,
  ext: string,
  rangeHeader: string | null,
  fileSize: number,
): Promise<Response> {
  const contentType = contentTypeFor(ext);
  if (contentType === undefined) {
    throw new UnsupportedMediaError(ext);
  }

  const range = parseRange(rangeHeader, fileSize);

  if (range === "invalid") {
    return new Response(null, {
      status: 416,
      headers: {
        "Content-Range": `bytes */${fileSize}`,
        "Accept-Ranges": "bytes",
      },
    });
  }

  const isPartial = range !== null;
  const [start, end] = range ?? [0, Math.max(fileSize - 1, 0)];
  const body = streamFileRange(path, start, end);

  const headers: Record<string, string> = {
    "Accept-Ranges": "bytes",
    "Content-Type": contentType,
    // Full-file Content-Length is the file's actual size (not end-start+1) so
    // the empty-file edge case (size 0) stays consistent with the real body
    // length, matching streaming.py's stream_audio.
    "Content-Length": isPartial ? String(end - start + 1) : String(fileSize),
  };
  if (isPartial) {
    headers["Content-Range"] = `bytes ${start}-${end}/${fileSize}`;
  }

  return new Response(body, { status: isPartial ? 206 : 200, headers });
}

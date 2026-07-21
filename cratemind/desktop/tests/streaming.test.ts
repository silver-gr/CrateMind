import { assert, assertEquals, assertRejects } from "@std/assert";
import {
  AUDIO_MIME,
  parseRange,
  streamResponse,
  UnsupportedMediaError,
} from "../src/services/streaming.ts";

// ---------------------------------------------------------------------------
// parseRange
// ---------------------------------------------------------------------------

Deno.test("parseRange: no header -> null (full file)", () => {
  assertEquals(parseRange(null, 1000), null);
  assertEquals(parseRange(undefined, 1000), null);
  assertEquals(parseRange("", 1000), null);
});

Deno.test("parseRange: valid bounded range", () => {
  assertEquals(parseRange("bytes=0-99", 1000), [0, 99]);
});

Deno.test("parseRange: suffix range (last N bytes)", () => {
  assertEquals(parseRange("bytes=-50", 1000), [950, 999]);
});

Deno.test("parseRange: open-ended range", () => {
  assertEquals(parseRange("bytes=100-", 1000), [100, 999]);
});

Deno.test("parseRange: end clamped to size-1", () => {
  assertEquals(parseRange("bytes=0-999999", 1000), [0, 999]);
});

Deno.test("parseRange: multi-range is rejected", () => {
  assertEquals(parseRange("bytes=0-99,200-300", 1000), "invalid");
});

Deno.test("parseRange: wrong unit is rejected", () => {
  assertEquals(parseRange("items=0-99", 1000), "invalid");
});

Deno.test("parseRange: start beyond size is rejected", () => {
  assertEquals(parseRange("bytes=999999999-", 1000), "invalid");
});

Deno.test("parseRange: start > end is rejected", () => {
  assertEquals(parseRange("bytes=50-10", 1000), "invalid");
});

Deno.test("parseRange: non-numeric is rejected", () => {
  assertEquals(parseRange("bytes=abc-99", 1000), "invalid");
});

Deno.test("parseRange: zero-length suffix is rejected", () => {
  assertEquals(parseRange("bytes=-0", 1000), "invalid");
});

Deno.test("parseRange: malformed spec with no dash is rejected", () => {
  assertEquals(parseRange("bytes=", 1000), "invalid");
});

// ---------------------------------------------------------------------------
// streamResponse
// ---------------------------------------------------------------------------

async function makeTempFile(bytes: Uint8Array): Promise<{ path: string; cleanup(): Promise<void> }> {
  const dir = await Deno.makeTempDir({ prefix: "cratemind-streaming-test-" });
  const path = `${dir}/audio.bin`;
  await Deno.writeFile(path, bytes);
  return {
    path,
    async cleanup() {
      await Deno.remove(dir, { recursive: true });
    },
  };
}

function randomBytes(size: number): Uint8Array {
  const buf = new Uint8Array(size);
  crypto.getRandomValues(buf); // crypto.getRandomValues caps at 65536 per call
  return buf;
}

function fillRandom(size: number): Uint8Array {
  const buf = new Uint8Array(size);
  const CHUNK = 65536;
  for (let offset = 0; offset < size; offset += CHUNK) {
    buf.set(randomBytes(Math.min(CHUNK, size - offset)), offset);
  }
  return buf;
}

Deno.test("streamResponse: full file 200 response, AUDIO_MIME content-type", async () => {
  const content = new TextEncoder().encode("hello world audio bytes");
  const f = await makeTempFile(content);
  try {
    const res = await streamResponse(f.path, "mp3", null, content.byteLength);
    assertEquals(res.status, 200);
    assertEquals(res.headers.get("accept-ranges"), "bytes");
    assertEquals(res.headers.get("content-length"), String(content.byteLength));
    assertEquals(res.headers.get("content-type"), AUDIO_MIME.mp3);
    assertEquals(res.headers.has("content-range"), false);
    const body = new Uint8Array(await res.arrayBuffer());
    assertEquals(body, content);
  } finally {
    await f.cleanup();
  }
});

Deno.test("streamResponse: valid range returns 206 with exact slice", async () => {
  const content = new TextEncoder().encode("0123456789abcdefghijklmnopqrstuvwxyz");
  const f = await makeTempFile(content);
  try {
    const res = await streamResponse(f.path, "wav", "bytes=0-9", content.byteLength);
    assertEquals(res.status, 206);
    assertEquals(res.headers.get("content-range"), `bytes 0-9/${content.byteLength}`);
    assertEquals(res.headers.get("content-length"), "10");
    const body = new Uint8Array(await res.arrayBuffer());
    assertEquals(body, content.subarray(0, 10));
  } finally {
    await f.cleanup();
  }
});

Deno.test("streamResponse: suffix range returns last N bytes", async () => {
  const content = new TextEncoder().encode("0123456789abcdefghijklmnopqrstuvwxyz");
  const f = await makeTempFile(content);
  try {
    const res = await streamResponse(f.path, "wav", "bytes=-5", content.byteLength);
    assertEquals(res.status, 206);
    const size = content.byteLength;
    assertEquals(res.headers.get("content-range"), `bytes ${size - 5}-${size - 1}/${size}`);
    const body = new Uint8Array(await res.arrayBuffer());
    assertEquals(body, content.subarray(size - 5));
  } finally {
    await f.cleanup();
  }
});

Deno.test("streamResponse: open-ended range streams to EOF", async () => {
  const content = new TextEncoder().encode("0123456789abcdefghijklmnopqrstuvwxyz");
  const f = await makeTempFile(content);
  try {
    const res = await streamResponse(f.path, "wav", "bytes=10-", content.byteLength);
    assertEquals(res.status, 206);
    const size = content.byteLength;
    assertEquals(res.headers.get("content-range"), `bytes 10-${size - 1}/${size}`);
    const body = new Uint8Array(await res.arrayBuffer());
    assertEquals(body, content.subarray(10));
  } finally {
    await f.cleanup();
  }
});

Deno.test("streamResponse: invalid range returns 416 empty body + Content-Range: bytes */N", async () => {
  const content = new TextEncoder().encode("0123456789");
  const f = await makeTempFile(content);
  try {
    const res = await streamResponse(f.path, "mp3", "bytes=999999-", content.byteLength);
    assertEquals(res.status, 416);
    assertEquals(res.headers.get("content-range"), `bytes */${content.byteLength}`);
    const body = new Uint8Array(await res.arrayBuffer());
    assertEquals(body.byteLength, 0);
  } finally {
    await f.cleanup();
  }
});

Deno.test("streamResponse: multi-range header returns 416", async () => {
  const content = new TextEncoder().encode("0123456789");
  const f = await makeTempFile(content);
  try {
    const res = await streamResponse(f.path, "mp3", "bytes=0-1,2-3", content.byteLength);
    assertEquals(res.status, 416);
    const body = new Uint8Array(await res.arrayBuffer());
    assertEquals(body.byteLength, 0);
  } finally {
    await f.cleanup();
  }
});

Deno.test("streamResponse: unsupported extension throws UnsupportedMediaError", async () => {
  const content = new TextEncoder().encode("riff-ish-aiff-bytes");
  const f = await makeTempFile(content);
  try {
    await assertRejects(
      () => streamResponse(f.path, "aiff", null, content.byteLength),
      UnsupportedMediaError,
    );
    await assertRejects(
      () => streamResponse(f.path, "aif", null, content.byteLength),
      UnsupportedMediaError,
    );
  } finally {
    await f.cleanup();
  }
});

Deno.test("streamResponse: >64KiB file round-trips byte-for-byte (chunked stream)", async () => {
  const size = 64 * 1024 * 3 + 777; // spans multiple 64 KiB chunks, not chunk-aligned
  const content = fillRandom(size);
  const f = await makeTempFile(content);
  try {
    const res = await streamResponse(f.path, "flac", null, size);
    assertEquals(res.status, 200);
    assertEquals(res.headers.get("content-length"), String(size));
    const body = new Uint8Array(await res.arrayBuffer());
    assertEquals(body.byteLength, size);
    assertEquals(body, content);
  } finally {
    await f.cleanup();
  }
});

Deno.test("streamResponse: >64KiB range read is byte-exact across a chunk boundary", async () => {
  const size = 64 * 1024 * 2 + 500;
  const content = fillRandom(size);
  const f = await makeTempFile(content);
  try {
    const start = 64 * 1024 - 10;
    const end = 64 * 1024 + 10;
    const res = await streamResponse(f.path, "flac", `bytes=${start}-${end}`, size);
    assertEquals(res.status, 206);
    const body = new Uint8Array(await res.arrayBuffer());
    assertEquals(body, content.subarray(start, end + 1));
  } finally {
    await f.cleanup();
  }
});

Deno.test("streamResponse: reader.cancel() closes the underlying file (no resource leak)", async () => {
  const size = 64 * 1024 * 2 + 500;
  const content = fillRandom(size);
  const f = await makeTempFile(content);
  try {
    const res = await streamResponse(f.path, "flac", null, size);
    const reader = res.body!.getReader();
    const first = await reader.read();
    assert(!first.done);
    // Cancelling mid-stream must close the file handle; Deno's default
    // resource-leak sanitizer fails this test if it doesn't.
    await reader.cancel();
  } finally {
    await f.cleanup();
  }
});

Deno.test("streamResponse: empty file full response has zero-length body and correct headers", async () => {
  const f = await makeTempFile(new Uint8Array(0));
  try {
    const res = await streamResponse(f.path, "mp3", null, 0);
    assertEquals(res.status, 200);
    assertEquals(res.headers.get("content-length"), "0");
    const body = new Uint8Array(await res.arrayBuffer());
    assertEquals(body.byteLength, 0);
  } finally {
    await f.cleanup();
  }
});

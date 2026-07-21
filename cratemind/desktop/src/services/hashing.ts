// Content hashing for track identity. Port of backend/app/services/hashing.py
// onto Web Crypto SHA-256. Read-only — never writes to source files.

const HEAD_TAIL = 256 * 1024; // 256 KiB from each end

function toHex(buf: ArrayBuffer): string {
  return Array.from(new Uint8Array(buf))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/** Fast content fingerprint: size + first/last N bytes. Stable for a file
 * whose bytes don't change. Returns null if unreadable. */
export async function quickHash(path: string): Promise<string | null> {
  let file: Deno.FsFile;
  try {
    file = await Deno.open(path, { read: true });
  } catch {
    return null;
  }
  try {
    const size = (await file.stat()).size;
    const parts: Uint8Array[] = [new TextEncoder().encode(String(size))];

    const head = new Uint8Array(Math.min(HEAD_TAIL, size));
    await readExact(file, head);
    parts.push(head);

    if (size > HEAD_TAIL) {
      await file.seek(Math.max(0, size - HEAD_TAIL), Deno.SeekMode.Start);
      const tail = new Uint8Array(HEAD_TAIL);
      await readExact(file, tail);
      parts.push(tail);
    }

    const total = parts.reduce((n, p) => n + p.byteLength, 0);
    const combined = new Uint8Array(total);
    let offset = 0;
    for (const p of parts) {
      combined.set(p, offset);
      offset += p.byteLength;
    }
    const digest = await crypto.subtle.digest("SHA-256", combined);
    return toHex(digest);
  } catch {
    return null;
  } finally {
    file.close();
  }
}

/** Full SHA256 of the file. Slower; optional. Returns null if unreadable. */
export async function fullHash(path: string): Promise<string | null> {
  let file: Deno.FsFile;
  try {
    file = await Deno.open(path, { read: true });
  } catch {
    return null;
  }
  try {
    const chunks: Uint8Array[] = [];
    const buf = new Uint8Array(1024 * 1024);
    while (true) {
      const n = await file.read(buf);
      if (n === null) break;
      chunks.push(buf.slice(0, n));
    }
    const total = chunks.reduce((n, c) => n + c.byteLength, 0);
    const combined = new Uint8Array(total);
    let offset = 0;
    for (const c of chunks) {
      combined.set(c, offset);
      offset += c.byteLength;
    }
    const digest = await crypto.subtle.digest("SHA-256", combined);
    return toHex(digest);
  } catch {
    return null;
  } finally {
    file.close();
  }
}

/** Reads into `buf` until it is full or EOF — Deno's file.read() may return
 * short reads, so a single read() call is not guaranteed to fill `buf`. */
async function readExact(file: Deno.FsFile, buf: Uint8Array): Promise<void> {
  let filled = 0;
  while (filled < buf.byteLength) {
    const n = await file.read(buf.subarray(filled));
    if (n === null) break;
    filled += n;
  }
}

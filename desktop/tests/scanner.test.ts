// Wave 1 (T5) test suite: artistNormalizer, hashing, ffprobe, metadata (via
// scanner), scanner, duplicateDetector, fingerprint, jobs.
//
// Mirrors backend/tests/test_scanner.py, test_duplicate_detector.py, and
// test_artist_normalizer.py behaviorally. Every test gets an isolated
// temp-dir DB via makeTestCtx() (see tests/helpers.ts) — nothing here ever
// touches real app data or real library files.

import { assert, assertEquals, assertNotEquals } from "@std/assert";
import { makeTestCtx, seedProfile, seedTrack } from "./helpers.ts";
import {
  normalizeArtist,
  normalizeArtistName,
  primaryArtistName,
} from "../src/services/artistNormalizer.ts";
import { quickHash } from "../src/services/hashing.ts";
import { probe, readStreamInfo } from "../src/services/ffprobe.ts";
import { scanRoots } from "../src/services/scanner.ts";
import { detectDuplicates, normalizeTitle } from "../src/services/duplicateDetector.ts";
import { fingerprintFile } from "../src/services/fingerprint.ts";
import { createJob, getJob, runJob } from "../src/services/jobs.ts";
import type { Track } from "../src/types/models.ts";

// ---------------------------------------------------------------------------
// WAV fixture writer — mirrors backend/tests/conftest.py's make_wav() since
// Deno has no `wave` module. Mono 16-bit PCM @ 8kHz; freqSeed varies bytes so
// distinct fixtures produce distinct content/hashes.
// ---------------------------------------------------------------------------

function writeAscii(buf: Uint8Array, offset: number, s: string): void {
  for (let i = 0; i < s.length; i++) buf[offset + i] = s.charCodeAt(i);
}

function buildWavBytes(seconds: number, freqSeed: number): Uint8Array {
  const rate = 8000;
  const frames = Math.floor(rate * seconds);
  const dataSize = frames * 2; // 16-bit mono
  const buf = new Uint8Array(44 + dataSize);
  const view = new DataView(buf.buffer);

  writeAscii(buf, 0, "RIFF");
  view.setUint32(4, 36 + dataSize, true);
  writeAscii(buf, 8, "WAVE");
  writeAscii(buf, 12, "fmt ");
  view.setUint32(16, 16, true); // Subchunk1Size
  view.setUint16(20, 1, true); // PCM
  view.setUint16(22, 1, true); // NumChannels
  view.setUint32(24, rate, true); // SampleRate
  view.setUint32(28, rate * 2, true); // ByteRate
  view.setUint16(32, 2, true); // BlockAlign
  view.setUint16(34, 16, true); // BitsPerSample
  writeAscii(buf, 36, "data");
  view.setUint32(40, dataSize, true);

  for (let i = 0; i < frames; i++) {
    view.setInt16(44 + i * 2, (i * freqSeed) % 256, true);
  }
  return buf;
}

async function writeWav(path: string, freqSeed: number, seconds = 1.0): Promise<void> {
  const dir = path.slice(0, path.lastIndexOf("/"));
  await Deno.mkdir(dir, { recursive: true });
  await Deno.writeFile(path, buildWavBytes(seconds, freqSeed));
}

/** Real tonal WAV (sine wave) — only used by the fpcalc-gated test below.
 * Chromaprint needs actual spectral/harmonic content to produce a
 * fingerprint; the byte-varying fixture above (matching Python's make_wav,
 * used everywhere else for hashing/filename/folder tests) is deliberately
 * just noise and fpcalc reports "Empty fingerprint" on it. */
function buildSineWavBytes(seconds: number, freqHz: number): Uint8Array {
  const rate = 44100;
  const frames = Math.floor(rate * seconds);
  const dataSize = frames * 2;
  const buf = new Uint8Array(44 + dataSize);
  const view = new DataView(buf.buffer);

  writeAscii(buf, 0, "RIFF");
  view.setUint32(4, 36 + dataSize, true);
  writeAscii(buf, 8, "WAVE");
  writeAscii(buf, 12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, rate, true);
  view.setUint32(28, rate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  writeAscii(buf, 36, "data");
  view.setUint32(40, dataSize, true);

  for (let i = 0; i < frames; i++) {
    const sample = Math.round(Math.sin((2 * Math.PI * freqHz * i) / rate) * 16000);
    view.setInt16(44 + i * 2, sample, true);
  }
  return buf;
}

async function writeSineWav(path: string, seconds = 3.0, freqHz = 440): Promise<void> {
  const dir = path.slice(0, path.lastIndexOf("/"));
  await Deno.mkdir(dir, { recursive: true });
  await Deno.writeFile(path, buildSineWavBytes(seconds, freqHz));
}

async function findOnPath(name: string): Promise<string | null> {
  const pathEnv = Deno.env.get("PATH") ?? "";
  for (const dir of pathEnv.split(":")) {
    if (!dir) continue;
    const candidate = `${dir}/${name}`;
    try {
      const st = await Deno.stat(candidate);
      if (st.isFile) return candidate;
    } catch {
      continue;
    }
  }
  return null;
}

const ffprobeBin = await findOnPath("ffprobe");
const fpcalcBin = await findOnPath("fpcalc");

// ---------------------------------------------------------------------------
// artistNormalizer.ts
// ---------------------------------------------------------------------------

Deno.test("normalizeArtistName collapses case and whitespace", () => {
  assertEquals(normalizeArtistName("  AtYyA  "), "atyya");
  assertEquals(normalizeArtistName("ATYYA"), "atyya");
  assertEquals(normalizeArtistName("Dark_Whisper"), "dark whisper");
  assertEquals(normalizeArtistName("Drip_Drop"), "drip drop");
});

Deno.test("primaryArtistName takes the first collab chunk", () => {
  assertEquals(primaryArtistName("Desert Dwellers & Kaya Project"), "Desert Dwellers");
  assertEquals(normalizeArtist("Technical Hitch feat. XENROX"), "technical hitch");
  assertEquals(primaryArtistName("Dark_Whisper"), "Dark Whisper");
});

Deno.test("normalizeArtistName returns null for empty values", () => {
  assertEquals(normalizeArtistName(""), null);
  assertEquals(normalizeArtistName("   "), null);
  assertEquals(normalizeArtist(null), null);
});

// ---------------------------------------------------------------------------
// hashing.ts
// ---------------------------------------------------------------------------

Deno.test("quickHash is deterministic for the same file", async () => {
  const dir = await Deno.makeTempDir({ prefix: "cratemind-test-" });
  try {
    const p = `${dir}/a.wav`;
    await writeWav(p, 3);
    const h1 = await quickHash(p);
    const h2 = await quickHash(p);
    assert(h1 !== null);
    assertEquals(h1, h2);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

// ---------------------------------------------------------------------------
// scanner.ts (+ metadata.ts / ffprobe.ts through it)
// ---------------------------------------------------------------------------

Deno.test("scan is idempotent", async () => {
  const t = await makeTestCtx();
  try {
    const lib = `${t.dir}/lib`;
    await writeWav(`${lib}/a.wav`, 1);
    await writeWav(`${lib}/b.wav`, 2);

    const s1 = await scanRoots(t.ctx.db, t.ctx.config, [lib], null);
    assertEquals(s1.added, 2);

    const s2 = await scanRoots(t.ctx.db, t.ctx.config, [lib], null);
    assertEquals(s2.added, 0);
    assertEquals(s2.unchanged, 2);

    const rows = t.ctx.db.prepare("SELECT id FROM tracks").all();
    assertEquals(rows.length, 2); // no duplicate rows after repeated scans
  } finally {
    await t.cleanup();
  }
});

Deno.test("removed file is marked missing, never deleted", async () => {
  const t = await makeTestCtx();
  try {
    const lib = `${t.dir}/lib`;
    const aPath = `${lib}/a.wav`;
    await writeWav(aPath, 1);
    await writeWav(`${lib}/b.wav`, 2);
    await scanRoots(t.ctx.db, t.ctx.config, [lib], null);

    await Deno.remove(aPath);
    const stats = await scanRoots(t.ctx.db, t.ctx.config, [lib], null);
    assertEquals(stats.missing, 1);

    const rows = t.ctx.db.prepare("SELECT file_name, missing FROM tracks").all() as {
      file_name: string;
      missing: number;
    }[];
    const byName = Object.fromEntries(rows.map((r) => [r.file_name, r.missing]));
    assertEquals(byName["a.wav"], 1); // row preserved, flagged
    assertEquals(byName["b.wav"], 0);
  } finally {
    await t.cleanup();
  }
});

Deno.test("human profile survives rescan", async () => {
  const t = await makeTestCtx();
  try {
    const lib = `${t.dir}/lib`;
    const aPath = `${lib}/a.wav`;
    await writeWav(aPath, 1);
    await scanRoots(t.ctx.db, t.ctx.config, [lib], null);

    const track = t.ctx.db.prepare("SELECT * FROM tracks LIMIT 1").get() as unknown as Track;
    seedProfile(t.ctx.db, track.id, { energy: 9, personal_status: "weapon" });

    // change the file so the scanner takes the "updated" path
    const bytes = await Deno.readFile(aPath);
    const changed = new Uint8Array(bytes.length + 2);
    changed.set(bytes);
    await Deno.writeFile(aPath, changed);
    await scanRoots(t.ctx.db, t.ctx.config, [lib], null);

    const prof = t.ctx.db
      .prepare("SELECT energy, personal_status FROM track_dj_profile WHERE track_id = ?")
      .get(track.id) as { energy: number; personal_status: string };
    assertEquals(prof.energy, 9);
    assertEquals(prof.personal_status, "weapon");
  } finally {
    await t.cleanup();
  }
});

Deno.test("infers artist from parent folder when filename is title only", async () => {
  const t = await makeTestCtx();
  try {
    const lib = `${t.dir}/lib`;
    await writeWav(`${lib}/ATYYA/Desert.wav`, 1);
    await scanRoots(t.ctx.db, t.ctx.config, [lib], null);

    const track = t.ctx.db.prepare("SELECT * FROM tracks LIMIT 1").get() as unknown as Track;
    assertEquals(track.artist, "ATYYA");
    assertEquals(track.title, "Desert");
    assertEquals(track.artist_normalized, "atyya");
  } finally {
    await t.cleanup();
  }
});

Deno.test("infers artist and album from two-level folders", async () => {
  const t = await makeTestCtx();
  try {
    const lib = `${t.dir}/lib`;
    await writeWav(`${lib}/ATYYA/Live at Boom/Desert.wav`, 1);
    await scanRoots(t.ctx.db, t.ctx.config, [lib], null);

    const track = t.ctx.db.prepare("SELECT * FROM tracks LIMIT 1").get() as unknown as Track;
    assertEquals(track.artist, "ATYYA");
    assertEquals(track.album, "Live at Boom");
    assertEquals(track.title, "Desert");
    assertEquals(track.artist_normalized, "atyya");
  } finally {
    await t.cleanup();
  }
});

Deno.test("uses filename BPM and cleans the title", async () => {
  const t = await makeTestCtx();
  try {
    const lib = `${t.dir}/lib`;
    await writeWav(`${lib}/XENROX/INTO THE WORLD [192] (FREE DOWNLOAD).wav`, 1);
    await scanRoots(t.ctx.db, t.ctx.config, [lib], null);

    const track = t.ctx.db.prepare("SELECT * FROM tracks LIMIT 1").get() as unknown as Track;
    assertEquals(track.artist, "XENROX");
    assertEquals(track.title, "INTO THE WORLD");
    assertEquals(track.bpm, 192);
  } finally {
    await t.cleanup();
  }
});

Deno.test("does not use a label folder as artist when the filename has one", async () => {
  const t = await makeTestCtx();
  try {
    const lib = `${t.dir}/lib`;
    await writeWav(
      `${lib}/Izuran Records/VA-The Arkhetupon Dialectic/Izuran Records - Black Phillip - Place of Dead Roads.wav`,
      1,
    );
    await scanRoots(t.ctx.db, t.ctx.config, [lib], null);

    const track = t.ctx.db.prepare("SELECT * FROM tracks LIMIT 1").get() as unknown as Track;
    assertEquals(track.artist, "Black Phillip");
    assertEquals(track.album, "VA-The Arkhetupon Dialectic");
    assertEquals(track.label, "Izuran Records");
  } finally {
    await t.cleanup();
  }
});

Deno.test("refreshes unchanged rows with cleaned metadata", async () => {
  const t = await makeTestCtx();
  try {
    const lib = `${t.dir}/lib`;
    await writeWav(`${lib}/Crone/Brain Rolling (Kopophobia Rmx) - 207 (Preview).wav`, 1);
    await scanRoots(t.ctx.db, t.ctx.config, [lib], null);

    const track = t.ctx.db.prepare("SELECT * FROM tracks LIMIT 1").get() as unknown as Track;

    // simulate stale/dirty data on an otherwise-unchanged row
    t.ctx.db
      .prepare(
        "UPDATE tracks SET artist = ?, title = ?, bpm = NULL, artist_normalized = NULL WHERE id = ?",
      )
      .run("02", "Brain Rolling (Kopophobia Rmx) - 207 (Preview)", track.id);

    const stats = await scanRoots(t.ctx.db, t.ctx.config, [lib], null);
    const refreshed = t.ctx.db.prepare("SELECT * FROM tracks WHERE id = ?").get(track.id) as unknown as Track;

    assertEquals(stats.updated, 1);
    assertEquals(refreshed.artist, "Crone");
    assertEquals(refreshed.title, "Brain Rolling (Kopophobia Rmx)");
    assertEquals(refreshed.bpm, 207);
    assertEquals(refreshed.artist_normalized, "crone");
  } finally {
    await t.cleanup();
  }
});

Deno.test("scan never mutates source audio bytes or mtime (data-safety invariant)", async () => {
  const t = await makeTestCtx();
  try {
    const lib = `${t.dir}/lib`;
    const paths = [`${lib}/a.wav`, `${lib}/nested/b.wav`];
    await writeWav(paths[0], 1);
    await writeWav(paths[1], 2);

    const before = await Promise.all(
      paths.map(async (p) => ({
        bytes: await Deno.readFile(p),
        mtime: (await Deno.stat(p)).mtime?.getTime() ?? null,
      })),
    );

    await scanRoots(t.ctx.db, t.ctx.config, [lib], null);
    // scan again to exercise the "unchanged" read path too
    await scanRoots(t.ctx.db, t.ctx.config, [lib], null);

    const after = await Promise.all(
      paths.map(async (p) => ({
        bytes: await Deno.readFile(p),
        mtime: (await Deno.stat(p)).mtime?.getTime() ?? null,
      })),
    );

    for (let i = 0; i < paths.length; i++) {
      assertEquals(after[i].bytes, before[i].bytes, `bytes changed for ${paths[i]}`);
      assertEquals(after[i].mtime, before[i].mtime, `mtime changed for ${paths[i]}`);
    }
  } finally {
    await t.cleanup();
  }
});

// ---------------------------------------------------------------------------
// duplicateDetector.ts
// ---------------------------------------------------------------------------

Deno.test("normalizeTitle strips noise words and punctuation the same way for both variants", () => {
  assertEquals(
    normalizeTitle("Mandragora", "X Radio Edit"),
    normalizeTitle("Mandragora", "X (Extended)"),
  );
});

Deno.test("exact byte duplicates are grouped", async () => {
  const t = await makeTestCtx();
  try {
    seedTrack(t.ctx.db, {
      absolute_path: "/x/a.wav",
      artist: "A",
      title: "X",
      quick_hash: "HASH1",
      duration: 200,
    });
    seedTrack(t.ctx.db, {
      absolute_path: "/y/a.wav",
      artist: "A",
      title: "X",
      quick_hash: "HASH1",
      duration: 200,
    });

    const result = detectDuplicates(t.ctx.db);
    assertEquals(result.exact_groups, 1);
  } finally {
    await t.cleanup();
  }
});

Deno.test("radio edit is not merged with extended (different durations, human review)", async () => {
  const t = await makeTestCtx();
  try {
    seedTrack(t.ctx.db, {
      absolute_path: "/a.mp3",
      artist: "Mandragora",
      title: "X Radio Edit",
      quick_hash: "H_A",
      duration: 200,
    });
    seedTrack(t.ctx.db, {
      absolute_path: "/b.mp3",
      artist: "Mandragora",
      title: "X (Extended)",
      quick_hash: "H_B",
      duration: 400,
    });

    const result = detectDuplicates(t.ctx.db);
    assertEquals(result.exact_groups, 0);
    assertEquals(result.metadata_groups, 0);
  } finally {
    await t.cleanup();
  }
});

Deno.test("same recording with similar duration is flagged as a metadata suspect", async () => {
  const t = await makeTestCtx();
  try {
    seedTrack(t.ctx.db, {
      absolute_path: "/a.wav",
      artist: "Astrix",
      title: "Y",
      quick_hash: "A1",
      duration: 300,
    });
    seedTrack(t.ctx.db, {
      absolute_path: "/b.mp3",
      artist: "Astrix",
      title: "Y",
      quick_hash: "B2",
      duration: 302,
    });

    const result = detectDuplicates(t.ctx.db);
    assertEquals(result.metadata_groups, 1);
  } finally {
    await t.cleanup();
  }
});

// ---------------------------------------------------------------------------
// jobs.ts
// ---------------------------------------------------------------------------

Deno.test("runJob transitions pending -> running -> done and is never left stuck running", async () => {
  const t = await makeTestCtx();
  try {
    const job = createJob(t.ctx.db, "scan");
    assertEquals(job.status, "pending");

    const promise = runJob(t.ctx.db, job, async () => {
      return { message: "ok" };
    });

    // status flips synchronously, before the task's own async work settles
    const running = getJob(t.ctx.db, job.id);
    assertEquals(running?.status, "running");

    await promise;

    const done = getJob(t.ctx.db, job.id);
    assertEquals(done?.status, "done");
    assertEquals(done?.message, "ok");
    assertEquals(done?.error, null);
  } finally {
    await t.cleanup();
  }
});

Deno.test("runJob captures task failures as status=error, never stuck running", async () => {
  const t = await makeTestCtx();
  try {
    const job = createJob(t.ctx.db, "fingerprint");

    const promise = runJob(t.ctx.db, job, async () => {
      throw new Error("boom");
    });
    await promise;

    const finished = getJob(t.ctx.db, job.id);
    assertNotEquals(finished?.status, "running");
    assertEquals(finished?.status, "error");
    assertEquals(finished?.error, "boom");
  } finally {
    await t.cleanup();
  }
});

// ---------------------------------------------------------------------------
// ffprobe.ts / fingerprint.ts — only run when the real binary is on PATH
// ---------------------------------------------------------------------------

Deno.test({
  name: "probe() + readStreamInfo() extract real stream info via ffprobe",
  ignore: ffprobeBin === null,
  fn: async () => {
    const dir = await Deno.makeTempDir({ prefix: "cratemind-test-" });
    try {
      const p = `${dir}/a.wav`;
      await writeWav(p, 1, 1.0);
      const data = await probe(ffprobeBin, p);
      assert(data !== null);
      const info = readStreamInfo(data);
      assert(info.duration !== undefined && info.duration > 0);
      assertEquals(info.sample_rate, 8000);
      assertEquals(info.channels, 1);
    } finally {
      await Deno.remove(dir, { recursive: true });
    }
  },
});

Deno.test({
  name: "fingerprintFile writes a fingerprints row via fpcalc",
  ignore: fpcalcBin === null,
  fn: async () => {
    const t = await makeTestCtx();
    try {
      const p = `${t.dir}/a.wav`;
      await writeSineWav(p);
      const trackId = seedTrack(t.ctx.db, { absolute_path: p });

      const ok = await fingerprintFile(t.ctx.db, fpcalcBin, { id: trackId, absolute_path: p });
      assert(ok);

      const row = t.ctx.db
        .prepare("SELECT chromaprint FROM fingerprints WHERE track_id = ?")
        .get(trackId) as { chromaprint: string } | undefined;
      assert(row !== undefined);
      assert(row.chromaprint.length > 0);
    } finally {
      await t.cleanup();
    }
  },
});

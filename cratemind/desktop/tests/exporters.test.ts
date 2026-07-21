// Golden-output + conflict-handling tests for the four export formats.
// Ports the intent of backend/tests/test_export_m3u.py plus coverage for
// exporter_csv.py, exporter_markdown.py, and backup.py:export_json.

import { assert, assertEquals, assertThrows } from "@std/assert";
import type { DatabaseSync } from "node:sqlite";
import { exportM3u, FileExistsError } from "../src/services/exporterM3u.ts";
import { exportCsv } from "../src/services/exporterCsv.ts";
import { exportMarkdown } from "../src/services/exporterMarkdown.ts";
import { exportJsonBackup } from "../src/services/exporterJsonBackup.ts";
import { makeTestCtx, seedProfile, seedTrack } from "./helpers.ts";
import { nowIso } from "../src/utils/time.ts";
import type { DJSetRow, Track } from "../src/types/models.ts";

function getTrack(db: DatabaseSync, id: number): Track {
  return db.prepare("SELECT * FROM tracks WHERE id = ?").get(id) as unknown as Track;
}

// ---- exportM3u ----------------------------------------------------------

Deno.test("exportM3u writes #EXTM3U golden content", async () => {
  const t = await makeTestCtx();
  try {
    const id1 = seedTrack(t.ctx.db, {
      absolute_path: "/music/a.wav",
      artist: "Astrix",
      title: "Deep Jungle Walk",
      duration: 420,
    });
    const id2 = seedTrack(t.ctx.db, {
      absolute_path: "/music/b.mp3",
      artist: "Mandragora",
      title: "X",
      duration: 380,
    });
    const tracks = [getTrack(t.ctx.db, id1), getTrack(t.ctx.db, id2)];

    const dest = `${t.dir}/set.m3u8`;
    exportM3u(tracks, dest, false);
    const text = await Deno.readTextFile(dest);

    assert(text.startsWith("#EXTM3U"));
    assert(text.includes("#EXTINF:420,Astrix - Deep Jungle Walk"));
    assert(text.includes("/music/a.wav"));
    assert(text.includes("/music/b.mp3"));
    assert(text.endsWith("\n"));
  } finally {
    await t.cleanup();
  }
});

Deno.test("exportM3u falls back to Unknown/file_name and -1 duration for nulls", async () => {
  const t = await makeTestCtx();
  try {
    const id = seedTrack(t.ctx.db, {
      absolute_path: "/music/nulls.mp3",
      file_name: "nulls.mp3",
      artist: null,
      title: null,
      duration: null,
    });
    const dest = `${t.dir}/nulls.m3u8`;
    exportM3u([getTrack(t.ctx.db, id)], dest, false);
    const text = await Deno.readTextFile(dest);
    assert(text.includes("#EXTINF:-1,Unknown - nulls.mp3"));
  } finally {
    await t.cleanup();
  }
});

Deno.test("exportM3u throws FileExistsError on conflict, succeeds with overwrite", async () => {
  const t = await makeTestCtx();
  try {
    const id = seedTrack(t.ctx.db);
    const tracks = [getTrack(t.ctx.db, id)];
    const dest = `${t.dir}/set.m3u8`;
    exportM3u(tracks, dest, false);
    assertThrows(() => exportM3u(tracks, dest, false), FileExistsError);
    exportM3u(tracks, dest, true); // explicit overwrite succeeds
  } finally {
    await t.cleanup();
  }
});

// ---- exportCsv ------------------------------------------------------------

Deno.test("exportCsv header + profile-overridden row + null-track row", async () => {
  const t = await makeTestCtx();
  try {
    const idFull = seedTrack(t.ctx.db, {
      absolute_path: "/music/full.flac",
      artist: "Ajja",
      title: "Comma, Test \"Quote\"",
      album: "Album A",
      label: "Label A",
      year: 2020,
      genre: "Psytrance",
      bpm: 145,
      key_text: "8A",
      duration: 300,
    });
    seedProfile(t.ctx.db, idFull, {
      energy: 8,
      intensity: 7,
      darkness: 3,
      set_role: "peak",
      personal_status: "approved",
    });

    const idNulls = seedTrack(t.ctx.db, {
      absolute_path: "/music/nulls.mp3",
      artist: null,
      title: null,
      album: null,
      label: null,
      year: null,
      genre: null,
      bpm: null,
      key_text: null,
      duration: null,
    });

    const tracks = [getTrack(t.ctx.db, idFull), getTrack(t.ctx.db, idNulls)];
    const dest = `${t.dir}/tracks.csv`;
    exportCsv(t.ctx.db, tracks, dest, false);
    const text = await Deno.readTextFile(dest);
    const lines = text.split("\r\n");

    assertEquals(
      lines[0],
      "id,artist,title,album,label,year,genre,bpm,key_text,duration,energy,intensity," +
        "darkness,melody,weirdness,mixability,confidence,set_role,transition_role," +
        "psy_substyle,personal_status,absolute_path",
    );
    // profile fields overrode row defaults; comma+quote field got quoted/escaped
    assert(lines[1].includes('"Comma, Test ""Quote"""'));
    assert(lines[1].includes(",8,7,3,,,,,peak,,,approved,"));

    // null track: empty fields for every nullable column
    const nullFields = lines[2].split(",");
    assertEquals(nullFields[1], ""); // artist
    assertEquals(nullFields[2], ""); // title
    assertEquals(nullFields[7], ""); // bpm

    assert(text.endsWith("\r\n"));
  } finally {
    await t.cleanup();
  }
});

Deno.test("exportCsv throws FileExistsError on conflict, succeeds with overwrite", async () => {
  const t = await makeTestCtx();
  try {
    const id = seedTrack(t.ctx.db);
    const tracks = [getTrack(t.ctx.db, id)];
    const dest = `${t.dir}/tracks.csv`;
    exportCsv(t.ctx.db, tracks, dest, false);
    assertThrows(() => exportCsv(t.ctx.db, tracks, dest, false), FileExistsError);
    exportCsv(t.ctx.db, tracks, dest, true);
  } finally {
    await t.cleanup();
  }
});

// ---- exportMarkdown ---------------------------------------------------

Deno.test("exportMarkdown golden content (title, date, duration, bpm/key, notes)", async () => {
  const t = await makeTestCtx();
  try {
    const id1 = seedTrack(t.ctx.db, {
      artist: "Astrix",
      title: "Deep Jungle Walk",
      duration: 125,
      bpm: 145,
      key_text: "8A",
    });
    const id2 = seedTrack(t.ctx.db, {
      artist: null,
      title: null,
      file_name: "track-b.mp3",
      duration: null,
      bpm: null,
      key_text: null,
    });
    const djSet: DJSetRow = {
      id: 1,
      title: "Sunrise Set",
      date: "2026-07-21",
      target_duration: null,
      target_bpm_arc: null,
      target_energy_arc: null,
      notes: "Great crowd energy.",
      created_at: nowIso(),
    };
    const tracks = [getTrack(t.ctx.db, id1), getTrack(t.ctx.db, id2)];
    const dest = `${t.dir}/set.md`;
    exportMarkdown(djSet, tracks, dest, false);
    const text = await Deno.readTextFile(dest);

    assert(text.startsWith("# Sunrise Set\n"));
    assert(text.includes("**Date:** 2026-07-21"));
    assert(text.includes("**Tracks:** 2"));
    assert(text.includes("1. Astrix — Deep Jungle Walk (2:05) — 145 BPM — 8A"));
    assert(text.includes("2. Unknown — track-b.mp3 (--:--)"));
    assert(text.includes("## Notes"));
    assert(text.includes("Great crowd energy."));
    assert(text.endsWith("\n"));
  } finally {
    await t.cleanup();
  }
});

Deno.test("exportMarkdown throws FileExistsError on conflict, succeeds with overwrite", async () => {
  const t = await makeTestCtx();
  try {
    const id = seedTrack(t.ctx.db);
    const djSet: DJSetRow = {
      id: 1,
      title: "Set",
      date: null,
      target_duration: null,
      target_bpm_arc: null,
      target_energy_arc: null,
      notes: null,
      created_at: nowIso(),
    };
    const tracks = [getTrack(t.ctx.db, id)];
    const dest = `${t.dir}/set.md`;
    exportMarkdown(djSet, tracks, dest, false);
    assertThrows(() => exportMarkdown(djSet, tracks, dest, false), FileExistsError);
    exportMarkdown(djSet, tracks, dest, true);
  } finally {
    await t.cleanup();
  }
});

// ---- exportJsonBackup ---------------------------------------------------

Deno.test("exportJsonBackup covers all 9 tables from backup.py", async () => {
  const t = await makeTestCtx();
  try {
    const trackId = seedTrack(t.ctx.db);
    seedProfile(t.ctx.db, trackId);

    t.ctx.db
      .prepare(
        "INSERT INTO artist_profiles (normalized_name, canonical_name, needs_review, created_at, updated_at) VALUES (?, ?, ?, ?, ?)",
      )
      .run("astrix", "Astrix", 0, nowIso(), nowIso());

    const tagResult = t.ctx.db
      .prepare("INSERT INTO tags (name, category) VALUES (?, ?)")
      .run("psytrance", null);
    const tagId = Number(tagResult.lastInsertRowid);
    t.ctx.db
      .prepare("INSERT INTO track_tags (track_id, tag_id, source, confidence) VALUES (?, ?, ?, ?)")
      .run(trackId, tagId, "human", null);

    const setResult = t.ctx.db
      .prepare("INSERT INTO sets (title, created_at) VALUES (?, ?)")
      .run("Test Set", nowIso());
    const setId = Number(setResult.lastInsertRowid);
    t.ctx.db
      .prepare("INSERT INTO set_tracks (set_id, position, track_id, note) VALUES (?, ?, ?, ?)")
      .run(setId, 1, trackId, null);

    t.ctx.db
      .prepare(
        "INSERT INTO track_pair_notes (from_track_id, to_track_id, created_at) VALUES (?, ?, ?)",
      )
      .run(trackId, trackId, nowIso());

    t.ctx.db.prepare("INSERT INTO play_events (track_id) VALUES (?)").run(trackId);

    const dest = `${t.dir}/backup.json`;
    exportJsonBackup(t.ctx.db, dest);
    const payload = JSON.parse(await Deno.readTextFile(dest));

    assertEquals(payload.version, 2);
    assert(typeof payload.exported_at === "string");
    assertEquals(payload.tracks.length, 1);
    assertEquals(payload.artist_profiles.length, 1);
    assertEquals(payload.profiles.length, 1);
    assertEquals(payload.tags.length, 1);
    assertEquals(payload.track_tags.length, 1);
    assertEquals(payload.sets.length, 1);
    assertEquals(payload.set_tracks.length, 1);
    assertEquals(payload.pair_notes.length, 1);
    assertEquals(payload.play_events.length, 1);
  } finally {
    await t.cleanup();
  }
});

Deno.test("exportJsonBackup golden: boolean columns are real true/false, not raw 0/1", async () => {
  const t = await makeTestCtx();
  try {
    const trackId = seedTrack(t.ctx.db, { missing: 1 });
    seedProfile(t.ctx.db, trackId, {
      can_cut_into: 1,
      can_cut_out_of: 0,
      dramatic_transition_candidate: null,
      human_confirmed: 1,
    });
    t.ctx.db
      .prepare(
        "INSERT INTO artist_profiles (normalized_name, canonical_name, needs_review, created_at, updated_at) VALUES (?, ?, ?, ?, ?)",
      )
      .run("astrix", "Astrix", 1, nowIso(), nowIso());

    const dest = `${t.dir}/backup-bool.json`;
    exportJsonBackup(t.ctx.db, dest);
    const raw = await Deno.readTextFile(dest);
    const payload = JSON.parse(raw);

    // No trailing newline (matches Python's write_text(json.dumps(...))).
    assert(!raw.endsWith("\n"));

    assertEquals(payload.tracks[0].missing, true);
    assertEquals(typeof payload.tracks[0].missing, "boolean");

    assertEquals(payload.profiles[0].can_cut_into, true);
    assertEquals(payload.profiles[0].can_cut_out_of, false);
    assertEquals(payload.profiles[0].dramatic_transition_candidate, null);
    assertEquals(payload.profiles[0].human_confirmed, true);

    assertEquals(payload.artist_profiles[0].needs_review, true);

    // Never leak raw 0/1 integers for boolean columns anywhere in the file.
    assert(!raw.includes('"missing": 0'));
    assert(!raw.includes('"missing": 1'));
    assert(!raw.includes('"needs_review": 1'));
    assert(!raw.includes('"human_confirmed": 1'));
  } finally {
    await t.cleanup();
  }
});

Deno.test("exportJsonBackup always overwrites without error", async () => {
  const t = await makeTestCtx();
  try {
    seedTrack(t.ctx.db);
    const dest = `${t.dir}/backup.json`;
    exportJsonBackup(t.ctx.db, dest);
    exportJsonBackup(t.ctx.db, dest); // no overwrite param, no conflict throw
    const payload = JSON.parse(await Deno.readTextFile(dest));
    assertEquals(payload.tracks.length, 1);
  } finally {
    await t.cleanup();
  }
});

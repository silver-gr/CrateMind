import { assert, assertEquals } from "@std/assert";
import { dispatch } from "../src/api/dispatch.ts";
import type { AppContext } from "../src/api/dispatch.ts";
import { routes as importRoutes } from "../src/api/importer.ts";
import { exportJsonBackup } from "../src/services/exporterJsonBackup.ts";
import { searchTracks } from "../src/services/searchExecutor.ts";
import { makeTestCtx, seedProfile, seedTrack } from "./helpers.ts";
import { nowIso } from "../src/utils/time.ts";
import { effectiveBpm, bpmSource } from "../src/services/tempo.ts";
import type { Track } from "../src/types/models.ts";

const ROUTES = importRoutes();

for (const [sourceKind, malformedSource] of [
  ["numeric", 123],
  ["object", { manual: true }],
] as const) {
  for (const existingSource of [null, "local,essentia", "manual:tap"]) {
    Deno.test(`backup import normalizes ${sourceKind} consensus source with ${existingSource ?? "absent"} local consensus`, async () => {
      const t = await makeTestCtx();
      try {
        const absolutePath = "/tempo/malformed-source.mp3";
        const id = seedTrack(t.ctx.db, {
          absolute_path: absolutePath,
          bpm: 160,
          bpm_analyzed: 155,
          bpm_consensus: existingSource === null ? null : 150,
          bpm_consensus_sources: existingSource,
        });
        const response = await post(t.ctx, "/api/import/json-backup", {
          version: 2,
          tracks: [{
            id: 100,
            absolute_path: absolutePath,
            bpm: 140,
            bpm_analyzed: 135,
            bpm_consensus: 145,
            bpm_consensus_sources: malformedSource,
          }],
        });
        assertEquals(response.status, 200);
        const row = t.ctx.db.prepare("SELECT * FROM tracks WHERE id = ?").get(id) as unknown as Track;
        assertEquals(row.bpm, 160);
        assertEquals(row.bpm_analyzed, 155);
        assertEquals(row.bpm_consensus, existingSource === null ? 145 : 150);
        assertEquals(row.bpm_consensus_sources, existingSource);
        assertEquals(effectiveBpm(row), existingSource === "manual:tap" ? 150 : 160);
      } finally {
        await t.cleanup();
      }
    });
  }
}

Deno.test("backup import preserves manual consensus and keeps existing local decisions", async () => {
  const t = await makeTestCtx();
  try {
    const restored = seedTrack(t.ctx.db, { absolute_path: "/tempo/restore.mp3", bpm: 160 });
    const local = seedTrack(t.ctx.db, { absolute_path: "/tempo/local.mp3", bpm_consensus: 150, bpm_consensus_sources: "manual:tap" });
    const automatic = seedTrack(t.ctx.db, { absolute_path: "/tempo/auto.mp3", bpm_consensus: 150, bpm_consensus_sources: "local,essentia" });
    const payload = {
      version: 2,
      tracks: [
        { id: 100, absolute_path: "/tempo/restore.mp3", bpm_consensus: 145, bpm_consensus_sources: "manual:metadata" },
        { id: 101, absolute_path: "/tempo/local.mp3", bpm_consensus: 145, bpm_consensus_sources: "manual:metadata" },
        { id: 102, absolute_path: "/tempo/auto.mp3", bpm_consensus: 145, bpm_consensus_sources: "manual:tap" },
      ],
    };
    for (let i = 0; i < 2; i++) {
      const response = await post(t.ctx, "/api/import/json-backup", payload);
      assertEquals(response.status, 200);
    }
    const restoredTrack = t.ctx.db.prepare("SELECT * FROM tracks WHERE id = ?").get(restored) as unknown as Track;
    const localTrack = t.ctx.db.prepare("SELECT * FROM tracks WHERE id = ?").get(local) as unknown as Track;
    assertEquals(effectiveBpm(restoredTrack), 145);
    assertEquals(bpmSource(restoredTrack), "manual:metadata");
    assertEquals(restoredTrack.bpm, 160);
    assertEquals(effectiveBpm(localTrack), 150);
    assertEquals(bpmSource(localTrack), "manual:tap");
    const autoTrack = t.ctx.db.prepare("SELECT * FROM tracks WHERE id = ?").get(automatic) as unknown as Track;
    assertEquals(effectiveBpm(autoTrack), 145);
    assertEquals(bpmSource(autoTrack), "manual:tap");
  } finally {
    await t.cleanup();
  }
});

function post(ctx: AppContext, path: string, body: unknown): Promise<Response> {
  return dispatch(
    ROUTES,
    new Request(`http://localhost${path}`, {
      method: "POST",
      headers: {
        host: `${ctx.config.host}:${ctx.config.port}`,
        "content-type": "application/json",
      },
      body: JSON.stringify(body),
    }),
    ctx,
  );
}

function insertSet(ctx: AppContext, overrides: Record<string, unknown> = {}): number {
  const row = {
    title: "Sunrise Set",
    date: null,
    target_duration: null,
    target_bpm_arc: null,
    target_energy_arc: null,
    notes: null,
    created_at: nowIso(),
    ...overrides,
  };
  const columns = Object.keys(row);
  const result = ctx.db
    .prepare(`INSERT INTO sets (${columns.join(", ")}) VALUES (${columns.map(() => "?").join(", ")})`)
    .run(...(Object.values(row) as (string | number | null)[]));
  return Number(result.lastInsertRowid);
}

function addSetTrack(ctx: AppContext, setId: number, trackId: number, position: number, note: string | null = null): void {
  ctx.db
    .prepare("INSERT INTO set_tracks (set_id, position, track_id, note) VALUES (?, ?, ?, ?)")
    .run(setId, position, trackId, note);
}

function addTag(ctx: AppContext, name: string): number {
  const result = ctx.db.prepare("INSERT INTO tags (name, category) VALUES (?, ?)").run(name, null);
  return Number(result.lastInsertRowid);
}

function addTrackTag(ctx: AppContext, trackId: number, tagId: number, source = "human"): void {
  ctx.db
    .prepare("INSERT INTO track_tags (track_id, tag_id, source, confidence) VALUES (?, ?, ?, ?)")
    .run(trackId, tagId, source, null);
}

function addPairNote(
  ctx: AppContext,
  fromId: number,
  toId: number,
  overrides: Record<string, unknown> = {},
): void {
  const row = {
    from_track_id: fromId,
    to_track_id: toId,
    rating: 4,
    transition_type: "blend",
    notes: "smooth",
    created_at: nowIso(),
    ...overrides,
  };
  const columns = Object.keys(row);
  ctx.db
    .prepare(`INSERT INTO track_pair_notes (${columns.join(", ")}) VALUES (${columns.map(() => "?").join(", ")})`)
    .run(...(Object.values(row) as (string | number | null)[]));
}

function addPlayEvent(
  ctx: AppContext,
  trackId: number,
  overrides: Record<string, unknown> = {},
): void {
  const row = {
    track_id: trackId,
    set_id: null,
    played_at: nowIso(),
    context: null,
    crowd_reaction: null,
    notes: null,
    ...overrides,
  };
  const columns = Object.keys(row);
  ctx.db
    .prepare(`INSERT INTO play_events (${columns.join(", ")}) VALUES (${columns.map(() => "?").join(", ")})`)
    .run(...(Object.values(row) as (string | number | null)[]));
}

function trackRow(ctx: AppContext, absolutePath: string): { id: number; play_count: number; last_played_at: string | null } {
  return ctx.db
    .prepare("SELECT id, play_count, last_played_at FROM tracks WHERE absolute_path = ?")
    .get(absolutePath) as unknown as { id: number; play_count: number; last_played_at: string | null };
}

Deno.test("round-trip: full backup restores taste metadata onto a differently-ordered library", async () => {
  const a = await makeTestCtx();
  const b = await makeTestCtx();
  try {
    // --- seed source ctx A ---
    const aId1 = seedTrack(a.ctx.db, { absolute_path: "/lib/one.mp3", artist: "Astrix", title: "One" });
    const aId2 = seedTrack(a.ctx.db, { absolute_path: "/lib/two.mp3", artist: "Vini Vici", title: "Two" });
    seedProfile(a.ctx.db, aId1, { energy: 8, dramatic_transition_candidate: 1, notes: "peak time" });
    seedProfile(a.ctx.db, aId2, { energy: 5 });

    const tagId = addTag(a.ctx, "Peak");
    addTrackTag(a.ctx, aId1, tagId, "human");

    const setId = insertSet(a.ctx, { title: "Sunrise Set" });
    addSetTrack(a.ctx, setId, aId2, 1);
    addSetTrack(a.ctx, setId, aId1, 2);

    addPairNote(a.ctx, aId2, aId1, { rating: 5, transition_type: "blend", notes: "into peak" });

    addPlayEvent(a.ctx, aId1, { set_id: setId, played_at: "2026-07-20T10:00:00.000Z" });
    addPlayEvent(a.ctx, aId1, { set_id: setId, played_at: "2026-07-20T11:00:00.000Z" });
    a.ctx.db.prepare("UPDATE tracks SET play_count = 2, last_played_at = ? WHERE id = ?").run(
      "2026-07-20T11:00:00.000Z",
      aId1,
    );

    const dest = `${a.dir}/backup.json`;
    exportJsonBackup(a.ctx.db, dest);
    const payload = JSON.parse(await Deno.readTextFile(dest));

    // --- seed destination ctx B with SAME absolute_paths, different insert order ---
    const bId2 = seedTrack(b.ctx.db, { absolute_path: "/lib/two.mp3", artist: "Vini Vici", title: "Two" });
    const bId1 = seedTrack(b.ctx.db, { absolute_path: "/lib/one.mp3", artist: "Astrix", title: "One" });
    assert(bId1 !== aId1 || bId2 !== aId2, "ids should differ across dbs by construction");

    const res = await post(b.ctx, "/api/import/json-backup", payload);
    assertEquals(res.status, 200);
    const counts = await res.json();

    assertEquals(counts.matched_tracks, 2);
    assertEquals(counts.skipped_tracks, 0);
    assertEquals(counts.profiles, 2);
    assertEquals(counts.tags, 1);
    assertEquals(counts.track_tags, 1);
    assertEquals(counts.sets, 1);
    assertEquals(counts.set_tracks, 2);
    assertEquals(counts.pair_notes, 1);
    assertEquals(counts.play_events, 2);

    // profiles landed on B's ids
    const profile1 = b.ctx.db.prepare("SELECT * FROM track_dj_profile WHERE track_id = ?").get(bId1) as Record<
      string,
      unknown
    >;
    assertEquals(profile1.energy, 8);
    assertEquals(profile1.dramatic_transition_candidate, 1);
    assertEquals(profile1.notes, "peak time");

    // tag + track_tag
    const tagRow = b.ctx.db.prepare("SELECT id FROM tags WHERE name = 'Peak'").get() as { id: number };
    const link = b.ctx.db
      .prepare("SELECT 1 FROM track_tags WHERE track_id = ? AND tag_id = ?")
      .get(bId1, tagRow.id);
    assert(link !== undefined);

    // set + set_tracks
    const bSet = b.ctx.db.prepare("SELECT id FROM sets WHERE title = 'Sunrise Set'").get() as { id: number };
    const orderedTrackIds = (b.ctx.db
      .prepare("SELECT track_id FROM set_tracks WHERE set_id = ? ORDER BY position")
      .all(bSet.id) as { track_id: number }[]).map((r) => r.track_id);
    assertEquals(orderedTrackIds, [bId2, bId1]);

    // pair note remapped
    const note = b.ctx.db
      .prepare("SELECT * FROM track_pair_notes WHERE from_track_id = ? AND to_track_id = ?")
      .get(bId2, bId1) as Record<string, unknown>;
    assertEquals(note.rating, 5);
    assertEquals(note.notes, "into peak");

    // play stats
    const bt1 = trackRow(b.ctx, "/lib/one.mp3");
    assertEquals(bt1.play_count, 2);
    assertEquals(bt1.last_played_at, "2026-07-20T11:00:00.000Z");
    const playEvents = b.ctx.db
      .prepare("SELECT set_id FROM play_events WHERE track_id = ?")
      .all(bt1.id) as { set_id: number | null }[];
    assertEquals(playEvents.length, 2);
    assert(playEvents.every((pe) => pe.set_id === bSet.id));
  } finally {
    await a.cleanup();
    await b.cleanup();
  }
});

Deno.test("idempotency: importing the same payload twice writes no duplicate sets/pair_notes/play_events", async () => {
  const a = await makeTestCtx();
  const b = await makeTestCtx();
  try {
    const aId1 = seedTrack(a.ctx.db, { absolute_path: "/lib/one.mp3" });
    const aId2 = seedTrack(a.ctx.db, { absolute_path: "/lib/two.mp3" });
    seedProfile(a.ctx.db, aId1, { energy: 3 });
    const setId = insertSet(a.ctx, { title: "Repeat Set" });
    addSetTrack(a.ctx, setId, aId1, 1);
    addPairNote(a.ctx, aId1, aId2);
    addPlayEvent(a.ctx, aId1, { played_at: "2026-07-20T09:00:00.000Z" });

    const dest = `${a.dir}/backup.json`;
    exportJsonBackup(a.ctx.db, dest);
    const payload = JSON.parse(await Deno.readTextFile(dest));

    seedTrack(b.ctx.db, { absolute_path: "/lib/two.mp3" });
    seedTrack(b.ctx.db, { absolute_path: "/lib/one.mp3" });

    const first = await post(b.ctx, "/api/import/json-backup", payload);
    assertEquals(first.status, 200);
    const firstCounts = await first.json();
    assertEquals(firstCounts.sets, 1);
    assertEquals(firstCounts.pair_notes, 1);
    assertEquals(firstCounts.play_events, 1);

    const second = await post(b.ctx, "/api/import/json-backup", payload);
    assertEquals(second.status, 200);
    const secondCounts = await second.json();
    assertEquals(secondCounts.sets, 0);
    assertEquals(secondCounts.pair_notes, 0);
    assertEquals(secondCounts.play_events, 0);
    // profile upsert still fine (matched + written both times)
    assertEquals(secondCounts.profiles, 1);
    assertEquals(secondCounts.matched_tracks, 2);

    const setCount = (b.ctx.db.prepare("SELECT COUNT(*) AS n FROM sets WHERE title = 'Repeat Set'").get() as {
      n: number;
    }).n;
    assertEquals(setCount, 1);
    const setTrackCount = (b.ctx.db.prepare("SELECT COUNT(*) AS n FROM set_tracks").get() as { n: number }).n;
    assertEquals(setTrackCount, 1);
    const noteCount = (b.ctx.db.prepare("SELECT COUNT(*) AS n FROM track_pair_notes").get() as { n: number }).n;
    assertEquals(noteCount, 1);
    const playCount = (b.ctx.db.prepare("SELECT COUNT(*) AS n FROM play_events").get() as { n: number }).n;
    assertEquals(playCount, 1);
  } finally {
    await a.cleanup();
    await b.cleanup();
  }
});

Deno.test("skips: backup track matching nothing in the current library is skipped, nothing written for it", async () => {
  const b = await makeTestCtx();
  try {
    const bId = seedTrack(b.ctx.db, { absolute_path: "/lib/known.mp3" });

    const payload = {
      version: 2,
      tracks: [
        { id: 1, absolute_path: "/lib/known.mp3", full_hash: null, quick_hash: null },
        { id: 2, absolute_path: "/lib/gone-forever.mp3", full_hash: "deadbeef", quick_hash: "qh" },
      ],
      profiles: [
        { track_id: 1, energy: 6, updated_at: nowIso() },
        { track_id: 2, energy: 9, updated_at: nowIso() },
      ],
      artist_profiles: [],
      tags: [],
      track_tags: [],
      sets: [],
      set_tracks: [],
      pair_notes: [],
      play_events: [],
    };

    const res = await post(b.ctx, "/api/import/json-backup", payload);
    assertEquals(res.status, 200);
    const counts = await res.json();
    assertEquals(counts.matched_tracks, 1);
    assertEquals(counts.skipped_tracks, 1);
    assertEquals(counts.profiles, 1);

    const known = b.ctx.db.prepare("SELECT energy FROM track_dj_profile WHERE track_id = ?").get(bId) as {
      energy: number;
    };
    assertEquals(known.energy, 6);

    const total = (b.ctx.db.prepare("SELECT COUNT(*) AS n FROM tracks").get() as { n: number }).n;
    assertEquals(total, 1, "no new tracks rows created for the skipped backup track");
  } finally {
    await b.cleanup();
  }
});

Deno.test("hash fallback: matches by full_hash when absolute_path differs", async () => {
  const b = await makeTestCtx();
  try {
    const bId = seedTrack(b.ctx.db, {
      absolute_path: "/lib/moved-elsewhere.mp3",
      full_hash: "hash-abc",
      quick_hash: "qh-abc",
    });

    const payload = {
      version: 2,
      tracks: [
        { id: 1, absolute_path: "/lib/old-location.mp3", full_hash: "hash-abc", quick_hash: "qh-different" },
      ],
      profiles: [{ track_id: 1, energy: 7, updated_at: nowIso() }],
      artist_profiles: [],
      tags: [],
      track_tags: [],
      sets: [],
      set_tracks: [],
      pair_notes: [],
      play_events: [],
    };

    const res = await post(b.ctx, "/api/import/json-backup", payload);
    assertEquals(res.status, 200);
    const counts = await res.json();
    assertEquals(counts.matched_tracks, 1);
    assertEquals(counts.skipped_tracks, 0);

    const profile = b.ctx.db.prepare("SELECT energy FROM track_dj_profile WHERE track_id = ?").get(bId) as {
      energy: number;
    };
    assertEquals(profile.energy, 7);
  } finally {
    await b.cleanup();
  }
});

Deno.test("400 on garbage body: empty object", async () => {
  const b = await makeTestCtx();
  try {
    const res = await post(b.ctx, "/api/import/json-backup", {});
    assertEquals(res.status, 400);
    assert(typeof (await res.json()).detail === "string");
  } finally {
    await b.cleanup();
  }
});

Deno.test("400 on garbage body: version present but tracks missing", async () => {
  const b = await makeTestCtx();
  try {
    const res = await post(b.ctx, "/api/import/json-backup", { version: 2 });
    assertEquals(res.status, 400);
    assert(typeof (await res.json()).detail === "string");
  } finally {
    await b.cleanup();
  }
});

Deno.test("booleans: dramatic_transition_candidate=true lands as 1 and is searchable via 'dramatic'", async () => {
  const b = await makeTestCtx();
  try {
    const bId = seedTrack(b.ctx.db, { absolute_path: "/lib/dramatic.mp3", artist: "X", title: "Y" });

    const payload = {
      version: 2,
      tracks: [{ id: 1, absolute_path: "/lib/dramatic.mp3", full_hash: null, quick_hash: null }],
      profiles: [
        {
          track_id: 1,
          dramatic_transition_candidate: true,
          updated_at: nowIso(),
        },
      ],
      artist_profiles: [],
      tags: [],
      track_tags: [],
      sets: [],
      set_tracks: [],
      pair_notes: [],
      play_events: [],
    };

    const res = await post(b.ctx, "/api/import/json-backup", payload);
    assertEquals(res.status, 200);

    const profile = b.ctx.db
      .prepare("SELECT dramatic_transition_candidate FROM track_dj_profile WHERE track_id = ?")
      .get(bId) as { dramatic_transition_candidate: number };
    assertEquals(profile.dramatic_transition_candidate, 1);

    const results = searchTracks(b.ctx.db, "dramatic");
    assert(results.some((t) => t.id === bId));
  } finally {
    await b.cleanup();
  }
});

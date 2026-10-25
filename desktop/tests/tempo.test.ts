import { assert, assertEquals } from "@std/assert";
import { dispatch } from "../src/api/dispatch.ts";
import { routes as trackRoutes } from "../src/api/tracks.ts";
import { routes as setRoutes } from "../src/api/sets.ts";
import { effectiveBpm, recommend } from "../src/services/recommender.ts";
import { countTracks, searchTracks } from "../src/services/searchExecutor.ts";
import { extractTags } from "../src/services/metadata.ts";
import type { Track } from "../src/types/models.ts";
import { makeTestCtx, seedTrack } from "./helpers.ts";
import { bpmSource } from "../src/services/tempo.ts";
import { exportCsv } from "../src/services/exporterCsv.ts";
import { exportMarkdown } from "../src/services/exporterMarkdown.ts";
import { initDb } from "../src/db/database.ts";
import { DatabaseSync } from "node:sqlite";

Deno.test("effective BPM respects manual, metadata, consensus, analyzed and invalid values", () => {
  const cases: [Record<string, unknown>, number | null][] = [
    [{ bpm: 0, bpm_analyzed: 145 }, 145],
    [{ bpm: -1, bpm_analyzed: 145 }, 145],
    [{ bpm: Infinity, bpm_analyzed: 145 }, 145],
    [{ bpm: NaN, bpm_analyzed: 145 }, 145],
    [{
      bpm: 160,
      bpm_consensus: 150,
      bpm_consensus_sources: "manual:tap",
      bpm_analyzed: 145,
    }, 150],
    [{
      bpm: 160,
      bpm_consensus: 150,
      bpm_consensus_sources: "essentia,librosa",
      bpm_analyzed: 145,
    }, 160],
    [{ bpm: null, bpm_consensus: 150, bpm_analyzed: 145 }, 150],
    [{
      bpm: 160,
      bpm_consensus: 0,
      bpm_consensus_sources: "manual:tap",
      bpm_analyzed: 145,
    }, 160],
    [{ bpm: 400, bpm_analyzed: 200 }, 400],
    [{ bpm: 0, bpm_consensus: -1, bpm_analyzed: Infinity }, null],
    [{}, null],
  ];
  for (const [fields, expected] of cases) {
    assertEquals(
      effectiveBpm(fields as unknown as Track),
      expected,
      JSON.stringify(fields),
    );
  }
});

Deno.test("BPM search and count use analyzed fallback and complement includes missing tempo", async () => {
  const t = await makeTestCtx();
  try {
    const matching = [
      seedTrack(t.ctx.db, { bpm_analyzed: 145 }),
      seedTrack(t.ctx.db, { bpm: 0, bpm_analyzed: 145 }),
    ];
    const excluded = [
      seedTrack(t.ctx.db, { bpm: 160, bpm_analyzed: 145 }),
      seedTrack(t.ctx.db),
    ];
    for (const query of ["bpm:145", "bpm:144-146", "bpm:140+", "bpm:150-"]) {
      const expected = query === "bpm:140+"
        ? [...matching, excluded[0]]
        : matching;
      assertEquals(
        new Set(searchTracks(t.ctx.db, query).map((x) => x.id)),
        new Set(expected),
      );
      assertEquals(countTracks(t.ctx.db, query), expected.length);
    }
    assertEquals(
      new Set(searchTracks(t.ctx.db, "-bpm:145").map((x) => x.id)),
      new Set(excluded),
    );
    assertEquals(countTracks(t.ctx.db, "-bpm:145"), excluded.length);
    const response = await dispatch(
      trackRoutes(),
      new Request("http://localhost/api/tracks?q=bpm%3A145"),
      t.ctx,
    );
    assertEquals(response.status, 200);
    assertEquals(
      new Set((await response.json() as Track[]).map((x) => x.id)),
      new Set(matching),
    );
    const countResponse = await dispatch(
      trackRoutes(),
      new Request("http://localhost/api/tracks/count?q=-bpm%3A145"),
      t.ctx,
    );
    assertEquals(await countResponse.json(), { count: excluded.length });
  } finally {
    await t.cleanup();
  }
});

Deno.test("recommendations and set curves use valid analyzed fallback behind zero tags", async () => {
  const t = await makeTestCtx();
  try {
    const a = seedTrack(t.ctx.db, { bpm: 0, bpm_analyzed: 145 });
    const b = seedTrack(t.ctx.db, { bpm: 160 });
    const ranked = recommend(t.ctx.db, { target_bpm: 145 });
    assertEquals(ranked[0].track_id, a);
    assertEquals(ranked[0].bpm, 145);
    assertEquals(ranked[0].bpm_is_analyzed, true);
    t.ctx.db.prepare(
      "INSERT INTO sets (id, title, created_at) VALUES (1, 'Tempo', '2026-10-25')",
    ).run();
    t.ctx.db.prepare(
      "INSERT INTO set_tracks (set_id, position, track_id) VALUES (1, 0, ?), (1, 1, ?)",
    ).run(a, b);
    const res = await dispatch(
      setRoutes(),
      new Request("http://localhost/api/sets/1/analysis"),
      t.ctx,
    );
    const data = await res.json();
    assertEquals(data.bpm_curve, [145, 160]);
    assert(
      data.transition_warnings.some((x: { message: string }) =>
        x.message === "BPM jump 145->160"
      ),
    );
  } finally {
    await t.cleanup();
  }
});

Deno.test("invalid embedded BPM does not hide valid filename tempo hints", () => {
  for (
    const bpm of [
      "0",
      "-145",
      "-145bpm",
      "NaN",
      "Infinity",
      "-Infinity",
      "1e309",
    ]
  ) {
    const probe = {
      format: { tags: { bpm } },
      streams: [{ codec_type: "audio" }],
    };
    assertEquals(
      extractTags(probe, "/tmp/Artist - Title [150].mp3").bpm,
      150,
      bpm,
    );
  }
  for (const bpm of ["0.5", "145.5 bpm", "400", "1.5e2"]) {
    const probe = {
      format: { tags: { bpm } },
      streams: [{ codec_type: "audio" }],
    };
    assertEquals(
      extractTags(probe, "/tmp/Artist - Title.mp3").bpm,
      parseFloat(bpm),
    );
  }
});

Deno.test("SQL BPM resolver matches finite positive precedence without modifying raw values", async () => {
  const t = await makeTestCtx();
  try {
    const values: Partial<Track>[] = [
      { bpm: Infinity, bpm_analyzed: 145 },
      { bpm: -1, bpm_analyzed: 145 },
      { bpm: 150, bpm_consensus: 145, bpm_consensus_sources: "manual:tap" },
      { bpm: 150, bpm_consensus: 145, bpm_consensus_sources: "essentia" },
      { bpm_consensus: 145, bpm_analyzed: 160 },
      { bpm: 0, bpm_consensus: -1, bpm_analyzed: Infinity },
    ];
    for (const value of values) {
      const id = seedTrack(t.ctx.db, value);
      const row = t.ctx.db.prepare("SELECT * FROM tracks WHERE id = ?").get(
        id,
      ) as unknown as Track;
      const selected = t.ctx.db.prepare(
        "SELECT cratemind_bpm(bpm, bpm_analyzed, bpm_consensus, bpm_consensus_sources) AS effective FROM tracks WHERE id = ?",
      ).get(id) as { effective: number | null };
      assertEquals(selected.effective, effectiveBpm(row));
      assertEquals(row.bpm, value.bpm ?? null);
      assertEquals(row.bpm_analyzed, value.bpm_analyzed ?? null);
    }
  } finally {
    await t.cleanup();
  }
});

Deno.test("BPM provenance preserves manual and consensus sources", () => {
  const cases: [Partial<Track>, string | null][] = [
    [{ bpm: 150 }, "metadata"],
    [{ bpm: 0, bpm_analyzed: 145, bpm_analyzed_method: "librosa" }, "local"],
    [
      {
        bpm: 160,
        bpm_consensus: 145,
        bpm_consensus_sources: "manual:metadata",
      },
      "manual:metadata",
    ],
    [
      { bpm_consensus: 145, bpm_consensus_sources: "librosa,essentia" },
      "librosa,essentia",
    ],
    [{ bpm_consensus: 145 }, "consensus"],
    [{ bpm: 0, bpm_consensus: -1, bpm_analyzed: Infinity }, null],
  ];
  for (const [track, expected] of cases) {
    assertEquals(bpmSource(track), expected);
  }
});

Deno.test("manual consensus stays consistent across BPM search, artist prefill, recommendation and exports", async () => {
  const t = await makeTestCtx();
  try {
    const db = t.ctx.db;
    const id = seedTrack(db, {
      bpm: 160,
      bpm_consensus: 145.5,
      bpm_consensus_sources: "manual:metadata",
      bpm_analyzed: 150,
    });
    db.prepare(
      `INSERT INTO artist_profiles (normalized_name, canonical_name, typical_bpm_min, typical_bpm_max, created_at, updated_at)
      VALUES ('seed artist', 'Seed Artist', 145, 146, '2026-10-25', '2026-10-25')`,
    ).run();
    assertEquals(searchTracks(db, "bpm:145.5").map((x) => x.id), [id]);
    assertEquals(countTracks(db, "bpm:160"), 0);
    const response = await dispatch(
      trackRoutes(),
      new Request(`http://localhost/api/tracks/${id}`),
      t.ctx,
    );
    const payload = await response.json();
    assertEquals(payload.track.artist_prefill.bpm_conflict, false);
    assertEquals(payload.track.bpm, 160);
    assertEquals(payload.track.bpm_consensus, 145.5);
    const result = recommend(db, { target_bpm: 145.5 })[0];
    assertEquals(result.bpm, 145.5);
    assertEquals(result.bpm_is_analyzed, false);
    assert(result.reasons.includes("+ BPM close: 145.5->145.5"));
    const track = db.prepare("SELECT * FROM tracks WHERE id = ?").get(
      id,
    ) as unknown as Track;
    exportCsv(db, [track], `${t.dir}/tempo.csv`, false);
    const [header, row] = (await Deno.readTextFile(`${t.dir}/tempo.csv`)).trim()
      .split("\r\n").map((line) => line.split(","));
    assertEquals(row[header.indexOf("bpm")], "160");
    assertEquals(row[header.indexOf("effective_bpm")], "145.5");
    assertEquals(row[header.indexOf("bpm_source")], "manual:metadata");
    exportMarkdown(
      {
        id: 1,
        title: "Tempo",
        date: null,
        target_duration: null,
        target_bpm_arc: null,
        target_energy_arc: null,
        notes: null,
        created_at: "2026-10-25",
      },
      [track],
      `${t.dir}/tempo.md`,
      false,
    );
    assert(
      (await Deno.readTextFile(`${t.dir}/tempo.md`)).includes("145.5 BPM"),
    );
  } finally {
    await t.cleanup();
  }
});

Deno.test("desktop consensus migration upgrades old catalogs and preserves existing Python fields", () => {
  for (const existing of [false, true]) {
    const db = new DatabaseSync(":memory:");
    try {
      db.exec(
        `CREATE TABLE tracks (id INTEGER PRIMARY KEY, bpm REAL${
          existing ? ", bpm_consensus REAL, bpm_consensus_sources TEXT" : ""
        });
        CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL);
        INSERT INTO schema_migrations VALUES (1, 'old'), (2, 'old');`,
      );
      if (existing) {
        db.exec(
          "INSERT INTO tracks (bpm_consensus, bpm_consensus_sources) VALUES (145, 'manual:tap')",
        );
      }
      initDb(db);
      initDb(db);
      const columns =
        (db.prepare("PRAGMA table_info(tracks)").all() as { name: string }[])
          .map((row) => row.name);
      assert(columns.includes("bpm_consensus"));
      assert(columns.includes("bpm_consensus_sources"));
      if (existing) {
        assertEquals(
          db.prepare("SELECT bpm_consensus, bpm_consensus_sources FROM tracks")
            .get(),
          { bpm_consensus: 145, bpm_consensus_sources: "manual:tap" },
        );
      }
    } finally {
      db.close();
    }
  }
});

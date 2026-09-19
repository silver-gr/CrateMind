// Port of backend/tests/test_recommender.py, plus bridge mode, both
// pair-note transition-memory legs, and a flat-shape golden (T3).

import { assert, assertEquals } from "@std/assert";
import type { DatabaseSync } from "node:sqlite";
import { bindable } from "../src/utils/http.ts";
import { nowIso } from "../src/utils/time.ts";
import type { Track, TrackDJProfile } from "../src/types/models.ts";
import { camelotOf, keyCompatibility } from "../src/services/camelot.ts";
import { effectiveBpm, effectiveKey, recommend } from "../src/services/recommender.ts";
import type { Context } from "../src/services/recommender.ts";
import { makeTestCtx, seedProfile, seedTrack } from "./helpers.ts";

function track(
  db: DatabaseSync,
  path: string,
  opts: { bpm?: number | null; key?: string | null } = {},
  profile: Partial<TrackDJProfile> = {},
): number {
  const id = seedTrack(db, {
    absolute_path: path,
    bpm: opts.bpm ?? 150,
    key_text: opts.key ?? null,
  });
  if (Object.keys(profile).length > 0) {
    seedProfile(db, id, profile);
  }
  return id;
}

function addPairNote(
  db: DatabaseSync,
  fromId: number,
  toId: number,
  opts: { rating?: number | null; transitionType?: string | null } = {},
): void {
  db.prepare(
    `INSERT INTO track_pair_notes (from_track_id, to_track_id, rating, transition_type, notes, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(
    fromId,
    toId,
    bindable(opts.rating ?? null),
    bindable(opts.transitionType ?? null),
    null,
    nowIso(),
  );
}

Deno.test("weapon outranks unknown", async () => {
  const t = await makeTestCtx();
  try {
    track(t.ctx.db, "/weapon.wav", { bpm: 150 }, { energy: 8, personal_status: "weapon" });
    track(t.ctx.db, "/plain.wav", { bpm: 150 }, { energy: 8, personal_status: "unknown" });
    const ctx: Context = { target_bpm: 150, target_energy: 8 };
    const ranked = recommend(t.ctx.db, ctx, 20);
    assertEquals(ranked[0].personal_status, "weapon");
    assert(ranked[0].score > ranked[1].score);
  } finally {
    await t.cleanup();
  }
});

Deno.test("retired and avoid are excluded", async () => {
  const t = await makeTestCtx();
  try {
    track(t.ctx.db, "/retired.wav", {}, { personal_status: "retired" });
    track(t.ctx.db, "/avoid.wav", {}, { personal_status: "avoid" });
    track(t.ctx.db, "/ok.wav", {}, { personal_status: "approved" });
    const ranked = recommend(t.ctx.db, {}, 20);
    const statuses = new Set(ranked.map((r) => r.personal_status));
    assert(!statuses.has("retired"));
    assert(!statuses.has("avoid"));
  } finally {
    await t.cleanup();
  }
});

Deno.test("reasons are present and mention BPM", async () => {
  const t = await makeTestCtx();
  try {
    track(t.ctx.db, "/a.wav", { bpm: 150 }, { energy: 8, personal_status: "approved" });
    const ctx: Context = { target_bpm: 150, target_energy: 8 };
    const ranked = recommend(t.ctx.db, ctx, 20);
    assert(ranked[0].reasons.length > 0);
    assert(ranked[0].reasons.some((r) => r.includes("BPM")));
  } finally {
    await t.cleanup();
  }
});

Deno.test("approved_only filters to approved+weapon", async () => {
  const t = await makeTestCtx();
  try {
    track(t.ctx.db, "/a.wav", {}, { personal_status: "testing" });
    track(t.ctx.db, "/b.wav", {}, { personal_status: "approved" });
    const ranked = recommend(t.ctx.db, { approved_only: true }, 20);
    assert(ranked.every((r) => r.personal_status === "approved" || r.personal_status === "weapon"));
  } finally {
    await t.cleanup();
  }
});

Deno.test("effective prefers tag over analyzed", () => {
  const t = {
    bpm: 150,
    key_text: "Am",
    bpm_analyzed: 120,
    key_analyzed: "C major",
  } as Track;
  assertEquals(effectiveBpm(t), 150);
  assertEquals(effectiveKey(t), "Am");
});

Deno.test("effective falls back to analyzed", () => {
  const t = {
    bpm: null,
    key_text: null,
    bpm_analyzed: 128,
    key_analyzed: "A minor",
  } as Track;
  assertEquals(effectiveBpm(t), 128);
  assertEquals(effectiveKey(t), "A minor");
});

Deno.test("analyzed bpm is used in ranking and flagged", async () => {
  const t = await makeTestCtx();
  try {
    const id = seedTrack(t.ctx.db, { absolute_path: "/g.wav", bpm: null, bpm_analyzed: 150 });
    const ranked = recommend(t.ctx.db, { target_bpm: 150 }, 20);
    const row = ranked.find((r) => r.track_id === id)!;
    assertEquals(row.bpm, 150);
    assertEquals(row.bpm_is_analyzed, true);
    assert(row.reasons.some((r) => r.includes("BPM")));
  } finally {
    await t.cleanup();
  }
});

Deno.test("excludes ids and recently played score penalty", async () => {
  const t = await makeTestCtx();
  try {
    const excluded = track(t.ctx.db, "/excluded.wav");
    const recent = track(t.ctx.db, "/recent.wav", { bpm: 150 });
    const fresh = track(t.ctx.db, "/fresh.wav", { bpm: 150 });
    const ctx: Context = {
      target_bpm: 150,
      exclude_ids: new Set([excluded]),
      recently_played_ids: new Set([recent]),
    };
    const ranked = recommend(t.ctx.db, ctx, 20);
    assert(!ranked.some((r) => r.track_id === excluded));
    const recentRow = ranked.find((r) => r.track_id === recent)!;
    const freshRow = ranked.find((r) => r.track_id === fresh)!;
    assert(recentRow.reasons.includes("- played recently"));
    assert(freshRow.reasons.includes("+ fresh (never played)"));
    assert(freshRow.score > recentRow.score);
  } finally {
    await t.cleanup();
  }
});

Deno.test("bridge mode scores fit into both previous and next track", async () => {
  const t = await makeTestCtx();
  try {
    // 8a is Camelot for Am; both previous and next legs use Am so a
    // candidate that also sits at Am should get key-match reasons twice,
    // once plain and once prefixed "-> into B".
    const good = track(t.ctx.db, "/bridge-good.wav", { bpm: 150, key: "Am" });
    const bad = track(t.ctx.db, "/bridge-bad.wav", { bpm: 150, key: "E" });
    const ctx: Context = {
      previous_key: "Am",
      previous_bpm: 150,
      next_key: "Am",
      next_bpm: 150,
      target_bpm: 150,
    };
    const ranked = recommend(t.ctx.db, ctx, 20);
    const goodRow = ranked.find((r) => r.track_id === good)!;
    const badRow = ranked.find((r) => r.track_id === bad)!;
    assert(goodRow.score > badRow.score);
    assert(goodRow.reasons.some((r) => r === "+ key match 8a"));
    assert(goodRow.reasons.some((r) => r.startsWith("+ → into B key match")));
  } finally {
    await t.cleanup();
  }
});

Deno.test("pair-note memory applies bonus on both legs with exact phrasing", async () => {
  const t = await makeTestCtx();
  try {
    const a = track(t.ctx.db, "/a.wav");
    const b = track(t.ctx.db, "/b.wav");
    const candidate = track(t.ctx.db, "/candidate.wav");
    addPairNote(t.ctx.db, a, candidate, { rating: 4, transitionType: "blend" });
    addPairNote(t.ctx.db, candidate, b, { rating: 3, transitionType: "cut" });

    const ctx: Context = { after_track_id: a, before_track_id: b };
    const ranked = recommend(t.ctx.db, ctx, 20);
    const row = ranked.find((r) => r.track_id === candidate)!;
    assert(
      row.reasons.includes("+ noted A→this worked: blend 4/5"),
      `missing A-leg reason, got: ${JSON.stringify(row.reasons)}`,
    );
    assert(
      row.reasons.includes("+ noted this→B worked: cut 3/5"),
      `missing B-leg reason, got: ${JSON.stringify(row.reasons)}`,
    );
  } finally {
    await t.cleanup();
  }
});

Deno.test("recommend respects limit and sorts descending", async () => {
  const t = await makeTestCtx();
  try {
    for (let i = 0; i < 5; i++) {
      track(t.ctx.db, `/track-${i}.wav`, { bpm: 150 - i }, { personal_status: "approved" });
    }
    const ranked = recommend(t.ctx.db, { target_bpm: 150 }, 3);
    assertEquals(ranked.length, 3);
    for (let i = 1; i < ranked.length; i++) {
      assert(ranked[i - 1].score >= ranked[i].score);
    }
  } finally {
    await t.cleanup();
  }
});

Deno.test("flat recommendation shape golden", async () => {
  const t = await makeTestCtx();
  try {
    const id = track(
      t.ctx.db,
      "/golden.wav",
      { bpm: 150, key: "Am" },
      { energy: 8, set_role: "peak", personal_status: "approved" },
    );
    const ranked = recommend(t.ctx.db, { target_bpm: 150, target_energy: 8 }, 20);
    const row = ranked.find((r) => r.track_id === id)!;
    assertEquals(Object.keys(row).sort(), [
      "artist",
      "bpm",
      "bpm_is_analyzed",
      "energy",
      "key",
      "key_is_analyzed",
      "personal_status",
      "reasons",
      "score",
      "set_role",
      "title",
      "track_id",
    ]);
    assertEquals(row.bpm, 150);
    assertEquals(row.key, "Am");
    assertEquals(row.energy, 8);
    assertEquals(row.set_role, "peak");
    assertEquals(row.personal_status, "approved");
    assertEquals(typeof row.score, "number");
    assert(Array.isArray(row.reasons));
  } finally {
    await t.cleanup();
  }
});

// ---- camelot.ts direct coverage ------------------------------------------

Deno.test("camelotOf normalises key text", () => {
  assertEquals(camelotOf("Am"), "8a");
  assertEquals(camelotOf("A minor"), "8a");
  assertEquals(camelotOf("8A"), "8a");
  assertEquals(camelotOf(null), null);
  assertEquals(camelotOf(""), null);
});

Deno.test("keyCompatibility scores match/adjacent/relative/clash", () => {
  assertEquals(keyCompatibility("Am", "Am"), 10.0);
  assertEquals(keyCompatibility("Am", "Em"), 7.0); // 8a -> 9a adjacent
  assertEquals(keyCompatibility("Am", "C"), 6.0); // 8a -> 8b relative
  assertEquals(keyCompatibility("Am", "F#"), -3.0); // clash
  assertEquals(keyCompatibility(null, "Am"), 0.0);
});

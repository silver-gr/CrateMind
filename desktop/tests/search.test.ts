import { assertEquals } from "@std/assert";
import { countTracks, searchTracks } from "../src/services/searchExecutor.ts";
import { makeTestCtx, seedProfile, seedTrack } from "./helpers.ts";
import type { Track, TrackDJProfile } from "../src/types/models.ts";

function paths(rows: Track[]): Set<string> {
  return new Set(rows.map((r) => r.absolute_path));
}

function mk(
  db: import("node:sqlite").DatabaseSync,
  path: string,
  trackOverrides: Partial<Track> = {},
  profileOverrides: Partial<TrackDJProfile> = {},
): number {
  const id = seedTrack(db, { absolute_path: path, ...trackOverrides });
  seedProfile(db, id, profileOverrides);
  return id;
}

Deno.test("flagship query: field filters + numeric range + not_recent + dramatic flag", async () => {
  const t = await makeTestCtx();
  try {
    const { db } = t.ctx;
    mk(db, "/holy.wav", { bpm: 154 }, {
      energy: 9,
      darkness: 8,
      set_role: "bridge",
      breakdown_profile: "long melodic break",
      personal_status: "approved",
      bpm_jump_tolerance: "huge",
      dramatic_transition_candidate: 1,
    });
    // played recently -> excluded by not_recent:30
    mk(db, "/recent.wav", { bpm: 154, play_count: 1, last_played_at: new Date().toISOString() }, {
      energy: 9,
      darkness: 8,
      set_role: "bridge",
      breakdown_profile: "long melodic break",
      personal_status: "approved",
      bpm_jump_tolerance: "huge",
      dramatic_transition_candidate: 1,
    });
    // not dramatic -> excluded by `dramatic`
    mk(db, "/calm.wav", { bpm: 154 }, {
      energy: 9,
      darkness: 8,
      set_role: "bridge",
      breakdown_profile: "long melodic break",
      personal_status: "approved",
      bpm_jump_tolerance: "huge",
      dramatic_transition_candidate: 0,
    });

    const q =
      "status:approved darkness:7+ energy:8+ bpm:150-160 role:bridge " +
      "break:long tolerance:huge not_recent:30 dramatic";
    assertEquals(paths(searchTracks(db, q)), new Set(["/holy.wav"]));
    assertEquals(countTracks(db, q), 1);
  } finally {
    await t.cleanup();
  }
});

Deno.test("never_played / -never_played", async () => {
  const t = await makeTestCtx();
  try {
    const { db } = t.ctx;
    seedTrack(db, { absolute_path: "/never.wav", play_count: 0 });
    seedTrack(db, { absolute_path: "/old.wav", play_count: 2 });

    assertEquals(paths(searchTracks(db, "never_played")), new Set(["/never.wav"]));
    assertEquals(paths(searchTracks(db, "-never_played")), new Set(["/old.wav"]));
  } finally {
    await t.cleanup();
  }
});

Deno.test("untagged / -untagged: FTS-exclusion semantics, not profile-presence negation", async () => {
  const t = await makeTestCtx();
  try {
    const { db } = t.ctx;
    // t1: has a profile row, nothing in its FTS content says "untagged".
    mk(db, "/t1.wav", { title: "Alpha Song" });
    // t2: no profile row at all -> matches bare "untagged".
    seedTrack(db, { absolute_path: "/t2.wav", title: "Beta Song" });
    // t3: has a profile row, but its comment literally contains "untagged".
    mk(db, "/t3.wav", { title: "Gamma Song", comment: "this one is untagged material" });

    assertEquals(paths(searchTracks(db, "untagged")), new Set(["/t2.wav"]));
    // -untagged is NOT "has a profile" — it's an FTS free-text exclusion of
    // the literal word "untagged", so /t2.wav (no profile, but no FTS hit
    // either) stays in the results; only /t3.wav (FTS match) is excluded.
    assertEquals(paths(searchTracks(db, "-untagged")), new Set(["/t1.wav", "/t2.wav"]));
  } finally {
    await t.cleanup();
  }
});

Deno.test("invalid numeric filter is silently ignored (token dropped, no free-text fallback)", async () => {
  const t = await makeTestCtx();
  try {
    const { db } = t.ctx;
    mk(db, "/a.wav", {}, { energy: 5 });
    mk(db, "/b.wav", {}, { energy: 9 });

    assertEquals(paths(searchTracks(db, "energy:abc")), new Set(["/a.wav", "/b.wav"]));
    assertEquals(countTracks(db, "energy:abc"), 2);
  } finally {
    await t.cleanup();
  }
});

Deno.test("empty field value: exact match against empty string", async () => {
  const t = await makeTestCtx();
  try {
    const { db } = t.ctx;
    mk(db, "/blank-status.wav", {}, { personal_status: "" });
    mk(db, "/approved.wav", {}, { personal_status: "approved" });

    assertEquals(paths(searchTracks(db, "status:")), new Set(["/blank-status.wav"]));
  } finally {
    await t.cleanup();
  }
});

Deno.test("quoted phrase is an exact adjacent-word FTS phrase match", async () => {
  const t = await makeTestCtx();
  try {
    const { db } = t.ctx;
    mk(db, "/phrase.wav", { comment: "a hidden gem here" }, { set_role: "peak" });
    mk(db, "/scattered.wav", { comment: "gem, totally hidden" }, { set_role: "peak" });

    assertEquals(
      paths(searchTracks(db, '"hidden gem" role:peak')),
      new Set(["/phrase.wav"]),
    );
  } finally {
    await t.cleanup();
  }
});

Deno.test("energy:7-9 numeric range is inclusive", async () => {
  const t = await makeTestCtx();
  try {
    const { db } = t.ctx;
    mk(db, "/e6.wav", {}, { energy: 6 });
    mk(db, "/e7.wav", {}, { energy: 7 });
    mk(db, "/e8.wav", {}, { energy: 8 });
    mk(db, "/e9.wav", {}, { energy: 9 });
    mk(db, "/e10.wav", {}, { energy: 10 });

    assertEquals(
      paths(searchTracks(db, "energy:7-9")),
      new Set(["/e7.wav", "/e8.wav", "/e9.wav"]),
    );
  } finally {
    await t.cleanup();
  }
});

Deno.test("limit 0 means unbounded", async () => {
  const t = await makeTestCtx();
  try {
    const { db } = t.ctx;
    seedTrack(db, { absolute_path: "/a.wav", artist: "A", title: "1" });
    seedTrack(db, { absolute_path: "/b.wav", artist: "B", title: "2" });
    seedTrack(db, { absolute_path: "/c.wav", artist: "C", title: "3" });

    assertEquals(searchTracks(db, "", 1, 0).length, 1);
    assertEquals(searchTracks(db, "", 0, 0).length, 3);
  } finally {
    await t.cleanup();
  }
});

Deno.test("negated profile numeric filter excludes NULL rows, not just non-matches", async () => {
  const t = await makeTestCtx();
  try {
    const { db } = t.ctx;
    mk(db, "/five.wav", {}, { energy: 5 }); // energy = 5 -> excluded by -energy:5
    mk(db, "/nine.wav", {}, { energy: 9 }); // energy != 5 -> included
    seedTrack(db, { absolute_path: "/noprofile.wav" }); // no profile row -> NULL energy -> excluded too

    assertEquals(paths(searchTracks(db, "-energy:5")), new Set(["/nine.wav"]));
  } finally {
    await t.cleanup();
  }
});

Deno.test("artist_review filter keeps tracks without an ArtistProfile row", async () => {
  const t = await makeTestCtx();
  try {
    const { db } = t.ctx;
    const flagged = seedTrack(db, { absolute_path: "/flagged.wav", artist_normalized: "flaggedartist" });
    const clean = seedTrack(db, { absolute_path: "/clean.wav", artist_normalized: "cleanartist" });
    const noProfile = seedTrack(db, {
      absolute_path: "/unenriched.wav",
      artist_normalized: "ghostartist",
    });
    void noProfile;

    db.prepare(
      `INSERT INTO artist_profiles
        (normalized_name, canonical_name, aliases_json, track_count, scene_cluster,
         primary_subgenre, secondary_subgenres_json, typical_bpm_min, typical_bpm_max,
         energy_min, energy_max, set_role_hints_json, confidence_label, needs_review,
         notes, raw_llm_json, last_enriched_at, created_at, updated_at)
       VALUES (?, ?, NULL, 1, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, ?, NULL, NULL, NULL, ?, ?)`,
    ).run("flaggedartist", "Flaggedartist", 1, "2026-01-01T00:00:00.000Z", "2026-01-01T00:00:00.000Z");
    db.prepare(
      `INSERT INTO artist_profiles
        (normalized_name, canonical_name, aliases_json, track_count, scene_cluster,
         primary_subgenre, secondary_subgenres_json, typical_bpm_min, typical_bpm_max,
         energy_min, energy_max, set_role_hints_json, confidence_label, needs_review,
         notes, raw_llm_json, last_enriched_at, created_at, updated_at)
       VALUES (?, ?, NULL, 1, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, ?, NULL, NULL, NULL, ?, ?)`,
    ).run("cleanartist", "Cleanartist", 0, "2026-01-01T00:00:00.000Z", "2026-01-01T00:00:00.000Z");
    void flagged;
    void clean;

    assertEquals(paths(searchTracks(db, "artist_review:yes")), new Set(["/flagged.wav"]));
    assertEquals(
      paths(searchTracks(db, "artist_review:no")),
      new Set(["/clean.wav", "/unenriched.wav"]),
    );
  } finally {
    await t.cleanup();
  }
});

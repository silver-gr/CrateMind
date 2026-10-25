import { assertEquals } from "@std/assert";
import { dispatch } from "../src/api/dispatch.ts";
import { routes } from "../src/api/tracks.ts";
import { camelotOf } from "../src/services/camelot.ts";
import { countTracks, searchTracks } from "../src/services/searchExecutor.ts";
import { makeTestCtx, seedTrack } from "./helpers.ts";

const CODES = Array.from({ length: 12 }, (_, i) => [`${i + 1}A`, `${i + 1}B`]).flat();

Deno.test("Camelot normalization covers wheel bounds, musical names and enharmonics", () => {
  const cases: [string | null, string | null][] = [
    ["8A", "8a"], [" 8b ", "8b"], ["A minor", "8a"], ["A min", "8a"],
    ["A m", "8a"], ["C major", "8b"], ["C maj", "8b"], [" F♯ minor ", "11a"],
    ["G♭m", "11a"], ["A♭ minor", "1a"], ["B# major", "8b"], ["Cb", "1b"],
    ["E# minor", "4a"], ["Fb minor", "9a"], ["\t\n", null], [null, null],
    ["AM", "11b"], ["Am", "8a"], ["A MAJOR", "11b"],
    ["C-sharp minor", "12a"], ["D flat major", "3b"], ["8 A", "8a"],
    ["1m", "8a"], ["1M", "8a"], ["1d", "8b"], ["6m", "1a"], ["12d", "7b"],
    ["８Ａ", "8a"],
    ["Am7", null], ["C dorian", null], ["C diminished", null],
    ["0A", null], ["13B", null], ["99A", null], ["08A", null],
    ["unknown", null], ["A major minor", null],
  ];
  for (const [input, expected] of cases) assertEquals(camelotOf(input), expected, String(input));
  const minor = ["G#m", "D#m", "Bbm", "Fm", "Cm", "Gm", "Dm", "Am", "Em", "Bm", "F#m", "C#m"];
  const major = ["B", "F#", "Db", "Ab", "Eb", "Bb", "F", "C", "G", "D", "A", "E"];
  minor.forEach((key, i) => assertEquals(camelotOf(key), `${i + 1}a`));
  major.forEach((key, i) => assertEquals(camelotOf(key), `${i + 1}b`));
});

Deno.test("key search/count normalize effective keys and negation includes unknown and missing", async () => {
  const t = await makeTestCtx();
  try {
    const db = t.ctx.db;
    const matching = [
      seedTrack(db, { key_text: "8a", key_analyzed: "C major" }),
      seedTrack(db, { key_text: " A minor " }),
      seedTrack(db, { key_analyzed: "A minor" }),
      seedTrack(db, { key_text: "\t \n", key_analyzed: "Am" }),
    ];
    const excluded = [
      seedTrack(db, { key_text: "C major", key_analyzed: "Am" }),
      seedTrack(db, { key_text: "unknown", key_analyzed: "Am" }),
      seedTrack(db, { key_analyzed: "13A" }),
      seedTrack(db),
    ];
    for (const query of ["key:8A", "key:8a", "key:Am", 'key:"A minor"']) {
      assertEquals(new Set(searchTracks(db, query).map((row) => row.id)), new Set(matching));
      assertEquals(countTracks(db, query), matching.length);
    }
    assertEquals(new Set(searchTracks(db, "-key:8A").map((row) => row.id)), new Set(excluded));
    assertEquals(countTracks(db, "-key:8A"), excluded.length);
    for (const path of ["/api/tracks", "/api/tracks/search"]) {
      const res = await dispatch(routes(), new Request(`http://localhost${path}?q=key%3A8A`), t.ctx);
      assertEquals(res.status, 200);
      const rows = await res.json() as { id: number }[];
      assertEquals(new Set(rows.map((row) => row.id)), new Set(matching));
    }
    const res = await dispatch(routes(), new Request("http://localhost/api/tracks/count?q=-key%3A8A"), t.ctx);
    assertEquals(await res.json(), { count: excluded.length });
    for (const query of ["key:13A", "key:unknown", "key:"]) {
      assertEquals(countTracks(db, query), 0);
      assertEquals(countTracks(db, `-${query}`), matching.length + excluded.length);
    }
  } finally {
    await t.cleanup();
  }
});

Deno.test("GET /api/tracks/key-stats aggregates the whole catalog with matching search counts", async () => {
  const t = await makeTestCtx();
  try {
    const db = t.ctx.db;
    const fixtures = [
      { key_text: "8a", key_analyzed: "C major" }, { key_text: "A minor" },
      { key_analyzed: "Am" }, { key_text: "\t\n", key_analyzed: "F♯ minor" },
      { key_text: "C major", key_analyzed: "Am" }, { key_analyzed: "G♭ minor" },
      { key_text: "unknown", key_analyzed: "Am" }, { key_analyzed: "13B" },
      {}, { key_text: "\t\n", key_analyzed: "  " },
    ];
    for (const row of fixtures) seedTrack(db, row);
    const req = new Request("http://localhost/api/tracks/key-stats?limit=1&offset=3&q=key:8A");
    const res = await dispatch(routes(), req, t.ctx);
    assertEquals(res.status, 200);
    const counts = Object.fromEntries(CODES.map((code) => [code, 0]));
    counts["8A"] = 3;
    counts["8B"] = 1;
    counts["11A"] = 2;
    assertEquals(await res.json(), {
      total: 10, keyed: 6, missing: 2, unrecognized: 2, counts, metadata: 3, analyzed: 3,
    });
    for (const code of CODES) assertEquals(countTracks(db, `key:${code}`), counts[code]);
  } finally {
    await t.cleanup();
  }
});

Deno.test("GET /api/tracks/key-stats returns all zero wheel counts for an empty catalog", async () => {
  const t = await makeTestCtx();
  try {
    const res = await dispatch(routes(), new Request("http://localhost/api/tracks/key-stats"), t.ctx);
    assertEquals(res.status, 200);
    assertEquals(await res.json(), {
      total: 0, keyed: 0, missing: 0, unrecognized: 0,
      counts: Object.fromEntries(CODES.map((code) => [code, 0])), metadata: 0, analyzed: 0,
    });
  } finally {
    await t.cleanup();
  }
});

import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { artistEnrichmentProgress, currentResearchArtist, jobCreatedAtMs } from "../src/lib/artistEnrichmentProgress";
import { ArtistEnrichmentProgress } from "../src/components/ArtistEnrichmentProgress";
import type { Job } from "../src/lib/types";

const started = "2026-11-05T12:00:00.000000";
const now = Date.parse("2026-11-05T12:10:00Z");
const job = (changes: Partial<Job> = {}): Job => ({
  id: 7, kind: "artist_enrich", status: "running", processed: 10, total: 100,
  created_at: started, message: "Έρευνα είδους: Example (11/100)", ...changes,
});

test("server naive UTC and explicit offsets identify the same instant", () => {
  const expected = Date.parse("2026-11-05T12:00:00Z");
  expect(jobCreatedAtMs(started)).toBe(expected);
  expect(jobCreatedAtMs("2026-11-05 12:00:00.123456")).toBe(expected + 123);
  expect(jobCreatedAtMs("2026-11-05T14:00:00+02:00")).toBe(expected);
  expect(jobCreatedAtMs("2026-11-05T12:00:00Z")).toBe(expected);
});

test("missing, malformed and impossible creation dates do not invent an ETA", () => {
  for (const created_at of [undefined, "", "invalid", "2026-11-05", "2026-02-30T12:00:00", "2026-11-05T25:00:00", "2026-11-05T12:00:00+25:00"]) {
    expect(jobCreatedAtMs(created_at)).toBeNull();
    expect(artistEnrichmentProgress(job({ created_at }), now).remainingMinutes).toBeNull();
  }
  expect(jobCreatedAtMs("2024-02-29T12:00:00")).not.toBeNull();
});

test("remaining minutes use completed work and server elapsed time, including reattachment", () => {
  expect(artistEnrichmentProgress(job(), now).remainingMinutes).toBe(90);
  expect(artistEnrichmentProgress(job(), now + 60_000).remainingMinutes).toBe(99);
  expect(artistEnrichmentProgress(job({ processed: 2, total: 3 }), now).remainingMinutes).toBe(5);
  expect(artistEnrichmentProgress(job({ processed: 99 }), Date.parse(started + "Z") + 1000).remainingMinutes).toBe(1);
});

test("insufficient samples, no total, future clocks and terminal states withhold ETA", () => {
  for (const changes of [
    { processed: 0 }, { processed: 1 }, { total: 0 }, { total: undefined },
    { status: "pending" }, { status: "done" }, { status: "error" }, { processed: 100 },
    { created_at: "2026-11-05T12:11:00" }, { created_at: "2026-11-05T12:10:00" },
  ]) expect(artistEnrichmentProgress(job(changes), now).remainingMinutes).toBeNull();
});

test("percentage follows processed and distinguishes active work from terminal completion", () => {
  expect(artistEnrichmentProgress(job({ processed: 98, total: 361 }), now).percent).toBe(27);
  expect(artistEnrichmentProgress(job({ processed: 999, total: 1000 }), now).percent).toBe(99);
  expect(artistEnrichmentProgress(job({ processed: 100 }), now).percent).toBe(99);
  expect(artistEnrichmentProgress(job({ processed: 100, status: "error" }), now).percent).toBe(100);
  expect(artistEnrichmentProgress(job({ processed: 45, status: "error" }), now).percent).toBe(45);
  expect(artistEnrichmentProgress(job({ status: "done" }), now).percent).toBe(100);
  expect(artistEnrichmentProgress(job({ status: "pending", total: 0 }), now).percent).toBeNull();
  expect(artistEnrichmentProgress(job({ status: "done", processed: 0, total: 0 }), now).percent).toBe(100);
});

test("current artist retains parentheses and strips only the final progress suffix", () => {
  expect(currentResearchArtist("Έρευνα είδους: Name (Live) (127/471)")).toBe("Name (Live)");
  expect(currentResearchArtist("Έρευνα είδους: Name (1/2) & Other (127/471)")).toBe("Name (1/2) & Other");
  expect(currentResearchArtist("Έρευνα είδους: Δοκιμή (127/471)")).toBe("Δοκιμή");
  for (const message of [undefined, null, "", "Ο εμπλουτισμός ολοκληρώθηκε", "Έρευνα είδους: (1/10)"]) {
    expect(currentResearchArtist(message)).toBeNull();
  }
});

test("stale current-artist messages and terminal states never claim an artist is processing", () => {
  expect(artistEnrichmentProgress(job(), now).artist).toBe("Example");
  expect(artistEnrichmentProgress(job({ processed: 11 }), now).artist).toBeNull();
  expect(artistEnrichmentProgress(job({ status: "done" }), now).artist).toBeNull();
  expect(artistEnrichmentProgress(job({ status: "error" }), now).artist).toBeNull();
});

test("inline status exposes count, named artist and labelled determinate progressbar", () => {
  const html = renderToStaticMarkup(<ArtistEnrichmentProgress job={job({ created_at: new Date(Date.now() - 600_000).toISOString() })} connection="connected" />);
  expect(html).toContain('role="status"');
  expect(html).toContain('role="progressbar"');
  expect(html).toContain('aria-label="Πρόοδος έρευνας ειδών"');
  expect(html).toContain('aria-valuenow="10"');
  expect(html).toContain("10% · 10/100 επεξεργασμένοι · Τώρα: «Example» · Απομένουν ≈");
  expect(html).toContain("λεπτά");
});

test("pending, retrying and terminal renderings describe their actual state", () => {
  const pending = renderToStaticMarkup(<ArtistEnrichmentProgress job={job({ status: "pending", total: 0, processed: 0 })} connection="connected" />);
  expect(pending).toContain("Προετοιμασία έρευνας…");
  expect(pending).not.toContain("aria-valuenow");
  expect(pending).not.toContain("NaN");
  const retrying = renderToStaticMarkup(<ArtistEnrichmentProgress job={job()} connection="retrying" />);
  expect(retrying).toContain("10/100 επεξεργασμένοι · Επανασύνδεση…");
  expect(retrying).not.toContain("Τώρα:");
  expect(retrying).not.toContain("Απομένουν");
  for (const status of ["done", "error"]) {
    const html = renderToStaticMarkup(<ArtistEnrichmentProgress job={job({ status })} connection="connected" />);
    expect(html).toContain(status === "done" ? "Η έρευνα ολοκληρώθηκε" : "Η έρευνα διακόπηκε");
    expect(html).not.toContain("Τώρα:");
    expect(html).not.toContain("Απομένουν");
  }
});


test("completed jobs with per-artist failures show 100 percent; interrupted jobs keep their actual progress", () => {
  const finished = renderToStaticMarkup(<ArtistEnrichmentProgress job={job({ status: "error", processed: 361, total: 361 })} connection="connected" />);
  expect(finished).toContain('aria-valuenow="100"');
  expect(finished).toContain("100% · 361/361 επεξεργασμένοι · Ολοκληρώθηκε με σφάλματα");
  expect(finished).not.toContain("Η έρευνα διακόπηκε");
  expect(finished).not.toContain("Τώρα:");
  expect(finished).not.toContain("Απομένουν");
  const interrupted = renderToStaticMarkup(<ArtistEnrichmentProgress job={job({ status: "error", processed: 98, total: 361 })} connection="connected" />);
  expect(interrupted).toContain('aria-valuenow="27"');
  expect(interrupted).toContain("27% · 98/361 επεξεργασμένοι · Η έρευνα διακόπηκε");
  expect(interrupted).not.toContain("Ολοκληρώθηκε με σφάλματα");
  expect(interrupted).not.toContain("Τώρα:");
  expect(interrupted).not.toContain("Απομένουν");
});

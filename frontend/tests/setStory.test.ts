import { describe, expect, test } from "bun:test";
import { describeSetStory, storyMinutes, type SetStoryReading, type StoryChapter } from "../src/lib/setStory";

function chapter(over: Partial<StoryChapter> = {}): StoryChapter {
  return {
    kind: "plateau", first_row: 0, last_row: 7, track_count: 8, start_seconds: 0, seconds: 3300,
    lo: 145, hi: 150, median: 148, entry: null, lufs: -8, lufs_change: null, style: null, key: null, artist: null,
    unknown: { bpm: 0, lufs: 0, bass: 0, key: 0, style: 0 }, drift: null, ...over,
  };
}

function reading(over: Partial<SetStoryReading> = {}): SetStoryReading {
  return {
    track_count: 8, seconds: 3300, crate: false, unknown: { bpm: 0, duration: 0 }, folded: [],
    chapters: [chapter()], parentheses: [], ...over,
  };
}

describe("storyMinutes", () => {
  test("minutes, then hours and minutes", () => {
    expect(storyMinutes(3300)).toBe("55′");
    expect(storyMinutes(6600)).toBe("1ω 50′");
    expect(storyMinutes(29)).toBe("0′");
  });
});

describe("describeSetStory", () => {
  test("one steady band", () => {
    const text = describeSetStory(reading());
    expect(text.summary).toBe("Ένα κεφάλαιο, περίπου 55′.");
    expect(text.chapters).toEqual([{
      title: "Κεφάλαιο 1 · tracks 1–8", entry: null, body: "Περίπου 55′ σταθερά στα 145–150 BPM.", drift: null,
    }]);
    expect(text.notes).toEqual([]);
  });

  test("two bands with a 3:4 jump and the chapter facts", () => {
    const text = describeSetStory(reading({
      track_count: 16, seconds: 6600,
      chapters: [
        chapter({ kind: "wander", lo: 146, hi: 200, seconds: 3300, style: { name: "Hi-Tech", count: 6, of: 8 } }),
        chapter({
          first_row: 8, last_row: 15, start_seconds: 3300, seconds: 3300, lufs_change: 1.2,
          entry: { kind: "jump", from_bpm: 200, to_bpm: 146, three_four: true },
          key: { name: "8A", count: 4, of: 8 }, artist: { name: "Virtuanoise", count: 3 },
        }),
      ],
    }));
    expect(text.summary).toBe("Δύο κεφάλαια, περίπου 1ω 50′.");
    expect(text.chapters[0].body).toBe("Περίπου 55′ περιπλάνηση στα 146–200 BPM, κυρίως Hi-Tech.");
    expect(text.chapters[1]).toEqual({
      title: "Κεφάλαιο 2 · tracks 9–16 · από το ~55′",
      entry: "Άλμα 200 → 146 BPM (3:4).",
      body: "Περίπου 55′ σταθερά στα 145–150 BPM, βασικό key 8A (4 από 8), 3 tracks του Virtuanoise, 1 dB πιο δυνατά από το προηγούμενο.",
      drift: null,
    });
  });

  test("entries: a plain jump, a step and a blend; a small loudness change is not mentioned", () => {
    const entry = (kind: "blend" | "step" | "jump", three_four = false) =>
      describeSetStory(reading({ chapters: [chapter(), chapter({ entry: { kind, from_bpm: 182, to_bpm: 146, three_four }, lufs_change: -0.6 })] }))
        .chapters[1];
    expect(entry("jump").entry).toBe("Άλμα 182 → 146 BPM.");
    expect(entry("step").entry).toBe("Σκαλοπάτι 182 → 146 BPM.");
    expect(entry("blend").entry).toBe("Ομαλή συνέχεια 182 → 146 BPM.");
    expect(entry("blend").body).toBe("Περίπου 55′ σταθερά στα 145–150 BPM.");
  });

  test("drift inside a long chapter", () => {
    const text = describeSetStory(reading({
      chapters: [chapter({ drift: { tempo: [182, 176.4], lufs: [-8.64, -9.68], bass: [0.77, 0.64] } })],
    }));
    expect(text.chapters[0].drift).toBe(
      "Στο τέλος, σε σχέση με την αρχή: πιο αργά (176 από 182 BPM)· πιο ήσυχα (−9,7 από −8,6 LUFS)· λιγότερο μπάσο (64% από 77% του χρόνου).",
    );
    const up = describeSetStory(reading({ chapters: [chapter({ drift: { tempo: [176, 182], lufs: null, bass: [0.6, 0.7] } })] }));
    expect(up.chapters[0].drift).toBe("Στο τέλος, σε σχέση με την αρχή: πιο γρήγορα (182 από 176 BPM)· περισσότερο μπάσο (70% από 60% του χρόνου).");
  });

  test("a parenthesis, folded tracks, missing BPM and durations, and a crate", () => {
    const text = describeSetStory(reading({
      crate: true, folded: [2], unknown: { bpm: 2, duration: 1 },
      parentheses: [{ row: 3, chapter: 0, bpm: 200, before_bpm: 148, after_bpm: 146 }],
    }));
    expect(text.notes).toEqual([
      "2 tracks χωρίς BPM δεν μετρήθηκαν.",
      "Παρένθεση στο track 4: 200 BPM ανάμεσα σε δύο tracks της ζώνης 145–150.",
      "1 track με μισό ή διπλό tempo μετρήθηκε στο tempo του set.",
      "Σε 1 track λείπει η διάρκεια, οπότε οι χρόνοι βγαίνουν μικρότεροι.",
      "Πάνω από 4 ώρες: μοιάζει με crate· η αφήγηση μόνο περιγράφει.",
    ]);
  });

  test("no durations: no times; a one-track chapter", () => {
    const text = describeSetStory(reading({
      seconds: 0, chapters: [chapter({ seconds: 0, kind: "wander" }), chapter({ first_row: 8, last_row: 8, seconds: 0 })],
    }));
    expect(text.summary).toBe("Δύο κεφάλαια.");
    expect(text.chapters[0].body).toBe("Περιπλάνηση στα 145–150 BPM.");
    expect(text.chapters[1].title).toBe("Κεφάλαιο 2 · track 9");
  });

  test("an empty set, a set with no BPM and a set of two tracks", () => {
    expect(describeSetStory(reading({ track_count: 0, seconds: 0, chapters: [] }))).toEqual({
      summary: "Το set είναι άδειο.", chapters: [], notes: [],
    });
    const none = describeSetStory(reading({ track_count: 2, chapters: [], unknown: { bpm: 2, duration: 0 } }));
    expect(none.summary).toBe("Κανένα track δεν έχει BPM, οπότε δεν βγαίνουν κεφάλαια.");
    expect(none.notes).toEqual(["2 tracks χωρίς BPM δεν μετρήθηκαν."]);
    const two = describeSetStory(reading({ track_count: 2, chapters: [chapter({ kind: "wander", last_row: 1 })] }));
    expect(two.summary).toBe("Λίγα tracks ακόμη: τα κεφάλαια φαίνονται από 3 tracks και πάνω.");
    expect(two.chapters).toEqual([]);
  });
});

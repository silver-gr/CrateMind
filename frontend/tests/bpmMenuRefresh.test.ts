import { describe, expect, spyOn, test } from "bun:test";
import { changeBpm } from "../src/components/BpmOctaveButtons";
import { api } from "../src/lib/api";
import { applyBpmToPlays } from "../src/lib/playHistory";
import type { PlayHistoryEntry, Track } from "../src/lib/types";

const track = (id: number, bpm: number): Track => ({ id, title: `t${id}`, file_name: `t${id}.mp3`, bpm_consensus: bpm, bpm_consensus_sources: "tag" }) as Track;

describe("a menu «×½ / ×2» refreshes the place it was pressed in", () => {
  test("changeBpm calls back once the change is saved, and not when it fails", async () => {
    const savedWindow = globalThis.window;
    globalThis.window = { dispatchEvent: () => true } as any;
    const octave = spyOn(api, "setBpmOctave");
    try {
      octave.mockResolvedValueOnce({ track_id: 7, bpm_consensus: 70, bpm_consensus_sources: "manual:octave", effective_bpm: 70 });
      const done: number[] = [];
      changeBpm(track(7, 140), 0.5, () => done.push(7));
      await new Promise(resolve => setTimeout(resolve, 0));
      expect(done).toEqual([7]);

      octave.mockRejectedValueOnce(new Error("offline"));
      changeBpm(track(7, 70), 2, () => done.push(8));
      await new Promise(resolve => setTimeout(resolve, 0));
      expect(done).toEqual([7]);
    } finally {
      octave.mockRestore();
      globalThis.window = savedWindow;
    }
  });

  test("the history rows take the new BPM of every play of that track and leave the others", () => {
    const play = (id: number, t: Track): PlayHistoryEntry => ({ id, track_id: t.id, track: t } as PlayHistoryEntry);
    const plays = [play(1, track(7, 140)), play(2, track(8, 128)), play(3, track(7, 140))];
    const next = applyBpmToPlays(plays, { trackId: 7, fields: { bpm_consensus: 70, bpm_consensus_sources: "manual:octave" } });
    expect(next.map(p => p.track.bpm_consensus)).toEqual([70, 128, 70]);
    expect(next[1]).toBe(plays[1]);
    expect(plays[0].track.bpm_consensus).toBe(140);
  });
});

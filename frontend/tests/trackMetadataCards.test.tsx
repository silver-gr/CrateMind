import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import CanonicalTrackCard from "../src/components/CanonicalTrackCard";
import { InspectorSection } from "../src/components/InspectorSection";
import { TrackNotes } from "../src/components/TrackNotes";
import { SoundCloudCard } from "../src/components/SoundCloudCard";
import type { SoundCloudConfirmedMetadata } from "../src/lib/types";

const soundcloud: SoundCloudConfirmedMetadata = {
  track: {
    soundcloud_track_id: 7,
    urn: "soundcloud:7",
    permalink_url: "https://soundcloud.com/example/track",
    available: true,
    playback_count: 12345,
    title: "RAW_UPLOAD_TITLE_150BPM",
    display_title: "Clean Title",
    display_artist: "Credited Artist",
    uploader_username: "Label Account",
  },
  match: {
    track_id: 9,
    soundcloud_track_id: 7,
    confidence: 98,
    method: "canonical_recording",
    reasons: ["local:9 ↔ soundcloud:7"],
  },
};

test("SoundCloud puts the clean identity first and keeps raw evidence collapsed", () => {
  const html = renderToStaticMarkup(<SoundCloudCard soundcloud={soundcloud} candidates={[]} fallbackSeed={9} />);
  const [main, sourceDetails] = html.split("<details");

  expect(main).toContain("Clean Title");
  expect(main).toContain("Credited Artist");
  expect(main).not.toContain("Label Account");
  expect(main).not.toContain("RAW_UPLOAD_TITLE_150BPM");
  expect(main).not.toContain("local:9");
  expect(sourceDetails).toContain("Στοιχεία πηγής");
  expect(sourceDetails).toContain("RAW_UPLOAD_TITLE_150BPM");
  expect(sourceDetails).toContain("local:9");
  expect(sourceDetails).toContain("Κανονική ταυτότητα CrateMind");
  expect(html).not.toContain("canonical_recording");
  expect(html).not.toMatch(/<details[^>]*\sopen(?:\s|=|>)/);
});

test("SoundCloud identifies the posting account when a legacy snapshot has no credited artist", () => {
  const legacy = {
    ...soundcloud,
    track: { ...soundcloud.track, display_title: undefined, display_artist: undefined },
  };
  const html = renderToStaticMarkup(<SoundCloudCard soundcloud={legacy} candidates={[]} fallbackSeed={9} />);
  const main = html.split("<details")[0];

  expect(main).toContain("RAW_UPLOAD_TITLE_150BPM");
  expect(main).toContain("Λογαριασμός ανάρτησης · Label Account");
});

test("embedded source context shows one link per source and keeps extra statistics collapsed", () => {
  const canonical = {
    artist: "Credited Artist",
    title: "Clean Title",
    recording_id: "recording-id",
    credits: [],
    providers: [{
      id: "soundcloud:7",
      service: "soundcloud",
      url: "https://soundcloud.com/example/track",
      popularity: { playback_count: 12345, likes_count: 0 },
      liked_in: [{ provenance: { account: "9999999" } }],
    }, {
      id: "soundcloud:8",
      service: "soundcloud",
      url: "https://soundcloud.com/example/alternate",
      popularity: { playback_count: 8000, likes_count: 0 },
      liked_in: [{ provenance: { account: "8888888" } }],
    }, {
      id: "spotify:1",
      service: "spotify",
      url: "https://open.spotify.com/track/1",
      popularity: null,
      liked_in: [],
    }],
  };

  for (const snapshot of [soundcloud, { ...soundcloud, counter_source_id: "soundcloud:7", track: { ...soundcloud.track, urn: undefined } }]) {
    const html = renderToStaticMarkup(<>
      <CanonicalTrackCard value={canonical} soundcloud={snapshot} />
      <SoundCloudCard embedded soundcloud={snapshot} candidates={[]} fallbackSeed={9} />
    </>);
    const defaultContent = html.replace(/<details\b[\s\S]*?<\/details>/g, "");
    const playbackCount = new Intl.NumberFormat("el-GR").format(12345);

    expect(html).not.toContain("Clean Title");
    expect(html).not.toContain("Credited Artist");
    expect(defaultContent).toContain("Άνοιγμα στο SoundCloud");
    expect(defaultContent).toContain("Διαθέσιμο");
    expect(defaultContent).toContain("/canonical?id=recording-id");
    expect(defaultContent).toContain("/provenance?recording=recording-id");
    expect(defaultContent).not.toContain("RAW_UPLOAD_TITLE_150BPM");
    expect(defaultContent).not.toContain(playbackCount);
    expect(defaultContent).not.toContain("https://soundcloud.com/example/alternate");
    expect(html.match(/https:\/\/soundcloud\.com\/example\/track/g)).toHaveLength(1);
    expect(html.split(`>${playbackCount}<`)).toHaveLength(2);
    expect(html).toContain("https://soundcloud.com/example/alternate");
    expect(html).toContain("https://open.spotify.com/track/1");
    expect(html).toContain("Αποθηκευμένο στα αγαπημένα");
    expect(html).not.toContain("9999999");
    expect(html).not.toContain("8888888");
    expect(html).not.toMatch(/<details[^>]*\sopen(?:\s|=|>)/);
  }
});

test("source comments stay separate from the editable personal notes", () => {
  const track = { comment: "Original file comment", metadata_comments: [{ kind: "mastering", text: "Χωρίς mastering" }] };
  for (const notes of ["", "Existing personal note"]) {
    const html = renderToStaticMarkup(<TrackNotes track={track} notes={notes} onChange={() => {}} />);
    const textarea = html.match(/<textarea[^>]*>([\s\S]*?)<\/textarea>/)?.[1];

    expect(textarea).toBe(notes);
    expect(html).toContain("Σχόλιο αρχείου");
    expect(html).toContain("Original file comment");
    expect(html).toContain("Χωρίς mastering");
  }
});

test("advanced inspector rows start collapsed with the editing fields still mounted", () => {
  const html = renderToStaticMarkup(
    <InspectorSection title="Προφίλ μετάβασης" description="Ρόλος και ανοχή BPM">
      <input aria-label="Δοκιμαστική τιμή" defaultValue="Πρόχειρο" />
    </InspectorSection>,
  );

  expect(html).toContain("<details");
  expect(html).not.toMatch(/<details[^>]*\sopen(?:\s|=|>)/);
  const [summary, controls] = html.split("</summary>");
  expect(summary).toContain("Προφίλ μετάβασης");
  expect(summary).toContain("Ρόλος και ανοχή BPM");
  expect(controls).toContain('value="Πρόχειρο"');
});

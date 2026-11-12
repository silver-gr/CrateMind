import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { LibraryBulkActions, LibraryTools } from "../src/components/LibraryTools";

const noop = () => {};
const toolsProps = {
  sets: [],
  activeSetId: null,
  onActiveSetChange: noop,
  onCreateSet: noop,
  canSaveCrate: false,
  onSaveCrate: noop,
  pendingSoundCloud: 7,
};

test("Library tools are a closed disclosure independent of any selected track", () => {
  const html = renderToStaticMarkup(<LibraryTools {...toolsProps} />);
  const [summary, contents] = html.split("</summary>");

  expect(summary).toContain("Εργαλεία βιβλιοθήκης");
  expect(html).not.toMatch(/<details[^>]*\sopen(?:\s|=|>)/);
  expect(contents).toContain("Ενεργό set");
  expect(contents).toContain("Νέο set");
  expect(contents).toMatch(/<button[^>]*\sdisabled=""[^>]*>.*Αποθήκευση ως crate/);
  expect(contents).toContain("Στήλες");
  expect(contents).toContain("Επαναφορά μεγεθών");
  expect(contents).not.toContain("Έλεγχος SoundCloud");
});

test("the SoundCloud review control and pending count follow provider availability", () => {
  const html = renderToStaticMarkup(<LibraryTools {...toolsProps} onReviewSoundCloud={noop} />);

  expect(html).toContain("Έλεγχος SoundCloud");
  expect(html).toContain(">7</span>");
});

test("the bulk disclosure keeps the editor mounted and shows selection when closed", () => {
  const html = renderToStaticMarkup(
    <LibraryBulkActions selectedIds={new Set([2, 3])} query="bpm:170" onApplied={noop} canAnalyze />,
  );
  const [summary, contents] = html.split("</summary>");

  expect(html).not.toMatch(/<details[^>]*\sopen(?:\s|=|>)/);
  expect(summary).toContain("Μαζική επεξεργασία");
  expect(summary).toContain(">2</span>");
  expect(summary).toContain("επιλεγμένα");
  expect(contents).toContain("Επιλεγμένα (2)");
  expect(contents).toContain("Όλα τα αποτελέσματα");
  expect(contents).toContain("Ανάλυση BPM");
});

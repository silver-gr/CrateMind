import { expect, test } from "bun:test";
import { renderToString } from "react-dom/server";
import SetActions from "../src/components/SetActions";

function render(disabled = false) {
  const noop = () => {};
  return renderToString(<SetActions disabled={disabled} onNew={noop} onSave={noop} onDuplicate={noop} onExport={noop} />);
}

test("compact set menu retains new/copy, explicit JSON backup Save and every export", () => {
  const html = render().replaceAll("<!-- -->", "");
  expect(html).toContain('aria-label="Ενέργειες set"');
  expect(html).toContain("Νέο set");
  expect(html).toContain("Δημιουργία αντιγράφου");
  expect(html).toContain("Αποθήκευση");
  expect(html).toContain("Αντίγραφο ασφαλείας JSON");
  for (const format of ["M3U", "CSV", "Markdown", "JSON"]) expect(html).toContain(`Εξαγωγή ${format}`);
  expect(html.match(/<button/g)).toHaveLength(7);
});

test("new set remains available before selecting or loading a set", () => {
  const buttons = render(true).match(/<button[^>]*>.*?<\/button>/g) ?? [];
  expect(buttons[0]).toContain("Νέο set");
  expect(buttons[0]).not.toContain('disabled=""');
  for (const button of buttons.slice(1)) expect(button).toContain('disabled=""');
});

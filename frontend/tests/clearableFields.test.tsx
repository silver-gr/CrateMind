import { expect, test } from "bun:test";
import { renderToString } from "react-dom/server";
import { Input } from "../src/components/ui/input";
import { Textarea } from "../src/components/ui/textarea";

const onChange = () => {};

test("text fields put a named non-submit clear control after the field inside its wrapper", () => {
  const html = renderToString(<Input aria-label="Αναζήτηση" value="techno" onChange={onChange} wrapperClassName="flex-1" className="pl-8 pr-2" />);
  expect(html).toContain('data-slot="input-wrapper" class="relative block w-full min-w-0 flex-1"');
  expect(html).toContain('aria-label="Καθαρισμός: Αναζήτηση"');
  expect(html).toContain('type="button"');
  expect(html.indexOf("<button")).toBeGreaterThan(html.indexOf("<input"));
  expect(html.indexOf("</button>")).toBeLessThan(html.indexOf("</span>"));
  expect(html).toContain("pl-8");
  expect(html).toContain("pr-9");
  expect(html).not.toContain("pr-2");
});

test("empty, disabled, read-only and non-text inputs have no clear control", () => {
  for (const field of [
    <Input value="" onChange={onChange} />,
    <Input value="saved" disabled onChange={onChange} />,
    <Input value="saved" readOnly />,
    <Input type="number" value={120} onChange={onChange} />,
    <Input type="range" value={0.5} onChange={onChange} />,
    <Input type="file" />,
  ]) {
    expect(renderToString(field)).not.toContain("<button");
  }
});

test("search and uncontrolled text inputs expose the same clear affordance", () => {
  for (const field of [
    <Input type="search" value="artist" onChange={onChange} />,
    <Input defaultValue="initial" />,
  ]) {
    const html = renderToString(field);
    expect(html).toContain('aria-label="Καθαρισμός πεδίου"');
    expect(html).toContain("right-1");
  }
});

test("textarea clear control stays at the upper right and respects editing state", () => {
  const html = renderToString(<Textarea value="Σημείωση" onChange={onChange} />);
  expect(html).toContain('data-slot="textarea-wrapper"');
  const button = html.match(/<button[^>]*>/)?.[0];
  expect(button).toContain("right-1");
  expect(button).toContain("top-1");
  expect(button).not.toContain("-translate-y-1/2");
  for (const field of [<Textarea value="" onChange={onChange} />, <Textarea value="saved" disabled onChange={onChange} />, <Textarea value="saved" readOnly />]) {
    expect(renderToString(field)).not.toContain("<button");
  }
});

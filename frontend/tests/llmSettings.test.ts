import { describe, expect, test } from "bun:test";
import {
  baseUrlProblem,
  effortOptions,
  envNote,
  formFromView,
  keyStatusText,
  savePatch,
  testDraft,
  type LlmSettingsView,
} from "../src/lib/llmSettings";

function view(patch: Partial<LlmSettingsView> = {}): LlmSettingsView {
  return {
    base_url: "https://llm.example/v1",
    model: "test-model",
    effort: "high",
    efforts: ["minimal", "low", "medium", "high", "xhigh", "max"],
    api_key: { stored: true, last4: "wxyz" },
    sources: { base_url: "file", model: "file", effort: "file", api_key: "file" },
    env_names: {
      base_url: "CRATEMIND_LLM1_BASE_URL", model: "CRATEMIND_LLM1_MODEL",
      effort: "CRATEMIND_LLM1_MODEL_EFFORT", api_key: "CRATEMIND_LLM1_API_KEY",
    },
    key_file: "/data/llm-settings.json",
    configured: true,
    ...patch,
  };
}

describe("llm settings", () => {
  test("the form never starts with a key", () => {
    expect(formFromView(view())).toEqual({ base_url: "https://llm.example/v1", model: "test-model", effort: "high", api_key: "" });
  });

  test("effort choices start with «Χωρίς» and keep an unknown value in use", () => {
    expect(effortOptions(view()).map(o => o.value)).toEqual(["none", "minimal", "low", "medium", "high", "xhigh", "max"]);
    expect(effortOptions(view())[0].label).toBe("Χωρίς (δεν στέλνεται)");
    expect(effortOptions(view({ effort: "ultra" })).at(-1)).toEqual({ value: "ultra", label: "ultra" });
  });

  test("the key status shows only the last four characters", () => {
    expect(keyStatusText({ stored: true, last4: "wxyz" }, "file")).toBe("Αποθηκευμένο κλειδί · τελειώνει σε …wxyz");
    expect(keyStatusText({ stored: true, last4: null }, "file")).toBe("Αποθηκευμένο κλειδί");
    expect(keyStatusText({ stored: true, last4: "abcd" }, "env")).toBe("Κλειδί από μεταβλητή περιβάλλοντος · τελειώνει σε …abcd");
    expect(keyStatusText({ stored: false, last4: null }, "default")).toBe("Δεν έχει οριστεί κλειδί.");
  });

  test("an environment value is named under its field", () => {
    const env = view({ sources: { base_url: "file", model: "env", effort: "default", api_key: "file" } });
    expect(envNote(env, "model")).toContain("CRATEMIND_LLM1_MODEL");
    expect(envNote(env, "base_url")).toBeNull();
  });

  test("endpoint checks", () => {
    expect(baseUrlProblem("https://api.openai.com/v1")).toBeNull();
    expect(baseUrlProblem("http://127.0.0.1:8317/v1")).toBeNull();
    expect(baseUrlProblem("")).not.toBeNull();
    expect(baseUrlProblem("ftp://x")).toContain("http");
    expect(baseUrlProblem("https://user:pw@x/v1")).not.toBeNull();
    expect(baseUrlProblem("https://x/v1?key=1")).not.toBeNull();
    expect(baseUrlProblem("not a url")).toBe("Η διεύθυνση δεν είναι έγκυρη.");
  });

  test("a save sends only what changed, the key only when a new one was typed", () => {
    const current = view();
    expect(savePatch(formFromView(current), current)).toEqual({});
    expect(savePatch({ ...formFromView(current), model: " other ", api_key: "  sk-new  " }, current))
      .toEqual({ model: "other", api_key: "sk-new" });
    expect(savePatch({ ...formFromView(current), effort: "none" }, current)).toEqual({ effort: "none" });
  });

  test("a save never sends a field the environment sets", () => {
    const env = view({ sources: { base_url: "env", model: "file", effort: "file", api_key: "env" } });
    expect(savePatch({ ...formFromView(env), base_url: "https://other/v1", api_key: "sk-new" }, env)).toEqual({});
  });

  test("the connection test tries the form's unsaved values", () => {
    const current = view();
    expect(testDraft(formFromView(current), current)).toEqual({});
    expect(testDraft({ ...formFromView(current), base_url: "https://other/v1", api_key: "sk-new" }, current))
      .toEqual({ base_url: "https://other/v1", api_key: "sk-new" });
  });
});

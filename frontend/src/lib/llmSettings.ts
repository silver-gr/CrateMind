/** Settings «Μοντέλο τεχνητής νοημοσύνης»: pure logic for the LLM connection form. The API key is
 * write-only: the page sends a new one once and only ever shows whether one is stored. */

export type LlmField = "base_url" | "model" | "effort" | "api_key";
export type LlmSource = "env" | "file" | "default";

/** `GET /api/llm-settings`. No field ever holds the key itself. */
export interface LlmSettingsView {
  base_url: string;
  model: string;
  /** "none": no effort is sent. */
  effort: string;
  efforts: string[];
  api_key: { stored: boolean; last4: string | null };
  sources: Record<LlmField, LlmSource>;
  env_names: Record<LlmField, string>;
  key_file: string;
  configured: boolean;
}

export interface LlmTestResult {
  ok: boolean;
  model_listed: boolean | null;
  message: string;
}

export interface LlmForm {
  base_url: string;
  model: string;
  effort: string;
  /** A new key typed into the field; empty keeps the stored one. */
  api_key: string;
}

export const NO_EFFORT = "none";

const EFFORT_LABELS: Record<string, string> = {
  none: "Χωρίς (δεν στέλνεται)",
  minimal: "minimal",
  low: "low",
  medium: "medium",
  high: "high",
  xhigh: "xhigh",
  max: "max",
};

export const KEY_STORAGE_NOTE =
  "Το κλειδί φυλάσσεται σε απλό αρχείο στον φάκελο δεδομένων του CrateMind, με πρόσβαση μόνο για τον λογαριασμό σου· όποιος έχει πρόσβαση σε αυτόν τον λογαριασμό σε αυτόν τον υπολογιστή μπορεί να το διαβάσει.";

/** The effort choices: «Χωρίς», then the values the client sends, plus an unknown value already in use. */
export function effortOptions(view: Pick<LlmSettingsView, "efforts" | "effort">): { value: string; label: string }[] {
  const values = [NO_EFFORT, ...view.efforts];
  if (view.effort && !values.includes(view.effort)) values.push(view.effort);
  return values.map(value => ({ value, label: EFFORT_LABELS[value] ?? value }));
}

export function formFromView(view: LlmSettingsView): LlmForm {
  return { base_url: view.base_url, model: view.model, effort: view.effort, api_key: "" };
}

export function keyStatusText(key: LlmSettingsView["api_key"], source: LlmSource): string {
  if (!key.stored) return "Δεν έχει οριστεί κλειδί.";
  const where = source === "env" ? "Κλειδί από μεταβλητή περιβάλλοντος" : "Αποθηκευμένο κλειδί";
  return key.last4 ? `${where} · τελειώνει σε …${key.last4}` : where;
}

/** Said under a field whose value comes from the web runner's environment or `.env`, which wins over a save. */
export function envNote(view: Pick<LlmSettingsView, "sources" | "env_names">, field: LlmField): string | null {
  if (view.sources[field] !== "env") return null;
  return `Σε χρήση η τιμή της μεταβλητής ${view.env_names[field]} (περιβάλλον ή .env)· υπερισχύει της αποθηκευμένης.`;
}

/** A Greek problem with the endpoint as typed, or null. */
export function baseUrlProblem(value: string): string | null {
  const text = value.trim();
  if (!text) return "Γράψε τη διεύθυνση του παρόχου, π.χ. https://api.openai.com/v1.";
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    return "Η διεύθυνση δεν είναι έγκυρη.";
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return "Η διεύθυνση πρέπει να ξεκινά με http:// ή https://.";
  if (url.username || url.password) return "Μη βάζεις όνομα χρήστη ή κωδικό μέσα στη διεύθυνση.";
  if (url.search || url.hash) return "Η διεύθυνση δεν χρειάζεται ? ή #.";
  return null;
}

/** The fields that changed and are not set by the environment; the key only when a new one was typed. */
export function savePatch(form: LlmForm, view: LlmSettingsView): Partial<Record<LlmField, string>> {
  const patch: Partial<Record<LlmField, string>> = {};
  for (const field of ["base_url", "model", "effort"] as const) {
    const value = form[field].trim();
    if (view.sources[field] !== "env" && value && value !== view[field]) patch[field] = value;
  }
  const key = form.api_key.trim();
  if (key && view.sources.api_key !== "env") patch.api_key = key;
  return patch;
}

/** What the connection test should try: the form's values that differ from those in use. */
export function testDraft(form: LlmForm, view: LlmSettingsView): Partial<Record<"base_url" | "model" | "api_key", string>> {
  const draft: Partial<Record<"base_url" | "model" | "api_key", string>> = {};
  if (form.base_url.trim() && form.base_url.trim() !== view.base_url) draft.base_url = form.base_url.trim();
  if (form.model.trim() && form.model.trim() !== view.model) draft.model = form.model.trim();
  if (form.api_key.trim()) draft.api_key = form.api_key.trim();
  return draft;
}

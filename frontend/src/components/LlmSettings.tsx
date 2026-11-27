import { useEffect, useState } from "react";
import { toast } from "sonner";
import { api } from "../lib/api";
import { apiMessage } from "../lib/facets";
import {
  baseUrlProblem,
  effortOptions,
  envNote,
  formFromView,
  KEY_STORAGE_NOTE,
  keyStatusText,
  savePatch,
  testDraft,
  type LlmField,
  type LlmForm,
  type LlmSettingsView,
  type LlmTestResult,
} from "../lib/llmSettings";
import { cn } from "../lib/cn";
import { SettingRow, SettingsCard } from "./settings/SettingRow";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";

/** Settings > «Μοντέλο τεχνητής νοημοσύνης»: endpoint, model, effort and a write-only API key. */
export function LlmSettings() {
  const [view, setView] = useState<LlmSettingsView | null>(null);
  const [form, setForm] = useState<LlmForm | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [editingKey, setEditingKey] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [busy, setBusy] = useState<"save" | "delete" | "test" | null>(null);
  const [test, setTest] = useState<LlmTestResult | null>(null);

  useEffect(() => {
    let live = true;
    api.llmSettings()
      .then(next => { if (live) apply(next); })
      .catch(error => { if (live) setLoadError(apiMessage(error)); });
    return () => { live = false; };
  }, []);

  function apply(next: LlmSettingsView) {
    setView(next);
    setForm(formFromView(next));
    setEditingKey(false);
    setConfirmDelete(false);
  }

  if (loadError) return <SettingsCard><p role="alert" className="px-4 py-3 text-xs text-cm-rose">{loadError}</p></SettingsCard>;
  if (!view || !form) return <SettingsCard><p className="px-4 py-3 text-xs text-cm-muted">Φόρτωση…</p></SettingsCard>;

  const set = (field: LlmField, value: string) => { setForm({ ...form, [field]: value }); setTest(null); };
  const fromEnv = (field: LlmField) => view.sources[field] === "env";
  const showKeyInput = !fromEnv("api_key") && (!view.api_key.stored || editingKey);

  async function save() {
    if (!view || !form) return;
    const problem = fromEnv("base_url") ? null : baseUrlProblem(form.base_url);
    if (problem) return void toast.error(problem);
    if (!fromEnv("model") && !form.model.trim()) return void toast.error("Γράψε το όνομα του μοντέλου.");
    const patch = savePatch(form, view);
    if (Object.keys(patch).length === 0) return void toast("Δεν άλλαξε κάτι.");
    setBusy("save");
    try {
      apply(await api.saveLlmSettings(patch));
      toast.success("Οι ρυθμίσεις του μοντέλου αποθηκεύτηκαν· ισχύουν από την επόμενη έρευνα.");
    } catch (error) {
      toast.error(apiMessage(error));
    } finally {
      setBusy(null);
    }
  }

  async function removeKey() {
    setBusy("delete");
    try {
      apply(await api.deleteLlmApiKey());
      setTest(null);
      toast.success("Το κλειδί διαγράφηκε.");
    } catch (error) {
      toast.error(apiMessage(error));
    } finally {
      setBusy(null);
    }
  }

  async function runTest() {
    if (!view || !form) return;
    setBusy("test");
    setTest(null);
    try {
      setTest(await api.testLlmConnection(testDraft(form, view)));
    } catch (error) {
      setTest({ ok: false, model_listed: null, message: apiMessage(error) });
    } finally {
      setBusy(null);
    }
  }

  const note = (field: LlmField) => {
    const text = envNote(view, field);
    return text ? <span className="mt-1 block text-cm-amber">{text}</span> : null;
  };

  return (
    <form
      className="flex flex-col gap-4"
      autoComplete="off"
      onSubmit={event => { event.preventDefault(); void save(); }}
    >
      <SettingsCard title="Σύνδεση">
        <SettingRow
          label="Διεύθυνση (endpoint)"
          help={<>Πάροχος συμβατός με OpenAI, π.χ. https://api.openai.com/v1. Η έρευνα καλλιτεχνών χρησιμοποιεί το /responses με αναζήτηση στο web.{note("base_url")}</>}
        >
          <Input
            aria-label="Διεύθυνση (endpoint)"
            className="h-8 w-[300px] max-w-full font-mono text-xs"
            value={form.base_url}
            disabled={fromEnv("base_url")}
            spellCheck={false}
            placeholder="https://api.openai.com/v1"
            onChange={event => set("base_url", event.target.value)}
          />
        </SettingRow>
        <SettingRow label="Μοντέλο" help={note("model")}>
          <Input
            aria-label="Μοντέλο"
            className="h-8 w-[300px] max-w-full font-mono text-xs"
            value={form.model}
            disabled={fromEnv("model")}
            spellCheck={false}
            onChange={event => set("model", event.target.value)}
          />
        </SettingRow>
        <SettingRow
          label="Επίπεδο σκέψης (effort)"
          help={<>Στέλνεται ως reasoning effort. Αν ο πάροχος δεν το δέχεται, διάλεξε «Χωρίς».{note("effort")}</>}
        >
          <Select value={form.effort} onValueChange={value => set("effort", value)} disabled={fromEnv("effort")}>
            <SelectTrigger size="sm" className="w-[190px] max-w-full text-xs" aria-label="Επίπεδο σκέψης (effort)">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {effortOptions(view).map(option => (
                <SelectItem key={option.value} value={option.value}>{option.label}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        </SettingRow>
        <SettingRow
          label="Κλειδί API"
          help={
            <>
              <span className="block text-cm-text">{keyStatusText(view.api_key, view.sources.api_key)}</span>
              <span className="mt-1 block">{KEY_STORAGE_NOTE}</span>
              <span className="mt-1 block break-all font-mono text-[11px] text-cm-faint">{view.key_file}</span>
              {note("api_key")}
            </>
          }
        >
          {showKeyInput ? (
            <>
              <Input
                type="password"
                aria-label="Νέο κλειδί API"
                className="h-8 w-[260px] max-w-full font-mono text-xs"
                value={form.api_key}
                autoComplete="off"
                spellCheck={false}
                placeholder={view.api_key.stored ? "Νέο κλειδί" : "Επικόλλησε το κλειδί"}
                onChange={event => set("api_key", event.target.value)}
              />
              {view.api_key.stored && (
                <Button type="button" variant="ghost" size="sm" onClick={() => { setEditingKey(false); set("api_key", ""); }}>
                  Άκυρο
                </Button>
              )}
            </>
          ) : !fromEnv("api_key") && (
            <>
              <Button type="button" variant="outline" size="sm" onClick={() => setEditingKey(true)}>Αλλαγή</Button>
              {confirmDelete ? (
                <Button type="button" variant="destructive" size="sm" disabled={busy !== null} onClick={() => void removeKey()}>
                  Επιβεβαίωση διαγραφής
                </Button>
              ) : (
                <Button type="button" variant="outline" size="sm" onClick={() => setConfirmDelete(true)}>Διαγραφή</Button>
              )}
            </>
          )}
        </SettingRow>
      </SettingsCard>
      <SettingsCard>
        <SettingRow
          label="Αποθήκευση και δοκιμή"
          help="Η δοκιμή κάνει ένα αίτημα για τη λίστα μοντέλων του παρόχου (χωρίς χρέωση tokens), με όριο 10 δευτερόλεπτα. Δοκιμάζει ό,τι γράφεις στη φόρμα, ακόμη κι αν δεν το έχεις αποθηκεύσει."
        >
          <Button type="button" variant="outline" size="sm" disabled={busy !== null} onClick={() => void runTest()}>
            {busy === "test" ? "Δοκιμή…" : "Δοκιμή σύνδεσης"}
          </Button>
          <Button type="submit" size="sm" disabled={busy !== null}>
            {busy === "save" ? "Αποθήκευση…" : "Αποθήκευση"}
          </Button>
        </SettingRow>
        {test && (
          <p role="status" className={cn("px-4 py-3 text-xs", test.ok ? (test.model_listed === false ? "text-cm-amber" : "text-cm-chartreuse") : "text-cm-rose")}>
            {test.message}
          </p>
        )}
      </SettingsCard>
    </form>
  );
}

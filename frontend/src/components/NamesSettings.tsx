/** Settings > «Καθαρά ονόματα»: the switch, the counts per status, unread tracks and the names job.
 *  Mounted by pages/Settings.tsx (section `names`). The rules live in lib/namesSettings.ts. */
import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { api } from "../lib/api";
import { apiMessage } from "../lib/facets";
import {
  NAMES_POLL_MS,
  SCAN_SECTION_HREF,
  canRunNow,
  countRows,
  lastRunText,
  newChangesView,
  runText,
  shouldPoll,
  switchView,
  unreadText,
  unreadableText,
} from "../lib/namesSettings";
import type { NamesStatus } from "../lib/types";
import { GlossaryLink } from "./GlossaryLink";
import { SettingRow, SettingsCard } from "./settings/SettingRow";
import { Button } from "./ui/button";
import { Switch } from "./ui/switch";

export function NamesSettings() {
  const [status, setStatus] = useState<NamesStatus | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let active = true;
    api.namesStatus()
      .then(value => { if (active) setStatus(value); })
      .catch(reason => { if (active) setLoadError(apiMessage(reason)); });
    return () => { active = false; };
  }, []);

  // Re-read while a run is queued or running, so its end (and the new counts) shows without a reload.
  const polling = shouldPoll(status);
  useEffect(() => {
    if (!polling) return;
    let active = true;
    const timer = setInterval(() => {
      api.namesStatus().then(value => { if (active) setStatus(value); }).catch(() => { /* the next tick tries again */ });
    }, NAMES_POLL_MS);
    return () => { active = false; clearInterval(timer); };
  }, [polling]);

  async function act(call: () => Promise<NamesStatus>) {
    setBusy(true); setError(null);
    try { setStatus(await call()); }
    catch (reason) {
      setError(apiMessage(reason));
      api.namesStatus().then(setStatus).catch(() => { /* keep the last status */ });
    } finally { setBusy(false); }
  }

  if (loadError) return <SettingsCard><p role="alert" className="px-4 py-3 text-xs text-cm-rose">{loadError}</p></SettingsCard>;
  if (!status) return <SettingsCard><p role="status" className="px-4 py-3 text-xs text-cm-muted">Φόρτωση…</p></SettingsCard>;
  return (
    <NamesSettingsView
      status={status}
      busy={busy}
      error={error}
      onSwitch={on => void act(() => api.setNamesSwitch(on))}
      onRun={() => void act(() => api.runNames())}
    />
  );
}

/** The section for one status reply; separate from the fetching so it renders in tests. */
export function NamesSettingsView({
  status,
  busy = false,
  error = null,
  onSwitch,
  onRun,
}: {
  status: NamesStatus;
  busy?: boolean;
  error?: string | null;
  onSwitch: (on: boolean) => void;
  onRun: () => void;
}) {
  const toggle = switchView(status, busy);
  const changes = newChangesView(status);
  const running = runText(status.run);
  const lastRun = lastRunText(status.last_run, status.ruleset);
  return (
    <div className="flex flex-col gap-4">
      <SettingsCard title="Διακόπτης" action={<GlossaryLink id="clean-names" />}>
        <SettingRow
          label="Καθαρά ονόματα"
          help={
            <>
              Καθαρά ονόματα καλλιτεχνών και τίτλων στη Βιβλιοθήκη, στα sets, στο ιστορικό και στην αναζήτηση. Τα αρχεία
              και τα tags τους δεν αλλάζουν ποτέ· κλειστός, όλα είναι όπως πριν. Ένα deck κρατά τα ονόματα που φόρτωσε ως
              την επόμενη φόρτωση.
              {toggle.reason && (
                <span className="mt-1 block text-cm-amber">
                  {toggle.reason} <Link to={SCAN_SECTION_HREF} className="underline underline-offset-2">Άνοιγμα σάρωσης</Link>
                </span>
              )}
            </>
          }
        >
          <Switch
            size="sm"
            checked={toggle.checked}
            disabled={toggle.disabled}
            onCheckedChange={onSwitch}
            aria-label="Καθαρά ονόματα"
          />
        </SettingRow>
        {error && <p role="alert" className="px-4 py-3 text-xs text-cm-rose">{error}</p>}
      </SettingsCard>

      <SettingsCard title="Κομμάτια">
        <ul className="grid grid-cols-[minmax(0,1fr)_auto] gap-x-6 gap-y-1.5 px-4 py-3 text-sm">
          {countRows(status).map(row => (
            <li key={row.status} className="contents">
              <span className="text-cm-muted">{row.label}</span>
              {row.count > 0
                ? <Link to={row.href} className="text-right font-mono tabular-nums text-cm-text underline-offset-2 hover:underline">{row.count.toLocaleString("el-GR")}</Link>
                : <span className="text-right font-mono tabular-nums text-cm-faint">0</span>}
            </li>
          ))}
        </ul>
        <div className="space-y-1.5 px-4 py-3 text-xs">
          {changes.href
            ? <Link to={changes.href} className="block text-cm-cyan underline-offset-2 hover:underline">{changes.text}</Link>
            : <p className="text-cm-muted">{changes.text}</p>}
          {status.unread > 0 && !toggle.reason && (
            <p className="text-cm-amber">
              {unreadText(status.unread)}: <Link to={SCAN_SECTION_HREF} className="underline underline-offset-2">κάνε σάρωση</Link>
            </p>
          )}
          {status.unreadable > 0 && (
            <p className="text-cm-muted">
              {unreadableText(status.unreadable)}· τα ονόματά τους βγαίνουν από ό,τι έχει ήδη η βιβλιοθήκη.
            </p>
          )}
        </div>
      </SettingsCard>

      <SettingsCard>
        <SettingRow
          label="Ενημέρωση ονομάτων"
          help="Υπολογίζει ξανά τα ονόματα τώρα. Με ανοιχτό τον διακόπτη γίνεται και μόνη της, μετά από κάθε σάρωση, ανάλυση ή απάντησή σου."
        >
          <Button type="button" variant="outline" size="sm" disabled={!canRunNow(status, busy)} onClick={onRun}>
            Ενημέρωση ονομάτων
          </Button>
        </SettingRow>
        {(running || lastRun || status.refusal_text) && (
          <div className="space-y-1.5 px-4 py-3 text-xs">
            {running && <p role="status" className="text-cm-cyan">{running}</p>}
            {status.refusal_text && <p role="alert" className="text-cm-amber">{status.refusal_text}</p>}
            {lastRun && <p className="text-cm-muted">{lastRun}</p>}
          </div>
        )}
      </SettingsCard>
    </div>
  );
}

import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { hasProviderWorkflows, useCapabilities } from "../lib/capabilities";
import { nativeAction } from "../lib/desktopRuntime";
import { toast } from "sonner";
import { api } from "../lib/api";
import { cn } from "../lib/cn";
import { usePlayer } from "../lib/player";
import { SET_ROLES } from "../lib/types";
import type { ArtistPrefill, Facet, FacetValue, Profile, SoundCloudTrackDetail } from "../lib/types";
import type { ChipTone } from "../lib/queryChips";
import { axisLabel, editorStatus, fieldLabel, statusLabel, statusValues, valueLabel, writesOnlyShownStatus } from "../lib/labels";
import { apiMessage, notifyFacetsChanged, tagDisplayName, useFacets } from "../lib/facets";
import { numFields, type NumField } from "../lib/profileFields";
import { getPref } from "../lib/prefs";
import { FacetEditor } from "./FacetEditor";
import { Artwork } from "./ui/Artwork";
import { GlassPanel } from "./ui/GlassPanel";
import { SectionHeader } from "./ui/SectionHeader";
import { SmartChip } from "./ui/SmartChip";
import { InspectorSection } from "./InspectorSection";
import { SoundCloudCard } from "./SoundCloudCard";
import CanonicalTrackCard from "./CanonicalTrackCard";
import { TrackNotes } from "./TrackNotes";
import { Tooltip, TooltipContent, TooltipTrigger } from "./ui/tooltip";
import { Info } from "../lib/icons";
import { usePref } from "../lib/prefs";
import { formatKey, keyColor } from "../lib/camelot";
import { bpmColor } from "../lib/bpmColor";
import { BpmOctaveButtons } from "./BpmOctaveButtons";
import { effectiveBpm, bpmSource, bpmDescription } from "../lib/tempo";
import { Slider } from "@/components/ui/slider";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { Button } from "@/components/ui/button";
import SpecularButton from "./ui/SpecularButton";
import { Badge } from "@/components/ui/badge";
import {
  Play,
  CheckCircle2,
  Save,
  Loader2,
  X,
  Plus,
  Clock,
  ChevronRight,
} from "../lib/icons";

export const SUBSTYLES = [
  "goa", "prog-psy", "full-on", "morning-full-on", "night-full-on", "twilight",
  "darkpsy", "forest", "hi-tech", "psycore", "zenonesque",
];

/** Typical BPM range and a one-line description per substyle, shown in the picker's (i) tooltip. */
export const SUBSTYLE_INFO: Record<string, { bpm: string; description: string }> = {
  "goa": { bpm: "135–150", description: "Η ρίζα του psytrance: μελωδικά, ψυχεδελικά leads, ανατολίτικες κλίμακες, acid γραμμές." },
  "prog-psy": { bpm: "130–142", description: "Πιο αργό και υπνωτικό: σταδιακό χτίσιμο, groove και βαθύ μπάσο αντί για μεγάλες μελωδίες." },
  "full-on": { bpm: "140–148", description: "Ενεργητικό και μελωδικό: rolling bassline, δυνατά leads, peak χορός." },
  "morning-full-on": { bpm: "140–148", description: "Φωτεινό, ευφορικό full-on για πρωινά set." },
  "night-full-on": { bpm: "145–152", description: "Πιο σκοτεινό και επιθετικό full-on, βαρύτερα effects, για νυχτερινά set." },
  "twilight": { bpm: "145–155", description: "Ανάμεσα σε full-on και dark: σκοτεινή ατμόσφαιρα με μελωδικά στοιχεία." },
  "darkpsy": { bpm: "148–165+", description: "Σκοτεινό, χαοτικό, πειραματικό: παράξενοι ήχοι, ελάχιστη μελωδία." },
  "forest": { bpm: "148–160", description: "Οργανικό και ατμοσφαιρικό: ήχοι δάσους, glitchy υφές, σκοτεινή ψυχεδέλεια." },
  "hi-tech": { bpm: "170–220+", description: "Πολύ γρήγορο και τεχνικό: μικρο-ήχοι, ακρίβεια, συνεχής ροή." },
  "psycore": { bpm: "180–250+", description: "Ακραίο tempo και ένταση: θορυβώδες, βίαιο, πειραματικό." },
  "zenonesque": { bpm: "125–140", description: "Minimal και groovy: funky μπάσα, λεπτομερείς υφές (από το ύφος της Zenon Records)." },
};

export const BREAKDOWNS = [
  "no break", "short break", "long melodic break", "fakeout", "cinematic",
];

export const TOLERANCES = [
  "native", "can_push_up", "can_push_down", "do_not_warp", "huge",
];

export const BOOL_FIELDS: { key: keyof Profile; label: string }[] = [
  { key: "dramatic_transition_candidate", label: "δραματικό" },
  { key: "can_cut_into", label: "δέχεται cut-in" },
  { key: "can_cut_out_of", label: "βγαίνει με cut-out" },
];

const STATUS_TONE: Record<string, ChipTone> = {
  unknown: "muted",
  testing: "blue",
  approved: "cyan",
  weapon: "chartreuse",
  retired: "muted",
  avoid: "rose",
};

const ARTIST_CONFIDENCE = new Map([
  ["high", "Υψηλή βεβαιότητα"],
  ["medium", "Μέτρια βεβαιότητα"],
  ["low", "Χαμηλή βεβαιότητα"],
]);

const countFormat = new Intl.NumberFormat("el-GR");

function prefillEnergy(prefill: ArtistPrefill): number | null {
  const range = prefill.energy_range;
  if (!range) return null;
  const [min, max] = range;
  if (min == null && max == null) return null;
  if (min != null && max != null) return Math.round((min + max) / 2);
  return min ?? max ?? null;
}

function prefillRole(prefill: ArtistPrefill): string | null {
  return prefill.set_role_hints?.[0] ?? null;
}

export default function ProfileEditor({
  detail,
  onSaved,
  onAddToSet,
  onLoadDeck,
  onReviewSoundCloud,
  footerTarget,
}: {
  detail: SoundCloudTrackDetail;
  onSaved: () => void | Promise<void>;
  /** Add the current track to the Library's active set. Undefined when no set is selected. */
  onAddToSet?: () => void;
  onLoadDeck?: (deck: "A" | "B") => void;
  onReviewSoundCloud?: () => void;
  footerTarget?: HTMLElement | null;
}) {
  const capabilities = useCapabilities();
  const [keyFormat] = usePref("keyFormat");
  const [draft, setDraft] = useState<Partial<Profile>>(detail.profile ?? {});
  const [saving, setSaving] = useState(false);
  const [newTag, setNewTag] = useState("");
  const [facetBusy, setFacetBusy] = useState(false);
  const { facets } = useFacets();
  const facetKeys = new Set(facets.map(f => f.key));
  // The page remounts on a profile switch, so reading the pref here is enough.
  const therapy = getPref("libraryProfile") === "therapy";
  const { play } = usePlayer();
  const artistPrefill = detail.track.artist_prefill;
  const artistConfidence = ARTIST_CONFIDENCE.get(artistPrefill?.confidence_label ?? "");
  const bpm = effectiveBpm(detail.track);
  const tempoSource = bpmSource(detail.track);
  const axes = numFields();
  const secondaryAxes = axes.slice(4);
  const lastPlayedAt = detail.track.last_played_at;
  const playCount = detail.track.play_count;
  const tagCount = detail.tags.length;

  useEffect(() => {
    setDraft(detail.profile ?? {});
  }, [detail.track.id]);

  const set = (patch: Partial<Profile>) => setDraft((d) => ({ ...d, ...patch }));

  async function save(patch?: Partial<Profile>): Promise<boolean> {
    setSaving(true);
    try {
      await api.updateProfile(detail.track.id, patch ?? draft);
      await onSaved();
      return true;
    } catch (error) {
      toast.error(apiMessage(error));
      return false;
    } finally {
      setSaving(false);
    }
  }

  async function quickStatus(status: string) {
    // In therapy a DJ weapon reads as approved; clicking that chip would erase the weapon.
    if (writesOnlyShownStatus(draft.personal_status, status)) return;
    set({ personal_status: status });
    await save({ personal_status: status });
  }

  async function toggleFacet(_facet: Facet, value: FacetValue, next: boolean) {
    setFacetBusy(true);
    try {
      await api.batchEdit({ track_ids: [detail.track.id], ...(next ? { add_tag_ids: [value.id] } : { remove_tag_ids: [value.id] }) });
      notifyFacetsChanged();
      await onSaved();
    } catch (error) {
      toast.error(apiMessage(error));
    } finally {
      setFacetBusy(false);
    }
  }

  async function acceptPrefill(patch: Partial<Profile>, label: string) {
    await api.acceptArtistPrefill(detail.track.id, patch);
    toast.success(`Εφαρμόστηκε: ${label}`);
    onSaved();
  }

  const substyleOptions = draft.psy_substyle && !SUBSTYLES.includes(draft.psy_substyle)
    ? [draft.psy_substyle, ...SUBSTYLES]
    : SUBSTYLES;

  const transitionSummary = [valueLabel(draft.set_role), valueLabel(draft.psy_substyle)].filter(Boolean).join(" · ");

  function renderAxis(field: NumField) {
    const value = draft[field.key] as number | undefined;
    return (
      <div key={field.key} className="min-w-0">
        <div className="flex items-baseline justify-between gap-1.5">
          <span className="min-w-0 wrap-anywhere text-xs text-cm-muted">{field.label}</span>
          <span className="font-mono text-xs tabular-nums text-cm-text">{value ?? "—"}</span>
        </div>
        <Slider
          aria-label={field.label}
          className="mt-2"
          min={field.min ?? 0}
          max={field.max}
          step={1}
          value={[value ?? field.min ?? 0]}
          onValueChange={([next]) => set({ [field.key]: next } as Partial<Profile>)}
        />
      </div>
    );
  }

  const saveAction = (
    <SpecularButton
      size="lg"
      onClick={async () => {
        if (await save()) toast.success("Το προφίλ αποθηκεύτηκε");
      }}
      disabled={saving}
      className="w-full min-w-0 cursor-pointer gap-2 font-semibold disabled:cursor-not-allowed"
    >
      {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />}
      {saving ? "Αποθήκευση…" : "Αποθήκευση προφίλ"}
    </SpecularButton>
  );

  return (
    <div className="min-w-0 space-y-3 pb-3 text-sm">
      <GlassPanel strong className="min-w-0 p-3">
        <div className="grid grid-cols-[5.5rem_minmax(0,1fr)] items-center gap-2.5">
          <div className="relative grid size-[5.5rem] place-items-center">
            <Orbit seed={detail.track.id} />
            <Artwork
              seed={detail.track.id}
              trackId={detail.track.id}
              circle
              className="relative size-[4.5rem] rounded-full object-cover shadow-lg ring-2 ring-cm-contrast/15"
            />
          </div>
          <div className="min-w-0 wrap-anywhere">
            <h2 className="text-base leading-tight font-semibold text-cm-text">
              {detail.track.title || detail.track.file_name}
            </h2>
            <p className="mt-1 text-sm leading-snug text-cm-muted">
              {detail.track.artist || "Άγνωστος καλλιτέχνης"}
            </p>
          </div>
        </div>

        <div className="mt-2.5 flex flex-wrap items-center gap-1.5 font-mono text-xs">
          <span
            className="rounded-md border border-cm-contrast/10 bg-cm-contrast/5 px-2 py-0.5 text-cm-muted"
            style={{ color: bpmColor(bpm) }}
            title={bpmDescription(detail.track)}
          >
            {bpm != null ? `${bpm.toFixed(0)} BPM` : "χωρίς BPM"}
          </span>
          <BpmOctaveButtons track={detail.track} />
          <span
            className="min-w-0 max-w-full wrap-anywhere rounded-md border border-cm-contrast/10 bg-cm-contrast/5 px-2 py-0.5 text-cm-muted"
            style={{ color: keyColor(detail.track.key_text, detail.track.key_analyzed) }}
            title={
              detail.track.key_text
                ? "Key από tag αρχείου"
                : detail.track.key_analyzed
                  ? `Ανάλυση ήχου${detail.track.key_analyzed_confidence ? ` · ${Math.round(detail.track.key_analyzed_confidence * 100)}% εμπιστοσύνη` : ""}`
                  : undefined
            }
          >
            {formatKey(detail.track.key_text, detail.track.key_analyzed, keyFormat)}
          </span>
          <span className="min-w-0 max-w-full wrap-anywhere rounded-md border border-cm-contrast/10 bg-cm-contrast/5 px-2 py-0.5 text-cm-muted">
            {detail.track.genre || "χωρίς είδος"}
          </span>
        </div>

        {/* Provenance indicator when BPM or Key originates from algorithmic audio analysis */}
        {((tempoSource != null && tempoSource !== "metadata") ||
          (!detail.track.key_text && detail.track.key_analyzed)) && (
          <div className="mt-1.5 flex items-center gap-1.5 text-[11px] text-cm-faint">
            <span className="inline-block size-1.5 shrink-0 rounded-full bg-cm-cyan/70" />
            <span>
              Προέλευση: <span className="text-cm-text">{tempoSource && tempoSource !== "metadata" && tempoSource !== "local" ? bpmDescription(detail.track) : "Ανάλυση ήχου"}</span>
              {tempoSource === "local" && detail.track.bpm_analyzed_confidence
                ? ` (${Math.round(detail.track.bpm_analyzed_confidence * 100)}% βεβαιότητα)`
                : ""}
            </span>
          </div>
        )}

        <div className="mt-3 grid grid-cols-2 gap-1.5">
          <Button type="button" size="sm" variant="soft" onClick={() => play(detail.track)} title="Άκου αυτό το track στο player">
            <Play />
            Ακρόαση
          </Button>
          <Button
            type="button"
            size="sm"
            variant="outline"
            onClick={onAddToSet}
            disabled={!onAddToSet}
            className="disabled:pointer-events-auto disabled:cursor-not-allowed"
            title={onAddToSet ? "Πρόσθεσε στο ενεργό set" : "Διάλεξε set στη βιβλιοθήκη πρώτα"}
          >
            <Plus />
            Set
          </Button>
          {onLoadDeck && (
            <>
              <Button type="button" size="sm" variant="outline" onClick={() => onLoadDeck("A")}>→ Deck A</Button>
              <Button type="button" size="sm" variant="outline" onClick={() => onLoadDeck("B")}>→ Deck B</Button>
            </>
          )}
        </div>
        <div className="mt-3 space-y-2.5 border-t border-cm-border pt-3">
          {detail.canonical && <CanonicalTrackCard value={detail.canonical} soundcloud={detail.soundcloud} />}
          <SoundCloudCard
            embedded
            soundcloud={detail.soundcloud}
            candidates={detail.soundcloud_candidates}
            fallbackSeed={detail.track.id}
            onReview={hasProviderWorkflows(capabilities) ? onReviewSoundCloud : undefined}
          />
          <details className="group/file text-xs text-cm-muted">
            <summary className="flex cursor-pointer list-none items-center gap-1.5 rounded-md py-1 transition-colors hover:text-cm-text focus-visible:outline-2 focus-visible:outline-cm-cyan [&::-webkit-details-marker]:hidden">
              <ChevronRight aria-hidden="true" className="size-3.5 transition-transform duration-150 group-open/file:rotate-90 motion-reduce:transition-none" />
              Στοιχεία αρχείου
            </summary>
            <dl className="mt-2 space-y-1 wrap-anywhere">
              <div>
                <dt className="text-cm-faint">Όνομα αρχείου</dt>
                <dd>{detail.track.file_name}</dd>
              </div>
              {detail.track.original_title && (
                <div>
                  <dt className="text-cm-faint">Αρχικός τίτλος</dt>
                  <dd>{detail.track.original_title}</dd>
                </div>
              )}
              {detail.track.original_artist && (
                <div>
                  <dt className="text-cm-faint">Αρχικός καλλιτέχνης</dt>
                  <dd>{detail.track.original_artist}</dd>
                </div>
              )}
            </dl>
            {capabilities.native_dialogs && <Button variant="outline" size="sm" className="mt-3 w-full" onClick={() => {
              void nativeAction("reveal_path", { track_id: detail.track.id }).catch(error => toast.error((error as Error).message));
            }}>Εμφάνιση στον φάκελο</Button>}
          </details>
        </div>
      </GlassPanel>



      <GlassPanel className="min-w-0 space-y-3 p-3">
        <div>
          <SectionHeader className="mb-2">Αξιολόγηση κομματιού</SectionHeader>
          <fieldset>
            <legend className="mb-1.5 text-xs text-cm-muted">Κατάσταση</legend>
            <div className="flex flex-wrap gap-1.5">
              {statusValues().map((s) => (
                <SmartChip
                  key={s}
                  tone={STATUS_TONE[s] ?? "muted"}
                  active={editorStatus(draft.personal_status) === s}
                  pressed={editorStatus(draft.personal_status) === s}
                  onClick={() => quickStatus(s)}
                >
                  {statusLabel(s)}
                </SmartChip>
              ))}
            </div>
          </fieldset>
          <div className="mt-3 grid grid-cols-2 gap-x-4 gap-y-3">
            {axes.slice(0, 4).map(renderAxis)}
          </div>
        </div>
        <TrackNotes track={detail.track} notes={draft.notes ?? ""} onChange={(notes) => set({ notes })} />
      </GlassPanel>

      <GlassPanel className="min-w-0 divide-y divide-cm-line/15">
        {secondaryAxes.length > 0 && (
          <InspectorSection title="Λεπτομέρειες αξιολόγησης" description={secondaryAxes.map((field) => field.label).join(" · ")}>
            <div className="grid grid-cols-2 gap-x-4 gap-y-3">
              {secondaryAxes.map(renderAxis)}
            </div>
          </InspectorSection>
        )}

        {artistPrefill && (
          <InspectorSection title="Προτάσεις από τον καλλιτέχνη" description={artistPrefill.canonical_name}>
            <div className="space-y-3">
              <div className="flex flex-wrap gap-1.5">
                {artistPrefill.scene_cluster && <SmartChip tone="violet" className="max-w-full whitespace-normal wrap-anywhere">{valueLabel(artistPrefill.scene_cluster)}</SmartChip>}
                {artistPrefill.primary_subgenre && <SmartChip tone="cyan" className="max-w-full whitespace-normal wrap-anywhere">{valueLabel(artistPrefill.primary_subgenre)}</SmartChip>}
                {artistConfidence && <SmartChip tone="muted">{artistConfidence}</SmartChip>}
                {artistPrefill.needs_review && <SmartChip tone="amber">Προς έλεγχο</SmartChip>}
                {artistPrefill.bpm_conflict && <SmartChip tone="rose">Απόκλιση BPM</SmartChip>}
              </div>
              <div className="grid grid-cols-2 gap-2 [&>button]:h-auto [&>button]:min-h-8 [&>button]:min-w-0 [&>button]:whitespace-normal [&>button]:text-center [&>button]:wrap-anywhere">
                {!therapy && artistPrefill.primary_subgenre && (
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={draft.psy_substyle === artistPrefill.primary_subgenre}
                    onClick={() => acceptPrefill({ psy_substyle: artistPrefill.primary_subgenre, human_confirmed: true }, "υποείδος")}
                  >
                    {draft.psy_substyle === artistPrefill.primary_subgenre ? "Υποείδος σε χρήση" : "Εφαρμογή υποείδους"}
                  </Button>
                )}
                {prefillEnergy(artistPrefill) != null && (
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={draft.energy === prefillEnergy(artistPrefill)}
                    onClick={() => acceptPrefill({ energy: prefillEnergy(artistPrefill) ?? undefined, human_confirmed: true }, fieldLabel("energy"))}
                  >
                    {draft.energy === prefillEnergy(artistPrefill) ? `${axisLabel("energy")} OK` : therapy ? "Εφαρμογή διέγερσης" : "Εφαρμογή ενέργειας"}
                  </Button>
                )}
                {!therapy && prefillRole(artistPrefill) && (
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={draft.set_role === prefillRole(artistPrefill)}
                    onClick={() => acceptPrefill({ set_role: prefillRole(artistPrefill) ?? undefined, human_confirmed: true }, "ρόλος")}
                  >
                    {draft.set_role === prefillRole(artistPrefill) ? "Ρόλος σε χρήση" : "Εφαρμογή ρόλου"}
                  </Button>
                )}
                {artistPrefill.notes && (
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={draft.notes === artistPrefill.notes}
                    onClick={() => acceptPrefill({ notes: artistPrefill.notes, human_confirmed: true }, "σημείωση")}
                  >
                    {draft.notes === artistPrefill.notes ? "Σημείωση σε χρήση" : "Εφαρμογή σημείωσης"}
                  </Button>
                )}
              </div>
            </div>
          </InspectorSection>
        )}

        {/* TRANSITION PROFILE — selects + cut/dramatic toggles (DJ only) */}
        {!therapy && <InspectorSection title="Προφίλ μετάβασης" description={transitionSummary || "Ρόλος, υποείδος και ανοχή BPM"}>
          <div className="grid grid-cols-2 items-end gap-3">
            <ProfileSelect
              label="Ρόλος στο set"
              value={draft.set_role ?? ""}
              options={SET_ROLES}
              onChange={(v) => set({ set_role: v })}
            />
            <ProfileSelect
              label="Υποείδος psy"
              value={draft.psy_substyle ?? ""}
              options={substyleOptions}
              info={SUBSTYLE_INFO}
              onChange={(v) => set({ psy_substyle: v })}
            />
            <ProfileSelect
              label="Διάλειμμα"
              value={draft.breakdown_profile ?? ""}
              options={BREAKDOWNS}
              onChange={(v) => set({ breakdown_profile: v })}
            />
            <ProfileSelect
              label="Ανοχή σε άλμα BPM"
              value={draft.bpm_jump_tolerance ?? ""}
              options={TOLERANCES}
              onChange={(v) => set({ bpm_jump_tolerance: v })}
            />
          </div>

          <div className="mt-4 space-y-2.5">
            {BOOL_FIELDS.map((b) => (
              <label
                key={b.key}
                className="flex cursor-pointer items-center justify-between gap-3"
              >
                <span className="text-xs text-cm-muted">{b.label}</span>
                <Switch
                  checked={Boolean(draft[b.key])}
                  onCheckedChange={(c) => set({ [b.key]: c } as Partial<Profile>)}
                />
              </label>
            ))}
          </div>
        </InspectorSection>}

        {/* MEMORY — play history + log a play */}
        <InspectorSection
          title="Ιστορικό αναπαραγωγής"
          description={playCount === 0 ? "Χωρίς καταγεγραμμένες αναπαραγωγές" : `${countFormat.format(playCount)} ${playCount === 1 ? "αναπαραγωγή" : "αναπαραγωγές"}`}
        >
          <div className="space-y-2">
            {lastPlayedAt && (
              <p className="flex items-center gap-1.5 text-xs text-cm-muted">
                <Clock aria-hidden="true" className="size-3 shrink-0" />
                Τελευταία αναπαραγωγή {lastPlayedAt.slice(0, 10)}
              </p>
            )}
            <button
              onClick={async () => {
                await api.logPlay(detail.track.id);
                await onSaved();
                toast.success("Καταγράφηκε η αναπαραγωγή");
              }}
              className="flex max-w-full cursor-pointer items-center gap-1.5 rounded-xl border border-cm-chartreuse/25 bg-cm-chartreuse/12 px-3 py-2 text-xs font-medium text-cm-chartreuse transition hover:border-cm-chartreuse/40 hover:bg-cm-chartreuse/20"
            >
              <CheckCircle2 className="size-3.5 shrink-0" />
              Καταγραφή αναπαραγωγής
            </button>
          </div>
        </InspectorSection>

        {/* TAGS — chips + add input */}
        <InspectorSection title="Tags και λεξιλόγια" description={tagCount > 0 ? `${countFormat.format(tagCount)} ${tagCount === 1 ? "tag" : "tags"}` : "Χωρίς tags"}>
          {facets.length > 0 && (
            <div className="mb-3 wrap-anywhere border-b border-cm-line/15 pb-3 [&_button]:max-w-full [&_button]:wrap-anywhere">
              <FacetEditor
                facets={facets}
                selected={new Set(detail.tags.map(t => t.id))}
                onToggle={(facet, value, next) => void toggleFacet(facet, value, next)}
                disabled={facetBusy}
              />
            </div>
          )}
          <div className="flex flex-wrap items-center gap-1.5">
            {detail.tags.filter(t => !t.category || !facetKeys.has(t.category)).map((t) => (
              <Badge
                key={t.id}
                variant="outline"
                className="max-w-full min-w-0 gap-1 border-cm-contrast/10 bg-cm-contrast/5 px-2.5 py-1 text-xs font-normal whitespace-normal text-cm-text"
              >
                <span className="min-w-0 wrap-anywhere">{tagDisplayName(t)}</span>
                <button
                  className="shrink-0 cursor-pointer text-cm-faint transition hover:text-cm-rose"
                  title="Αφαίρεση tag"
                  aria-label={`Αφαίρεση tag ${tagDisplayName(t)}`}
                  onClick={async () => {
                    try {
                      await api.removeTag(detail.track.id, t.id);
                    } catch (error) {
                      toast.error(apiMessage(error));
                      return;
                    }
                    await onSaved();
                  }}
                >
                  <X className="h-3 w-3" />
                </button>
              </Badge>
            ))}
            <div className="inline-flex items-center gap-1 rounded-full border surface-field px-2 py-1 transition focus-within:border-cm-cyan/40">
              <Plus className="h-3 w-3 text-cm-faint" />
              <input
                value={newTag}
                onChange={(e) => setNewTag(e.target.value)}
                onKeyDown={async (e) => {
                  if (e.key === "Enter" && newTag.trim()) {
                    try {
                      await api.assignTag(detail.track.id, newTag.trim());
                    } catch (error) {
                      toast.error(apiMessage(error));
                      return;
                    }
                    setNewTag("");
                    await onSaved();
                  }
                }}
                placeholder="tag"
                aria-label="Προσθήκη tag"
                className="w-20 bg-transparent text-xs text-cm-text outline-none placeholder:text-cm-faint"
              />
            </div>
          </div>
        </InspectorSection>

      </GlassPanel>

      {footerTarget ? createPortal(saveAction, footerTarget) : <div className="pt-1">{saveAction}</div>}
    </div>
  );
}

export function ProfileSelect({
  label,
  value,
  options,
  onChange,
  info,
  format = valueLabel,
}: {
  label: string;
  value: string;
  options: string[];
  onChange: (v: string) => void;
  /** Option text; defaults to valueLabel. */
  format?: (v: string) => string;
  /** Optional per-option BPM range + description, listed in an (i) tooltip next to the label. */
  info?: Record<string, { bpm: string; description: string }>;
}) {
  return (
    <label className="block min-w-0">
      <div className="mb-1 flex items-center gap-1 text-[11px] font-medium uppercase tracking-wider text-cm-faint">
        <span className="min-w-0 wrap-anywhere">{label}</span>
        {info && (
          <Tooltip>
            <TooltipTrigger asChild>
              <span tabIndex={0} role="img" aria-label={`${label}: BPM και περιγραφές`} className="inline-flex cursor-help text-cm-faint hover:text-cm-text">
                <Info className="h-3 w-3" />
              </span>
            </TooltipTrigger>
            <TooltipContent side="right" className="max-w-sm text-left normal-case tracking-normal">
              <ul className="space-y-1.5 py-0.5">
                {Object.entries(info).map(([key, item]) => (
                  <li key={key} className={cn(key === value && "font-semibold")}>
                    <div>{valueLabel(key)} <span className="font-mono opacity-70">· {item.bpm} BPM</span></div>
                    <div className="opacity-80">{item.description}</div>
                  </li>
                ))}
              </ul>
            </TooltipContent>
          </Tooltip>
        )}
      </div>
      <Select value={value} onValueChange={onChange}>
        <SelectTrigger className="w-full min-w-0 text-sm text-cm-text focus-visible:border-cm-cyan/40 focus-visible:ring-cm-cyan/30 [&>[data-slot=select-value]]:min-w-0">
          <SelectValue placeholder="—" />
        </SelectTrigger>
        <SelectContent>
          {options.map((o) => (
            <SelectItem
              key={o}
              value={o}
              leading={info?.[o] && (
                <Tooltip>
                  <TooltipTrigger asChild>
                    <span role="img" aria-label={`${valueLabel(o)}: ${info[o].bpm} BPM. ${info[o].description}`} className="inline-flex cursor-help text-cm-faint hover:text-cm-text">
                      <Info className="h-3 w-3" />
                    </span>
                  </TooltipTrigger>
                  <TooltipContent side="right" className="max-w-xs text-left">
                    <div className="font-semibold">{valueLabel(o)} <span className="font-mono font-normal opacity-70">· {info[o].bpm} BPM</span></div>
                    <div className="opacity-80">{info[o].description}</div>
                  </TooltipContent>
                </Tooltip>
              )}
            >
              {format(o)}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </label>
  );
}

/**
 * Cosmetic orbit/radar halo behind the header artwork. CrateMind stores no real
 * visualisation data, so this is purely decorative — deterministic ring/dot
 * placement keyed on the track id, aria-hidden, and motion-gated (the slow spin
 * is disabled under prefers-reduced-motion; dots only pulse when motion is safe).
 */
function Orbit({ seed }: { seed: number }) {
  const rings = [
    { rx: 96, ry: 58, cls: "text-cm-cyan/35" },
    { rx: 60, ry: 98, cls: "text-cm-violet/30" },
    { rx: 104, ry: 76, cls: "text-cm-blue/35" },
  ];
  const dots = rings.map((ring, i) => {
    const a = (((seed * 53 + i * 131) % 360) * Math.PI) / 180;
    return {
      x: 110 + ring.rx * Math.cos(a),
      y: 110 + ring.ry * Math.sin(a),
      r: 3.5 - i * 0.5,
      cls: ring.cls,
    };
  });
  return (
    <div className="pointer-events-none absolute inset-0 grid place-items-center" aria-hidden>
      <svg viewBox="0 0 220 220" className="h-full w-full">
        <g
          className="animate-spin [animation-duration:52s] motion-reduce:animate-none"
          style={{ transformOrigin: "110px 110px" }}
        >
          {rings.map((r, i) => (
            <ellipse
              key={i}
              cx="110"
              cy="110"
              rx={r.rx}
              ry={r.ry}
              fill="none"
              stroke="currentColor"
              strokeWidth="0.8"
              className={r.cls}
            />
          ))}
          {dots.map((d, i) => (
            <circle
              key={i}
              cx={d.x}
              cy={d.y}
              r={d.r}
              fill="currentColor"
              className={cn(d.cls, "motion-safe:animate-pulse")}
            />
          ))}
        </g>
      </svg>
    </div>
  );
}

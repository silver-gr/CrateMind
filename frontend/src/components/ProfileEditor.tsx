import { useEffect, useState } from "react";
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
import { numFields } from "../lib/profileFields";
import { getPref } from "../lib/prefs";
import { FacetEditor } from "./FacetEditor";
import { Artwork } from "./ui/Artwork";
import { GlassPanel } from "./ui/GlassPanel";
import { SectionHeader } from "./ui/SectionHeader";
import { SmartChip } from "./ui/SmartChip";
import { StatusBadge } from "./ui/StatusBadge";
import { SoundCloudCard } from "./SoundCloudCard";
import { Tooltip, TooltipContent, TooltipTrigger } from "./ui/tooltip";
import { Info } from "../lib/icons";
import { usePref } from "../lib/prefs";
import { formatKey, keyColor } from "../lib/camelot";
import { bpmColor } from "../lib/bpmColor";
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
import { Textarea } from "@/components/ui/textarea";
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
  onReviewSoundCloud,
}: {
  detail: SoundCloudTrackDetail;
  onSaved: () => void | Promise<void>;
  /** Add the current track to the Library's active set. Undefined when no set is selected. */
  onAddToSet?: () => void;
  onReviewSoundCloud?: () => void;
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
  const bpm = effectiveBpm(detail.track);
  const tempoSource = bpmSource(detail.track);

  useEffect(() => {
    setDraft(detail.profile ?? {});
  }, [detail.track.id]);

  const set = (patch: Partial<Profile>) => setDraft((d) => ({ ...d, ...patch }));

  async function save(patch?: Partial<Profile>) {
    setSaving(true);
    try {
      await api.updateProfile(detail.track.id, patch ?? draft);
      await onSaved();
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

  return (
    <div className="space-y-4 text-sm">
      {/* HEADER — orbit/artwork hero + identity + quick facts + audition + add-to-set */}
      <GlassPanel strong className="p-4">
        <div className="relative mx-auto grid h-[220px] w-[220px] place-items-center">
          <Orbit seed={detail.track.id} />
          <Artwork
            seed={detail.track.id}
            trackId={detail.track.id}
            circle
            className="relative h-[150px] w-[150px] rounded-full ring-2 ring-white/15 shadow-2xl shadow-black/50 object-cover"
          />
        </div>

        <div className="mt-3 text-center">
          <div className="flex items-center justify-center gap-2">
            <h2 className="truncate text-base font-semibold text-cm-text">
              {detail.track.title || detail.track.file_name}
            </h2>
            <StatusBadge status={draft.personal_status} />
          </div>
          <div className="mt-0.5 truncate text-sm text-cm-muted">
            {detail.track.artist || "Άγνωστος καλλιτέχνης"}
          </div>
          <div
            className="mt-1 truncate font-mono text-[11px] text-cm-faint"
            title={detail.track.file_name}
          >
            {detail.track.file_name}
          </div>
        </div>

        <div className="mt-3 flex flex-wrap items-center justify-center gap-1.5 font-mono text-xs">
          <span
            className="rounded-md border border-white/10 bg-white/5 px-2 py-0.5 text-cm-muted"
            style={{ color: bpmColor(bpm) }}
            title={bpmDescription(detail.track)}
          >
            {bpm != null ? `${bpm.toFixed(0)} BPM` : "χωρίς BPM"}
          </span>
          <span
            className="rounded-md border border-white/10 bg-white/5 px-2 py-0.5 text-cm-muted"
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
          <span className="rounded-md border border-white/10 bg-white/5 px-2 py-0.5 text-cm-muted">
            {detail.track.genre || "χωρίς genre"}
          </span>
        </div>

        {/* Provenance indicator when BPM or Key originates from algorithmic audio analysis */}
        {((tempoSource != null && tempoSource !== "metadata") ||
          (!detail.track.key_text && detail.track.key_analyzed)) && (
          <div className="mt-1.5 flex items-center justify-center gap-1.5 text-[11px] text-cm-faint">
            <span className="inline-block h-1.5 w-1.5 rounded-full bg-cm-cyan/70" />
            <span>
              Προέλευση: <span className="text-cm-text">{tempoSource && tempoSource !== "metadata" && tempoSource !== "local" ? bpmDescription(detail.track) : "Ανάλυση ήχου"}</span>
              {tempoSource === "local" && detail.track.bpm_analyzed_confidence
                ? ` (${Math.round(detail.track.bpm_analyzed_confidence * 100)}% conf)`
                : ""}
            </span>
          </div>
        )}

        <div className="mt-2 text-center text-xs text-cm-muted">
          παίχτηκε {detail.track.play_count}×
          {detail.track.last_played_at
            ? ` · τελευταία φορά ${detail.track.last_played_at.slice(0, 10)}`
            : " · δεν παίχτηκε ποτέ"}
        </div>

        <div className="mt-3 flex items-center gap-2">
          <button
            onClick={() => play(detail.track)}
            title="Άκου αυτό το track στο player"
            className="flex flex-1 cursor-pointer items-center justify-center gap-1.5 rounded-xl border border-cm-cyan/25 bg-cm-cyan/12 px-3 py-2 text-xs font-medium text-cm-cyan transition hover:border-cm-cyan/40 hover:bg-cm-cyan/20"
          >
            <Play className="h-3.5 w-3.5" />
            Ακρόαση
          </button>
          <button
            onClick={onAddToSet}
            disabled={!onAddToSet}
            title={onAddToSet ? "Πρόσθεσε στο ενεργό set" : "Διάλεξε set στη βιβλιοθήκη πρώτα"}
            className="flex flex-1 cursor-pointer items-center justify-center gap-1.5 rounded-xl border border-white/10 bg-white/5 px-3 py-2 text-xs font-medium text-cm-text transition hover:border-cm-cyan/40 hover:bg-cm-cyan/10 disabled:cursor-not-allowed disabled:opacity-40"
          >
            <Plus className="h-3.5 w-3.5" />
            Set
          </button>
        </div>
        <div className="mt-4 border-t border-cm-line/20 pt-4">
          {capabilities.native_dialogs && <Button variant="outline" size="sm" className="mb-3 w-full" onClick={() => {
            void nativeAction("reveal_path", { track_id: detail.track.id }).catch(error => toast.error((error as Error).message));
          }}>Εμφάνιση στον φάκελο</Button>}
          <SoundCloudCard
            embedded
            soundcloud={detail.soundcloud}
            candidates={detail.soundcloud_candidates}
            fallbackSeed={detail.track.id}
            onReview={hasProviderWorkflows(capabilities) ? onReviewSoundCloud : undefined}
          />
        </div>
      </GlassPanel>



      {/* STATUS — quick verdict chips */}
      <GlassPanel className="p-4">
        <SectionHeader>Κατάσταση</SectionHeader>
        <div className="flex flex-wrap gap-1.5">
          {statusValues().map((s) => (
            <SmartChip
              key={s}
              tone={STATUS_TONE[s] ?? "muted"}
              active={editorStatus(draft.personal_status) === s}
              onClick={() => quickStatus(s)}
            >
              {statusLabel(s)}
            </SmartChip>
          ))}
        </div>
      </GlassPanel>

      {/* TASTE PROFILE — numeric sliders */}
      <GlassPanel className="p-4">
        <SectionHeader>Προφίλ γούστου</SectionHeader>
        <div className="grid grid-cols-2 gap-x-5 gap-y-3">
          {numFields().map((f) => (
            <label key={f.key} className="block">
              <div className="flex items-baseline justify-between">
                <span className="text-xs text-cm-muted">{f.label}</span>
                <span className="font-mono text-xs tabular-nums text-cm-text">
                  {(draft[f.key] as number | undefined) ?? "—"}
                </span>
              </div>
              <Slider
                className="mt-2"
                min={0}
                max={f.max}
                step={1}
                value={[(draft[f.key] as number | undefined) ?? 0]}
                onValueChange={([v]) => set({ [f.key]: v } as Partial<Profile>)}
              />
            </label>
          ))}
        </div>
      </GlassPanel>

      {artistPrefill && (
        <GlassPanel className="p-4">
          <SectionHeader>Artist Prefill</SectionHeader>
          <div className="space-y-3">
            <div className="text-sm text-cm-text">{artistPrefill.canonical_name}</div>
            <div className="flex flex-wrap gap-1.5">
              {artistPrefill.scene_cluster && <SmartChip tone="violet">{artistPrefill.scene_cluster}</SmartChip>}
              {artistPrefill.primary_subgenre && <SmartChip tone="cyan">{artistPrefill.primary_subgenre}</SmartChip>}
              {artistPrefill.confidence_label && <SmartChip tone="chartreuse">{artistPrefill.confidence_label}</SmartChip>}
              {artistPrefill.needs_review && <SmartChip tone="amber">Θέλει έλεγχο</SmartChip>}
              {artistPrefill.bpm_conflict && <SmartChip tone="rose">BPM conflict</SmartChip>}
            </div>
            <div className="grid grid-cols-2 gap-2">
              {!therapy && artistPrefill.primary_subgenre && (
                <Button
                  variant="outline"
                  size="sm"
                  disabled={draft.psy_substyle === artistPrefill.primary_subgenre}
                  onClick={() => acceptPrefill({ psy_substyle: artistPrefill.primary_subgenre, human_confirmed: true }, "subgenre")}
                >
                  {draft.psy_substyle === artistPrefill.primary_subgenre ? "Subgenre OK" : "Εφαρμογή subgenre"}
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
                  {draft.set_role === prefillRole(artistPrefill) ? "Ρόλος OK" : "Εφαρμογή ρόλου"}
                </Button>
              )}
              {artistPrefill.notes && (
                <Button
                  variant="outline"
                  size="sm"
                  disabled={draft.notes === artistPrefill.notes}
                  onClick={() => acceptPrefill({ notes: artistPrefill.notes, human_confirmed: true }, "σημείωσης")}
                >
                  {draft.notes === artistPrefill.notes ? "Σημείωση OK" : "Εφαρμογή σημείωσης"}
                </Button>
              )}
            </div>
          </div>
        </GlassPanel>
      )}

      {/* TRANSITION PROFILE — selects + cut/dramatic toggles (DJ only) */}
      {!therapy && <GlassPanel className="p-4">
        <SectionHeader>Προφίλ μετάβασης</SectionHeader>
        <div className="grid grid-cols-2 gap-3">
          <ProfileSelect
            label="Ρόλος στο set"
            value={draft.set_role ?? ""}
            options={SET_ROLES}
            onChange={(v) => set({ set_role: v })}
          />
          <ProfileSelect
            label="Psy substyle"
            value={draft.psy_substyle ?? ""}
            options={substyleOptions}
            info={SUBSTYLE_INFO}
            onChange={(v) => set({ psy_substyle: v })}
          />
          <ProfileSelect
            label="Breakdown"
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
      </GlassPanel>}

      {/* VOCABULARIES — one chip row per facet; writes go through the bulk endpoint */}
      {facets.length > 0 && (
        <GlassPanel className="p-4">
          <SectionHeader>Λεξιλόγια</SectionHeader>
          <FacetEditor
            facets={facets}
            selected={new Set(detail.tags.map(t => t.id))}
            onToggle={(facet, value, next) => void toggleFacet(facet, value, next)}
            disabled={facetBusy}
          />
        </GlassPanel>
      )}

      {/* MEMORY — play history + log a play */}
      <GlassPanel className="p-4">
        <SectionHeader>Μνήμη</SectionHeader>
        <div className="flex items-center justify-between gap-3">
          <div className="space-y-0.5">
            <div className="font-mono text-sm tabular-nums text-cm-text">
              {detail.track.play_count}× <span className="text-cm-muted">παιγμένο</span>
            </div>
            <div className="flex items-center gap-1.5 text-xs text-cm-faint">
              <Clock className="h-3 w-3" />
              {detail.track.last_played_at
                ? `τελευταία φορά ${detail.track.last_played_at.slice(0, 10)}`
                : "δεν παίχτηκε ποτέ"}
            </div>
          </div>
          <button
            onClick={async () => {
              await api.logPlay(detail.track.id);
              await onSaved();
              toast.success("Καταγράφηκε play");
            }}
            title="Καταγραφή play — ενημερώνει τα φίλτρα για πρόσφατα plays"
            className="flex shrink-0 cursor-pointer items-center gap-1.5 rounded-xl border border-cm-chartreuse/25 bg-cm-chartreuse/12 px-3 py-2 text-xs font-medium text-cm-chartreuse transition hover:border-cm-chartreuse/40 hover:bg-cm-chartreuse/20"
          >
            <CheckCircle2 className="h-3.5 w-3.5" />
            παίχτηκε
          </button>
        </div>
      </GlassPanel>

      {/* NOTES — private notebook */}
      <GlassPanel className="p-4">
        <SectionHeader>Σημειώσεις</SectionHeader>
        <Textarea
          value={draft.notes ?? ""}
          onChange={(e) => set({ notes: e.target.value })}
          rows={4}
          placeholder="Τι δουλεύει σε αυτό το track… cue points, σημειώσεις crowd, προειδοποιήσεις"
          className="resize-none text-sm leading-relaxed text-cm-text placeholder:text-cm-faint focus-visible:border-cm-cyan/40 focus-visible:ring-cm-cyan/20"
        />
      </GlassPanel>

      {/* TAGS — chips + add input */}
      <GlassPanel className="p-4">
        <SectionHeader>Tags</SectionHeader>
        <div className="flex flex-wrap items-center gap-1.5">
          {detail.tags.filter(t => !t.category || !facetKeys.has(t.category)).map((t) => (
            <Badge
              key={t.id}
              variant="outline"
              className="gap-1 border-white/10 bg-white/5 px-2.5 py-1 text-xs font-normal text-cm-text"
            >
              {tagDisplayName(t)}
              <button
                className="cursor-pointer text-cm-faint transition hover:text-cm-rose"
                title="Αφαίρεση tag"
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
              className="w-20 bg-transparent text-xs text-cm-text outline-none placeholder:text-cm-faint"
            />
          </div>
        </div>
      </GlassPanel>

      {/* FOOTER — primary save */}
      <div className="flex gap-2 pt-1">
        <SpecularButton
          size="lg"
          onClick={async () => {
            await save();
            toast.success("Το προφίλ αποθηκεύτηκε");
          }}
          disabled={saving}
          className="flex-1 cursor-pointer gap-2 font-semibold disabled:cursor-not-allowed"
        >
          {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />}
          {saving ? "Αποθήκευση…" : "Αποθήκευση προφίλ"}
        </SpecularButton>
      </div>
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
    <label className="block">
      <div className="mb-1 flex items-center gap-1 text-[11px] font-medium uppercase tracking-wider text-cm-faint">
        {label}
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
        <SelectTrigger className="w-full text-sm text-cm-text focus-visible:border-cm-cyan/40 focus-visible:ring-cm-cyan/30">
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

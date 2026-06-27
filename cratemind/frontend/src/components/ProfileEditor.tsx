import { useEffect, useState } from "react";
import { toast } from "sonner";
import { api } from "../lib/api";
import { usePlayer } from "../lib/player";
import { SET_ROLES, STATUS_VALUES } from "../lib/types";
import type { Profile, TrackDetail } from "../lib/types";
import type { ChipTone } from "../lib/queryChips";
import { statusLabel, valueLabel } from "../lib/labels";
import { GlassPanel } from "./ui/GlassPanel";
import { SectionHeader } from "./ui/SectionHeader";
import { SmartChip } from "./ui/SmartChip";
import { StatusBadge } from "./ui/StatusBadge";
import {
  Play,
  Flame,
  ArrowRight,
  Split,
  CheckCircle2,
  Save,
  Loader2,
  X,
  Plus,
  Clock,
  Music2,
} from "../lib/icons";

const NUM_FIELDS: { key: keyof Profile; label: string; max: number }[] = [
  { key: "energy", label: "Ενέργεια", max: 10 },
  { key: "intensity", label: "Ένταση", max: 10 },
  { key: "darkness", label: "Σκοτεινότητα", max: 10 },
  { key: "melody", label: "Μελωδία", max: 10 },
  { key: "weirdness", label: "Ιδιορρυθμία", max: 10 },
  { key: "chaos_level", label: "Χάος", max: 10 },
  { key: "mixability", label: "Mixability", max: 5 },
  { key: "confidence", label: "Σιγουριά", max: 5 },
];

const SUBSTYLES = [
  "prog-psy", "full-on", "forest", "darkpsy", "hi-tech", "psycore", "suomi", "zenonesque",
];

const BREAKDOWNS = [
  "no break", "short break", "long melodic break", "fakeout", "cinematic",
];

const TOLERANCES = [
  "native", "can_push_up", "can_push_down", "do_not_warp", "huge",
];

const BOOL_FIELDS: { key: keyof Profile; label: string }[] = [
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

export default function ProfileEditor({
  detail,
  onSaved,
}: {
  detail: TrackDetail;
  onSaved: () => void;
}) {
  const [draft, setDraft] = useState<Partial<Profile>>(detail.profile ?? {});
  const [saving, setSaving] = useState(false);
  const [newTag, setNewTag] = useState("");
  const { play } = usePlayer();

  useEffect(() => {
    setDraft(detail.profile ?? {});
  }, [detail.track.id]);

  const set = (patch: Partial<Profile>) => setDraft((d) => ({ ...d, ...patch }));

  async function save(patch?: Partial<Profile>) {
    setSaving(true);
    try {
      await api.updateProfile(detail.track.id, patch ?? draft);
      onSaved();
    } finally {
      setSaving(false);
    }
  }

  async function quickStatus(status: string) {
    set({ personal_status: status });
    await save({ personal_status: status });
  }

  return (
    <div className="space-y-4 text-sm">
      {/* HEADER — track identity + quick facts + audition */}
      <GlassPanel strong className="p-4">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <Music2 className="h-4 w-4 shrink-0 text-cm-cyan" />
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
          <button
            onClick={() => play(detail.track)}
            title="Άκου αυτό το track στο player"
            className="flex shrink-0 cursor-pointer items-center gap-1.5 rounded-xl border border-cm-cyan/25 bg-cm-cyan/12 px-3 py-2 text-xs font-medium text-cm-cyan transition hover:border-cm-cyan/40 hover:bg-cm-cyan/20"
          >
            <Play className="h-3.5 w-3.5" />
            Ακρόαση
          </button>
        </div>

        <div className="mt-3 flex flex-wrap items-center gap-1.5 font-mono text-xs">
          <span className="rounded-md border border-white/10 bg-white/5 px-2 py-0.5 text-cm-blue">
            {detail.track.bpm ? `${detail.track.bpm.toFixed(0)} BPM` : "χωρίς BPM"}
          </span>
          <span className="rounded-md border border-white/10 bg-white/5 px-2 py-0.5 text-cm-violet">
            {detail.track.key_text || "χωρίς key"}
          </span>
          <span className="rounded-md border border-white/10 bg-white/5 px-2 py-0.5 text-cm-muted">
            {detail.track.genre || "χωρίς genre"}
          </span>
        </div>

        <div className="mt-2 text-xs text-cm-muted">
          παίχτηκε {detail.track.play_count}×
          {detail.track.last_played_at
            ? ` · τελευταία φορά ${detail.track.last_played_at.slice(0, 10)}`
            : " · δεν παίχτηκε ποτέ"}
        </div>
      </GlassPanel>

      {/* STATUS — quick verdict chips */}
      <GlassPanel className="p-4">
        <SectionHeader>Κατάσταση</SectionHeader>
        <div className="flex flex-wrap gap-1.5">
          {STATUS_VALUES.map((s) => (
            <SmartChip
              key={s}
              tone={STATUS_TONE[s] ?? "muted"}
              active={draft.personal_status === s}
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
          {NUM_FIELDS.map((f) => (
            <label key={f.key} className="block">
              <div className="flex items-baseline justify-between">
                <span className="text-xs text-cm-muted">{f.label}</span>
                <span className="font-mono text-xs tabular-nums text-cm-text">
                  {(draft[f.key] as number | undefined) ?? "—"}
                </span>
              </div>
              <input
                type="range"
                min={0}
                max={f.max}
                value={(draft[f.key] as number | undefined) ?? 0}
                onChange={(e) => set({ [f.key]: Number(e.target.value) } as Partial<Profile>)}
                className="mt-1.5 w-full cursor-pointer"
              />
            </label>
          ))}
        </div>
      </GlassPanel>

      {/* TRANSITION PROFILE — selects + cut/dramatic toggles */}
      <GlassPanel className="p-4">
        <SectionHeader>Προφίλ μετάβασης</SectionHeader>
        <div className="grid grid-cols-2 gap-3">
          <Select
            label="Ρόλος στο set"
            value={draft.set_role ?? ""}
            options={SET_ROLES}
            onChange={(v) => set({ set_role: v })}
          />
          <Select
            label="Psy substyle"
            value={draft.psy_substyle ?? ""}
            options={SUBSTYLES}
            onChange={(v) => set({ psy_substyle: v })}
          />
          <Select
            label="Breakdown"
            value={draft.breakdown_profile ?? ""}
            options={BREAKDOWNS}
            onChange={(v) => set({ breakdown_profile: v })}
          />
          <Select
            label="Ανοχή σε άλμα BPM"
            value={draft.bpm_jump_tolerance ?? ""}
            options={TOLERANCES}
            onChange={(v) => set({ bpm_jump_tolerance: v })}
          />
        </div>

        <div className="mt-3 flex flex-wrap gap-1.5">
          {BOOL_FIELDS.map((b) => {
            const Icon = b.key === "dramatic_transition_candidate" ? Flame : b.key === "can_cut_into" ? ArrowRight : Split;
            const tone: ChipTone = b.key === "dramatic_transition_candidate" ? "magenta" : "cyan";
            return (
              <SmartChip
                key={b.key}
                tone={tone}
                icon={Icon}
                active={Boolean(draft[b.key])}
                onClick={() => set({ [b.key]: !draft[b.key] } as Partial<Profile>)}
              >
                {b.label}
              </SmartChip>
            );
          })}
        </div>
      </GlassPanel>

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
              onSaved();
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
        <textarea
          value={draft.notes ?? ""}
          onChange={(e) => set({ notes: e.target.value })}
          rows={4}
          placeholder="Τι δουλεύει σε αυτό το track… cue points, σημειώσεις crowd, προειδοποιήσεις"
          className="w-full resize-none rounded-xl border border-white/10 bg-cm-panel-2/60 p-3 text-sm leading-relaxed text-cm-text outline-none transition placeholder:text-cm-faint focus:border-cm-cyan/40 focus:ring-1 focus:ring-cm-cyan/20"
        />
      </GlassPanel>

      {/* TAGS — chips + add input */}
      <GlassPanel className="p-4">
        <SectionHeader>Tags</SectionHeader>
        <div className="flex flex-wrap items-center gap-1.5">
          {detail.tags.map((t) => (
            <span
              key={t.id}
              className="inline-flex items-center gap-1 rounded-full border border-white/10 bg-white/5 px-2.5 py-1 text-xs text-cm-text"
            >
              {t.name}
              <button
                className="cursor-pointer text-cm-faint transition hover:text-cm-rose"
                title="Αφαίρεση tag"
                onClick={async () => {
                  await api.removeTag(detail.track.id, t.id);
                  onSaved();
                }}
              >
                <X className="h-3 w-3" />
              </button>
            </span>
          ))}
          <div className="inline-flex items-center gap-1 rounded-full border border-white/10 bg-cm-panel-2 px-2 py-1 transition focus-within:border-cm-cyan/40">
            <Plus className="h-3 w-3 text-cm-faint" />
            <input
              value={newTag}
              onChange={(e) => setNewTag(e.target.value)}
              onKeyDown={async (e) => {
                if (e.key === "Enter" && newTag.trim()) {
                  await api.assignTag(detail.track.id, newTag.trim());
                  setNewTag("");
                  onSaved();
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
        <button
          onClick={async () => {
            await save();
            toast.success("Το προφίλ αποθηκεύτηκε");
          }}
          disabled={saving}
          className="glow-cyan flex flex-1 cursor-pointer items-center justify-center gap-2 rounded-xl bg-gradient-to-r from-cm-cyan to-cm-blue px-4 py-2.5 text-sm font-semibold text-cm-bg shadow-lg transition hover:brightness-110 disabled:cursor-not-allowed disabled:opacity-50"
        >
          {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />}
          {saving ? "Αποθήκευση…" : "Αποθήκευση προφίλ"}
        </button>
      </div>
    </div>
  );
}

function Select({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: string;
  options: string[];
  onChange: (v: string) => void;
}) {
  return (
    <label className="block">
      <div className="mb-1 text-[11px] font-medium uppercase tracking-wider text-cm-faint">{label}</div>
      <select
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="w-full cursor-pointer rounded-lg border border-white/10 bg-cm-panel-2 px-2.5 py-1.5 text-sm text-cm-text outline-none transition focus:border-cm-cyan/40 focus:ring-1 focus:ring-cm-cyan/30"
      >
        <option value="">—</option>
        {options.map((o) => (
          <option key={o} value={o}>
            {valueLabel(o)}
          </option>
        ))}
      </select>
    </label>
  );
}

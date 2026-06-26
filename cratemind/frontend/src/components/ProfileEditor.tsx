import { useEffect, useState } from "react";
import { api } from "../lib/api";
import { usePlayer } from "../lib/player";
import { SET_ROLES, STATUS_VALUES } from "../lib/types";
import type { Profile, TrackDetail } from "../lib/types";

const NUM_FIELDS: { key: keyof Profile; label: string; max: number }[] = [
  { key: "energy", label: "Energy", max: 10 },
  { key: "intensity", label: "Intensity", max: 10 },
  { key: "darkness", label: "Darkness", max: 10 },
  { key: "melody", label: "Melody", max: 10 },
  { key: "weirdness", label: "Weirdness", max: 10 },
  { key: "chaos_level", label: "Chaos", max: 10 },
  { key: "mixability", label: "Mixability", max: 5 },
  { key: "confidence", label: "Confidence", max: 5 },
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
  { key: "dramatic_transition_candidate", label: "dramatic" },
  { key: "can_cut_into", label: "can cut into" },
  { key: "can_cut_out_of", label: "can cut out of" },
];

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
      <div>
        <div className="text-base font-semibold">{detail.track.title || detail.track.file_name}</div>
        <div className="text-neutral-400">{detail.track.artist}</div>
        <div className="mt-1 text-xs text-neutral-600">
          {detail.track.bpm ? `${detail.track.bpm.toFixed(0)} BPM` : "no BPM"} ·{" "}
          {detail.track.key_text || "no key"} · {detail.track.genre || "no genre"}
        </div>
        <div className="text-xs text-neutral-600">
          played {detail.track.play_count}×
          {detail.track.last_played_at
            ? ` · last ${detail.track.last_played_at.slice(0, 10)}`
            : " · never played"}
        </div>
      </div>

      <div className="flex flex-wrap gap-1">
        {STATUS_VALUES.map((s) => (
          <button
            key={s}
            onClick={() => quickStatus(s)}
            className={`rounded px-2 py-1 text-xs ${
              draft.personal_status === s
                ? "bg-emerald-600 text-white"
                : "bg-neutral-800 text-neutral-300 hover:bg-neutral-700"
            }`}
          >
            {s}
          </button>
        ))}
      </div>

      <div className="grid grid-cols-2 gap-3">
        {NUM_FIELDS.map((f) => (
          <label key={f.key} className="block">
            <div className="flex justify-between text-xs text-neutral-400">
              <span>{f.label}</span>
              <span className="tabular-nums text-neutral-300">
                {(draft[f.key] as number | undefined) ?? "—"}
              </span>
            </div>
            <input
              type="range"
              min={0}
              max={f.max}
              value={(draft[f.key] as number | undefined) ?? 0}
              onChange={(e) => set({ [f.key]: Number(e.target.value) } as Partial<Profile>)}
              className="w-full accent-emerald-500"
            />
          </label>
        ))}
      </div>

      <div className="grid grid-cols-2 gap-3">
        <Select
          label="Set role"
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
          label="BPM jump tolerance"
          value={draft.bpm_jump_tolerance ?? ""}
          options={TOLERANCES}
          onChange={(v) => set({ bpm_jump_tolerance: v })}
        />
      </div>

      <div className="flex flex-wrap gap-3">
        {BOOL_FIELDS.map((b) => (
          <label key={b.key} className="flex items-center gap-1.5 text-xs text-neutral-300">
            <input
              type="checkbox"
              checked={Boolean(draft[b.key])}
              onChange={(e) => set({ [b.key]: e.target.checked } as Partial<Profile>)}
              className="accent-emerald-500"
            />
            {b.label}
          </label>
        ))}
      </div>

      <label className="block">
        <div className="text-xs text-neutral-400">Notes</div>
        <textarea
          value={draft.notes ?? ""}
          onChange={(e) => set({ notes: e.target.value })}
          rows={3}
          className="mt-1 w-full rounded border border-neutral-700 bg-neutral-900 p-2 text-sm"
        />
      </label>

      <div className="flex flex-wrap items-center gap-1">
        {detail.tags.map((t) => (
          <span
            key={t.id}
            className="flex items-center gap-1 rounded bg-neutral-800 px-2 py-0.5 text-xs"
          >
            {t.name}
            <button
              className="text-neutral-500 hover:text-red-400"
              onClick={async () => {
                await api.removeTag(detail.track.id, t.id);
                onSaved();
              }}
            >
              ×
            </button>
          </span>
        ))}
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
          placeholder="+ tag"
          className="w-20 rounded border border-neutral-700 bg-neutral-900 px-2 py-0.5 text-xs"
        />
      </div>

      <div className="flex gap-2">
        <button
          onClick={() => save()}
          disabled={saving}
          className="flex-1 rounded bg-emerald-700 py-2 text-sm font-medium hover:bg-emerald-600 disabled:opacity-50"
        >
          {saving ? "Saving…" : "Save profile"}
        </button>
        <button
          onClick={() => play(detail.track)}
          title="Audition this track in the player"
          className="rounded bg-neutral-800 px-3 py-2 text-sm hover:bg-emerald-700"
        >
          ▶ Audition
        </button>
        <button
          onClick={async () => {
            await api.logPlay(detail.track.id);
            onSaved();
          }}
          title="Log a play — drives the 'not recently played' filters"
          className="rounded bg-neutral-800 px-3 py-2 text-sm hover:bg-neutral-700"
        >
          ✓ played {detail.track.play_count > 0 ? `(${detail.track.play_count})` : ""}
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
      <div className="text-xs text-neutral-400">{label}</div>
      <select
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="mt-1 w-full rounded border border-neutral-700 bg-neutral-900 p-1.5 text-sm"
      >
        <option value="">—</option>
        {options.map((o) => (
          <option key={o} value={o}>
            {o}
          </option>
        ))}
      </select>
    </label>
  );
}

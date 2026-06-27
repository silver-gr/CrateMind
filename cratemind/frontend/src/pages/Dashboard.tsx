import { useCallback, useEffect, useRef, useState, type ComponentType } from "react";
import { useNavigate } from "react-router-dom";
import { toast } from "sonner";
import gsap from "gsap";
import { useGSAP } from "@gsap/react";
import { useAutoAnimate } from "@formkit/auto-animate/react";
import GradientText from "../components/GradientText";
import { api } from "../lib/api";
import type { SavedSearch } from "../lib/types";
import type { ChipTone } from "../lib/queryChips";
import { cn } from "../lib/cn";
import { GlassPanel } from "../components/ui/GlassPanel";
import { GlassCard } from "../components/ui/GlassCard";
import { MetricCard } from "../components/ui/MetricCard";
import { SmartChip } from "../components/ui/SmartChip";
import { SectionHeader } from "../components/ui/SectionHeader";
import { EmptyState } from "../components/ui/EmptyState";
import { Separator } from "../components/ui/separator";
import {
  Flame,
  Music2,
  CheckCircle2,
  Trophy,
  Clock,
  Tags,
  Radio,
  Archive,
  Sparkles,
  Split,
  Boxes,
  Pin,
  Trash2,
} from "../lib/icons";

gsap.registerPlugin(useGSAP);

type IconType = ComponentType<{ className?: string }>;

interface Queue {
  label: string;
  query: string;
  to: string;
  hint: string;
  icon: IconType;
  tone: ChipTone;
  flagship?: boolean;
}

// flagship "right track for moment" preset (Library mini-syntax).
const FLAGSHIP_QUERY =
  "status:approved darkness:7+ energy:8+ bpm:150-160 role:bridge break:long tolerance:huge not_recent:30 dramatic";

// Top-of-page vital signs — the DJ brain at a glance.
const STATS: { key: string; label: string; query: string; hint: string; icon: IconType; tone: ChipTone }[] = [
  { key: "tracks", label: "Tracks", query: "", hint: "στη βιβλιοθήκη", icon: Music2, tone: "cyan" },
  { key: "approved", label: "Εγκεκριμένα", query: "status:approved", hint: "έτοιμα για set", icon: CheckCircle2, tone: "chartreuse" },
  { key: "weapons", label: "Όπλα", query: "weapons", hint: "δοκιμασμένα", icon: Trophy, tone: "amber" },
  { key: "forgotten", label: "Ξεχασμένα", query: "status:approved not_recent:90", hint: "90η χωρίς play", icon: Clock, tone: "violet" },
  { key: "untagged", label: "Χωρίς tags", query: "untagged", hint: "θέλουν προφίλ", icon: Tags, tone: "blue" },
  { key: "recent", label: "Πρόσφατα", query: "played_recently:30", hint: "παίχτηκαν σε 30η", icon: Radio, tone: "magenta" },
];

// Built-in review queues (the dashboard cards from v1.1 spec). Flagship renders first.
const QUEUES: Queue[] = [
  {
    label: "Όπλα",
    query: "weapons",
    to: "/library?q=weapons",
    hint: "δοκιμασμένα, υψηλή σιγουριά",
    icon: Trophy,
    tone: "chartreuse",
    flagship: true,
  },
  {
    label: "Ξεχασμένα εγκεκριμένα",
    query: "status:approved not_recent:90",
    to: "/library?q=" + encodeURIComponent("status:approved not_recent:90"),
    hint: "εγκεκριμένα, 90 ημέρες χωρίς play",
    icon: Archive,
    tone: "violet",
  },
  {
    label: "Εγκεκριμένα που δεν παίχτηκαν",
    query: "status:approved never_played",
    to: "/library?q=" + encodeURIComponent("status:approved never_played"),
    hint: "εγκεκριμένα αλλά ποτέ live",
    icon: Sparkles,
    tone: "magenta",
  },
  {
    label: "Νέα χωρίς tags",
    query: "untagged",
    to: "/tag",
    hint: "θέλουν ταξινόμηση",
    icon: Tags,
    tone: "cyan",
  },
  {
    label: "Υποψήφια με μεγάλα breaks",
    query: "break:long",
    to: "/library?q=" + encodeURIComponent("break:long"),
    hint: "μεγάλα μελωδικά breakdowns",
    icon: Split,
    tone: "blue",
  },
];

export default function Dashboard() {
  const nav = useNavigate();
  const [stats, setStats] = useState<Record<string, number>>({});
  const [counts, setCounts] = useState<Record<string, number>>({});
  const [dupes, setDupes] = useState(0);
  const [crates, setCrates] = useState<SavedSearch[]>([]);

  const containerRef = useRef<HTMLDivElement>(null);
  const [crateGrid] = useAutoAnimate();

  const load = useCallback(async () => {
    const statEntries = await Promise.all(
      STATS.map(async (s) => [s.key, (await api.trackCount(s.query)).count] as const),
    );
    setStats(Object.fromEntries(statEntries));
    const entries = await Promise.all(
      QUEUES.map(async (q) => [q.label, (await api.trackCount(q.query)).count] as const),
    );
    setCounts(Object.fromEntries(entries));
    setDupes((await api.listDuplicates()).length);
    setCrates(await api.listSearches());
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  useGSAP(
    () => {
      const mm = gsap.matchMedia();
      mm.add("(prefers-reduced-motion: no-preference)", () => {
        gsap.from("[data-reveal]", {
          opacity: 0,
          y: 12,
          duration: 0.4,
          stagger: 0.05,
          ease: "power2.out",
        });
      });
    },
    { scope: containerRef },
  );

  const flagship = QUEUES.find((q) => q.flagship);
  const rest = QUEUES.filter((q) => !q.flagship);

  return (
    <div ref={containerRef} className="h-full overflow-auto p-6">
      {/* Hero — the emotional landing block */}
      <GlassPanel strong className="relative mb-6 overflow-hidden p-6 sm:p-8">
        <div
          aria-hidden
          className="pointer-events-none absolute -right-16 -top-24 h-64 w-64 rounded-full bg-cm-chartreuse/10 blur-3xl"
        />
        <div
          aria-hidden
          className="pointer-events-none absolute -bottom-24 -left-20 h-56 w-56 rounded-full bg-cm-violet/10 blur-3xl"
        />
        <div className="relative flex flex-col gap-5 sm:flex-row sm:items-end sm:justify-between">
          <div>
            <h1>
              <GradientText
                colors={["#4dd6f7", "#9b6dff", "#c2f04a"]}
                animationSpeed={9}
                className="!mx-0 !cursor-default !font-bold text-3xl tracking-tight sm:text-4xl"
              >
                CrateMind
              </GradientText>
            </h1>
            <p className="mt-2 max-w-md text-sm text-cm-muted">
              Βρες το σωστό track πριν χαθεί η στιγμή.
            </p>
          </div>
          <div className="flex flex-col items-start gap-2 sm:items-end">
            <span className="text-[11px] font-semibold uppercase tracking-[0.18em] text-cm-faint">
              Κύριο preset
            </span>
            <SmartChip
              tone="chartreuse"
              icon={Flame}
              title={FLAGSHIP_QUERY}
              className="glow-chartreuse"
              onClick={() => nav("/library?q=" + encodeURIComponent(FLAGSHIP_QUERY))}
            >
              Δραματική γέφυρα κορύφωσης
            </SmartChip>
          </div>
        </div>
      </GlassPanel>

      {/* Quick stats — vital signs */}
      <div className="mb-7 grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
        {STATS.map((s) => (
          <div key={s.key} data-reveal>
            <MetricCard
              value={stats[s.key] ?? "…"}
              label={s.label}
              hint={s.hint}
              icon={s.icon}
              tone={s.tone}
            />
          </div>
        ))}
      </div>

      <Separator className="mb-8 opacity-[0.08]" />

      {/* Review queues — bento grid with a flagship feature tile */}
      <section className="mb-8">
        <SectionHeader>Ουρές ελέγχου</SectionHeader>
        <div className="grid grid-cols-2 gap-3 lg:grid-cols-3">
          {flagship && (
            <div data-reveal className="col-span-2 lg:row-span-2">
              <GlassCard
                interactive
                onClick={() => nav(flagship.to)}
                title={flagship.query}
                className="group glow-chartreuse flex h-full flex-col justify-between p-5"
              >
                <div className="flex items-center justify-between">
                  <span className="text-[11px] font-semibold uppercase tracking-[0.18em] text-cm-chartreuse/80">
                    Κύριο crate
                  </span>
                  <Trophy className="h-5 w-5 text-cm-chartreuse opacity-80 transition group-hover:opacity-100" />
                </div>
                <div className="mt-4">
                  <div className="text-6xl font-bold leading-none tracking-tight tabular-nums text-cm-chartreuse">
                    {counts[flagship.label] ?? "…"}
                  </div>
                  <div className="mt-3 text-base font-semibold text-cm-text">{flagship.label}</div>
                  <div className="mt-0.5 text-xs text-cm-muted">{flagship.hint}</div>
                  <div className="mt-3">
                    <SmartChip tone="chartreuse" className="min-w-0 max-w-full font-mono">
                      <span className="truncate">{flagship.query}</span>
                    </SmartChip>
                  </div>
                </div>
              </GlassCard>
            </div>
          )}

          {rest.map((q) => (
            <div key={q.label} data-reveal>
              <MetricCard
                value={counts[q.label] ?? "…"}
                label={q.label}
                hint={q.hint}
                icon={q.icon}
                tone={q.tone}
                onClick={() => nav(q.to)}
                footer={
                  <SmartChip tone={q.tone} className="min-w-0 max-w-full font-mono">
                    <span className="truncate">{q.query}</span>
                  </SmartChip>
                }
              />
            </div>
          ))}

          <div data-reveal>
            <MetricCard
              value={dupes}
              label="Ύποπτα διπλότυπα"
              hint="ομάδες για έλεγχο"
              icon={Boxes}
              tone="amber"
              onClick={() => nav("/duplicates")}
              footer={
                <SmartChip tone="amber" className="min-w-0 max-w-full font-mono">
                  <span className="truncate">διπλότυπα</span>
                </SmartChip>
              }
            />
          </div>
        </div>
      </section>

      <Separator className="mb-8 opacity-[0.08]" />

      {/* Memory Crates — saved searches as living crates */}
      <section>
        <SectionHeader right={<span className="text-xs text-cm-faint">αποθηκευμένες αναζητήσεις — σώσε μία από τη Βιβλιοθήκη</span>}>
          Memory Crates
        </SectionHeader>
        {crates.length === 0 ? (
          <EmptyState icon={Archive} title="Δεν υπάρχουν Memory Crates">
            Σώσε μία αναζήτηση στη Βιβλιοθήκη για να γίνει ζωντανό crate.
          </EmptyState>
        ) : (
          <div ref={crateGrid} className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
            {crates.map((c) => (
              <GlassCard
                key={c.id}
                interactive
                onClick={() => nav("/library?q=" + encodeURIComponent(c.query))}
                className="group relative p-4"
              >
                <div className="flex items-start justify-between gap-2">
                  <div className="text-3xl font-bold tabular-nums text-cm-cyan">{c.count}</div>
                  <button
                    type="button"
                    title="Διαγραφή crate"
                    onClick={async (e) => {
                      e.stopPropagation();
                      try {
                        await api.deleteSearch(c.id);
                        toast.success(`Διαγράφηκε το crate "${c.name}"`);
                        load();
                      } catch {
                        toast.error("Δεν διαγράφηκε το crate");
                      }
                    }}
                    className="cursor-pointer rounded-md p-1 text-cm-faint opacity-0 transition hover:bg-cm-rose/12 hover:text-cm-rose group-hover:opacity-100"
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                  </button>
                </div>
                <div className="mt-1 flex items-center gap-1.5 text-sm font-medium text-cm-text">
                  {c.pinned && <Pin className="h-3.5 w-3.5 shrink-0 text-cm-amber" />}
                  <span className="truncate">{c.name}</span>
                </div>
                <div className="mt-0.5 truncate font-mono text-xs text-cm-faint" title={c.query}>
                  {c.query}
                </div>
              </GlassCard>
            ))}
          </div>
        )}
      </section>
    </div>
  );
}

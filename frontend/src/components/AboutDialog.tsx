import { useEffect, useRef, useState, type CSSProperties, type ReactNode, type RefObject } from "react";
import { Dialog as DialogPrimitive } from "radix-ui";
import { useReducedMotionConfig } from "motion/react";
import { Dialog, DialogOverlay, DialogPortal, DIALOG_CLOSE_CLASS } from "./ui/dialog";
import { AnimatedNumber } from "./ui/AnimatedNumber";
import { BrandMark } from "./layout/Sidebar";
import { api } from "../lib/api";
import { APP_COMMIT, APP_VERSION, onAboutRequest, runtimeLabel } from "../lib/appInfo";
import { MAXIMIZER_BUILT } from "../lib/audio/maximizer";
import { isDesktopRuntime } from "../lib/desktopRuntime";
import { cn } from "../lib/cn";
import { Activity, ArrowUpRight, Boxes, KeyRound, Layers, ShieldCheck, SlidersHorizontal, Waypoints, X } from "../lib/icons";

const REPOSITORY = "https://github.com/silver-gr/CrateMind";
const LINKS = [
  { label: "Πηγαίος κώδικας", href: REPOSITORY },
  { label: "Τι νέο υπάρχει", href: `${REPOSITORY}/releases` },
  { label: "Άδεια GPL-3.0", href: `${REPOSITORY}/blob/main/LICENSE` },
  // README «Άδεια»: where the licences of third-party packages and tools are kept.
  { label: "Άδειες τρίτων", href: `${REPOSITORY}#%CE%AC%CE%B4%CE%B5%CE%B9%CE%B1` },
];

/** CrateMind's own engines (backend/app/services, lib/fxRack); the tone is the icon tile's accent. */
const ENGINES: { icon: typeof Activity; tone: string; title: string; text: string }[] = [
  { icon: Activity, tone: "text-cm-cyan", title: "Beatgrid", text: "Το tempo, η θέση των beats και η γραμμή του μέτρου, μετρημένα από τον ήχο κάθε κομματιού." },
  { icon: KeyRound, tone: "text-cm-violet", title: "Μουσικό κλειδί", text: "Από ολόκληρο το κομμάτι, με βάρη εκπαιδευμένα σε κομμάτια όπου συμφωνούν δύο ή τρεις DJ εφαρμογές." },
  { icon: Layers, tone: "text-cm-blue", title: "Δομή κομματιού", text: "Πού μπαίνει και πού βγαίνει το μπάσο, και γραμμές φράσης κάθε 8 μέτρα." },
  { icon: Waypoints, tone: "text-cm-chartreuse", title: "Προτάσεις με εξήγηση", text: "Διαφανής βαθμολόγηση, όχι AI: κάθε πρόταση δείχνει τους λόγους υπέρ και κατά." },
  { icon: Boxes, tone: "text-cm-amber", title: "Διπλότυπα", text: "Ίδιο αρχείο, ίδιος τίτλος ή ίδια ηχογράφηση. Τα σημειώνει για έλεγχο και δεν διαγράφει ποτέ μόνο του." },
  { icon: SlidersHorizontal, tone: "text-cm-magenta", title: "FX rack", text: "Εφέ σε κάθε deck με δικό μας DSP, κλειδωμένα στο beat." },
];

type CreditGroup = { heading: string; rows: { role: string; names: string }[]; note?: string };

/** What CrateMind is built on. Names come from the code and `scripts/third_party_licenses.py`, never from memory. */
const CREDITS: CreditGroup[] = [
  {
    heading: "Ήχος",
    rows: [
      { role: "Time-stretch και αλλαγή τόνου στα decks", names: "Signalsmith Stretch" },
      { role: "Αποκωδικοποίηση, μέτρηση LUFS, εγγραφή σε AAC", names: "FFmpeg" },
      { role: "Ηχητικά αποτυπώματα για τα διπλότυπα", names: "Chromaprint" },
      // The Maximizer's engine exists only in personal builds; public builds never show this row.
      ...(MAXIMIZER_BUILT ? [{ role: "Η μηχανή του Maximizer", names: "master_me" }] : []),
    ],
  },
  {
    heading: "Ανάλυση",
    rows: [
      { role: "Φάσμα για το κλειδί, εκτίμηση BPM", names: "librosa" },
      { role: "Οι υπολογισμοί για beatgrid, δομή και κυματομορφές", names: "NumPy" },
      { role: "Επεξεργασία σήματος", names: "SciPy · Numba" },
      { role: "Ανάγνωση των tags των αρχείων", names: "Mutagen" },
    ],
  },
  {
    heading: "Εφαρμογή",
    rows: [
      { role: "Το κέλυφος της desktop εφαρμογής", names: "Tauri" },
      { role: "MIDI για τον controller", names: "midir" },
      { role: "Εγκατάσταση και ενημερώσεις στα Windows", names: "Velopack" },
      { role: "Τοπικός server", names: "FastAPI · Uvicorn" },
      { role: "Βάση δεδομένων", names: "SQLite · SQLModel" },
      { role: "Πακετάρισμα του backend", names: "PyInstaller" },
    ],
  },
  {
    heading: "Διεπαφή",
    rows: [
      { role: "Η βάση της διεπαφής", names: "React · Vite" },
      { role: "Στυλ", names: "Tailwind CSS" },
      { role: "Διάλογοι, μενού, παλέτα εντολών, ειδοποιήσεις", names: "Radix UI · cmdk · Sonner" },
      { role: "Κίνηση", names: "Motion" },
      { role: "WebGL για το φόντο aurora", names: "OGL" },
      { role: "Εικονίδια", names: "Lucide" },
      { role: "Λίστες με χιλιάδες γραμμές", names: "TanStack Virtual" },
      { role: "Γραμματοσειρές", names: "Inter · Geist · JetBrains Mono" },
    ],
  },
  {
    heading: "Φόντα και εφέ",
    rows: [{ role: "Κινούμενα φόντα, Metallic Paint, Shiny Text", names: "React Bits" }],
    note: "Με την άδεια του δημιουργού τους.",
  },
  {
    heading: "Controller",
    rows: [{ role: "Η βάση για την αντιστοίχιση του Mixtrack Platinum FX", names: "Mixxx" }],
  },
];

type LibraryNumbers = { tracks: number; profiled: number; played: number; sets: number };

/** A few counts from routes the Dashboard already uses. They are a courtesy: on any failure the section is left out. */
function useLibraryNumbers(): LibraryNumbers | null {
  const [numbers, setNumbers] = useState<LibraryNumbers | null>(null);
  useEffect(() => {
    let active = true;
    Promise.all([api.trackCount(""), api.trackCount("untagged"), api.trackCount("never_played"), api.listSets()])
      .then(([all, untagged, unplayed, sets]) => {
        if (active && all.count > 0) {
          setNumbers({ tracks: all.count, profiled: all.count - untagged.count, played: all.count - unplayed.count, sets: sets.length });
        }
      })
      .catch(() => {});
    return () => { active = false; };
  }, []);
  return numbers;
}

function useRuntimeLabel(): string {
  const [browserArch, setBrowserArch] = useState<string>();
  useEffect(() => {
    let active = true;
    const data = (navigator as Navigator & {
      userAgentData?: { getHighEntropyValues?: (hints: string[]) => Promise<{ architecture?: string }> };
    }).userAgentData;
    void data?.getHighEntropyValues?.(["architecture"])
      .then(values => { if (active) setBrowserArch(values.architecture); })
      .catch(() => {});
    return () => { active = false; };
  }, []);
  return runtimeLabel({
    desktop: isDesktopRuntime(),
    nativeHost: document.documentElement.dataset.nativeHost,
    userAgent: navigator.userAgent,
    browserArch,
  });
}

const ROLL_SPEED = 20; // px per second: slow enough to read a line as it passes
const ROLL_DELAY = 3200; // ms before the roll starts, so the first screen can be read
/** The reader took over the scrolling: the roll stops for good. */
const TAKEOVER = ["wheel", "touchstart", "pointerdown", "keydown"] as const;

/**
 * The credits roll: the list scrolls by itself, waits while the pointer or the keyboard focus is on it, and stops
 * for good at the end or as soon as the reader scrolls. One rAF loop, alive only while the window is open.
 */
function useCreditsRoll(ref: RefObject<HTMLDivElement | null>, enabled: boolean) {
  useEffect(() => {
    const el = ref.current;
    if (!el || !enabled) return;
    let frame = 0;
    let last = 0;
    let position = 0;
    let held = el.matches(":hover");
    const startAt = performance.now() + ROLL_DELAY;
    const stop = () => {
      cancelAnimationFrame(frame);
      frame = 0;
      for (const type of TAKEOVER) el.removeEventListener(type, stop);
    };
    const step = (now: number) => {
      frame = requestAnimationFrame(step);
      const elapsed = Math.min(64, now - last);
      last = now;
      if (now < startAt || held || document.hidden) { position = el.scrollTop; return; }
      const end = el.scrollHeight - el.clientHeight;
      if (position >= end) { stop(); return; }
      position = Math.min(end, position + (elapsed * ROLL_SPEED) / 1000);
      el.scrollTop = position;
    };
    const hold = () => { held = true; };
    const release = () => { held = el.matches(":hover") || el.contains(document.activeElement); };
    for (const type of TAKEOVER) el.addEventListener(type, stop, { passive: true });
    el.addEventListener("pointerenter", hold);
    el.addEventListener("pointerleave", release);
    el.addEventListener("focusin", hold);
    el.addEventListener("focusout", release);
    frame = requestAnimationFrame(step);
    return () => {
      stop();
      el.removeEventListener("pointerenter", hold);
      el.removeEventListener("pointerleave", release);
      el.removeEventListener("focusin", hold);
      el.removeEventListener("focusout", release);
    };
  }, [ref, enabled]);
}

const rise = (order: number) => ({ "--i": order }) as CSSProperties;

function RollTitle({ children }: { children: ReactNode }) {
  return <h3 className="cm-about-title micro-label text-cm-muted">{children}</h3>;
}

function ExternalLink({ href, children }: { href: string; children: ReactNode }) {
  // A plain link: the desktop shell opens foreign links in the system browser (interceptExternalLinks in main.tsx).
  return (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      className="group/link inline-flex items-center gap-0.5 rounded-sm text-xs font-medium text-cm-muted transition-colors duration-150 hover:text-cm-cyan focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-cm-cyan"
    >
      {children}
      <ArrowUpRight aria-hidden="true" className="size-3.5 opacity-60 transition-[opacity,translate] duration-150 group-hover/link:-translate-y-px group-hover/link:translate-x-px group-hover/link:opacity-100 motion-reduce:transition-none" />
    </a>
  );
}

function AboutBody() {
  const numbers = useLibraryNumbers();
  const runtime = useRuntimeLabel();
  const rollRef = useRef<HTMLDivElement>(null);
  useCreditsRoll(rollRef, !useReducedMotionConfig());
  const build = [APP_VERSION && `Έκδοση ${APP_VERSION}`, APP_COMMIT && `build ${APP_COMMIT}`, runtime].filter(Boolean).join(" · ");

  return (
    <>
      <header className="cm-about-stage">
        <div className="cm-about-logo">
          <span aria-hidden="true" className="cm-about-disc" />
          <BrandMark />
        </div>
        <div className="min-w-0">
          <DialogPrimitive.Title className="cm-about-heading cm-about-rise" style={rise(0)}>
            <span className="sr-only">Σχετικά με το </span>
            <span className="cm-about-name cm-title-sheen">CrateMind</span>
            {APP_VERSION && <span className="font-mono text-xs font-medium tracking-tight text-cm-faint">v{APP_VERSION}</span>}
          </DialogPrimitive.Title>
          <DialogPrimitive.Description className="cm-about-rise mt-2.5 text-pretty text-sm leading-relaxed text-cm-muted" style={rise(1)}>
            <span className="block">Η μουσική σου συλλογή, δύο decks και η δική σου γνώμη για κάθε κομμάτι.</span>
            <span className="block">Όλα τοπικά, στον υπολογιστή σου. Χωρίς λογαριασμούς και χωρίς cloud.</span>
          </DialogPrimitive.Description>
        </div>
      </header>

      <p className="cm-about-promise cm-about-rise text-[13px] leading-relaxed text-cm-text" style={rise(2)}>
        <ShieldCheck aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-cm-chartreuse" />
        <span>
          Το CrateMind δεν αλλάζει, δεν μετακινεί και δεν διαγράφει ποτέ τα αρχεία της μουσικής σου.{" "}
          <span className="text-cm-muted">Κρατά μόνο τις δικές του σημειώσεις.</span>
        </span>
      </p>

      <div
        ref={rollRef}
        tabIndex={0}
        role="region"
        aria-label="Η βιβλιοθήκη σου, οι μηχανές του CrateMind, συντελεστές και άδεια"
        className="cm-about-roll cm-about-rise scroll-fade-y space-y-7"
        style={rise(3)}
      >
        {numbers && (
          <section className="space-y-3">
            <RollTitle>Η βιβλιοθήκη σου</RollTitle>
            <dl className="grid grid-cols-2 gap-y-3 sm:grid-cols-4">
              {([
                ["Κομμάτια", numbers.tracks],
                ["Χαρακτηρισμένα", numbers.profiled],
                ["Έχουν παιχτεί", numbers.played],
                ["Sets", numbers.sets],
              ] as const).map(([label, value]) => (
                <div key={label} className="flex flex-col-reverse items-center gap-0.5 sm:not-first:border-l sm:not-first:border-cm-border">
                  <dt className="text-[11px] text-cm-muted">{label}</dt>
                  <dd className="font-mono text-2xl font-medium tracking-tight text-cm-text"><AnimatedNumber value={value} /></dd>
                </div>
              ))}
            </dl>
          </section>
        )}

        <section className="space-y-3.5">
          <RollTitle>Οι μηχανές του CrateMind</RollTitle>
          <ul className="grid grid-cols-1 gap-x-6 gap-y-3.5 sm:grid-cols-2">
            {ENGINES.map(({ icon: Icon, tone, title, text }) => (
              <li key={title} className="flex items-start gap-3">
                <span aria-hidden="true" className={cn("grid size-8 shrink-0 place-items-center rounded-lg bg-current/10 ring-1 ring-inset ring-current/20", tone)}>
                  <Icon className="size-4" />
                </span>
                <div className="min-w-0">
                  <p className="text-[13px] font-semibold leading-snug text-cm-text">{title}</p>
                  <p className="mt-0.5 text-xs leading-relaxed text-cm-muted">{text}</p>
                </div>
              </li>
            ))}
          </ul>
        </section>

        <section className="space-y-4">
          <RollTitle>Χτισμένο πάνω σε</RollTitle>
          {CREDITS.map(group => (
            <div key={group.heading} className="space-y-1.5">
              <h4 className="text-[11px] sm:text-center font-semibold uppercase tracking-[0.14em] text-cm-cyan">{group.heading}</h4>
              <dl className="space-y-1">
                {group.rows.map(row => (
                  <div key={row.names} className="cm-about-credit">
                    <dt className="text-xs leading-relaxed text-cm-muted">{row.role}</dt>
                    <dd className="text-[13px] font-medium leading-relaxed text-cm-text">{row.names}</dd>
                  </div>
                ))}
              </dl>
              {group.note && <p className="text-[11px] text-cm-faint sm:text-center">{group.note}</p>}
            </div>
          ))}
        </section>

        <section className="space-y-3">
          <RollTitle>Άδεια</RollTitle>
          <div className="mx-auto max-w-[34rem] space-y-2 text-center text-xs leading-relaxed text-cm-muted">
            <p>
              Ελεύθερο λογισμικό: ο καθένας μπορεί να το χρησιμοποιεί, να το μελετά, να το αλλάζει και να το μοιράζεται με
              τους όρους της GNU General Public License, έκδοση 3 (GPL-3.0-only). Παρέχεται χωρίς καμία εγγύηση.
            </p>
            <p>
              Οι άδειες των πακέτων και των εργαλείων τρίτων, και οι σύνδεσμοι για τον πηγαίο κώδικά τους, βρίσκονται στο{" "}
              <span className="font-mono text-[11px] text-cm-text">NOTICES.txt</span> και στον φάκελο{" "}
              <span className="font-mono text-[11px] text-cm-text">licenses/</span> μέσα στην desktop εφαρμογή.
            </p>
          </div>
        </section>
      </div>

      <footer className="cm-about-rise shrink-0 space-y-2 border-t border-cm-border bg-cm-bg/25 px-(--about-pad) pb-3.5 pt-3" style={rise(4)}>
        <nav aria-label="Σύνδεσμοι" className="flex flex-wrap items-center gap-x-5 gap-y-1.5">
          {LINKS.map(link => <ExternalLink key={link.href} href={link.href}>{link.label}</ExternalLink>)}
        </nav>
        <p className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-0.5 font-mono text-[11px] text-cm-faint">
          <span className="select-text">{build}</span>
          <span className="font-sans">GPL-3.0-only · χωρίς καμία εγγύηση</span>
        </p>
      </footer>
    </>
  );
}

/**
 * «Σχετικά με το CrateMind»: opened by the macOS app menu, the command palette and Settings (all through
 * `openAbout`). The body mounts only while the window is open, so its animations and requests cost nothing otherwise.
 */
export default function AboutDialog() {
  const [open, setOpen] = useState(false);
  const contentRef = useRef<HTMLDivElement>(null);
  useEffect(() => onAboutRequest(() => setOpen(true)), []);

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogPortal>
        <DialogOverlay className="cm-about-backdrop" />
        <DialogPrimitive.Content
          data-slot="dialog-content"
          ref={contentRef}
          // Focus lands on the window itself, not on a control: opened from the native menu, no button shows a ring.
          onOpenAutoFocus={event => { event.preventDefault(); contentRef.current?.focus(); }}
          className="cm-about border surface-menu ease-out data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=closed]:zoom-out-98 data-[state=closed]:duration-150 data-[state=open]:animate-in data-[state=open]:fade-in-0 data-[state=open]:zoom-in-96 data-[state=open]:slide-in-from-bottom-2 data-[state=open]:duration-300"
        >
          {/* First in the tab order; DIALOG_CLOSE_CLASS places it top right. */}
          <DialogPrimitive.Close className={cn(DIALOG_CLOSE_CLASS, "z-10")}>
            <X />
            <span className="sr-only">Κλείσιμο</span>
          </DialogPrimitive.Close>
          <AboutBody />
        </DialogPrimitive.Content>
      </DialogPortal>
    </Dialog>
  );
}

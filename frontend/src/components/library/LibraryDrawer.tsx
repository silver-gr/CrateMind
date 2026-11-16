import { useEffect, useEffectEvent, useRef, type ReactNode } from "react";
import { AnimatePresence, motion } from "motion/react";
import { X } from "../../lib/icons";
import type { LucideIcon } from "lucide-react";

const EASE_DRAWER = [0.32, 0.72, 0, 1] as const; // --ease-drawer

/**
 * A non-modal right drawer inside the Library (the «Ετικέτες» cloud and the Flow Finder). It slides over the
 * table and sidebar from the right edge with no scrim, so the table stays usable; reduced motion (MotionConfig)
 * leaves only the fade. Esc closes it unless a layer inside (a Select, a dialog) already handled the key.
 * Focus moves in on open and, when it was inside on close, back to `returnFocus()` (or `fallbackFocus()`).
 */
export function LibraryDrawer({
  open,
  id,
  title,
  icon: Icon,
  width,
  onClose,
  returnFocus,
  fallbackFocus,
  children,
}: {
  open: boolean;
  id: string;
  title: string;
  icon: LucideIcon;
  /** CSS width, e.g. `min(384px, calc(100% - 48px))`. */
  width: string;
  onClose: () => void;
  returnFocus: () => HTMLElement | null;
  fallbackFocus: () => HTMLElement | null;
  children: ReactNode;
}) {
  return (
    <AnimatePresence>
      {open && (
        <DrawerPanel key={id} id={id} title={title} icon={Icon} width={width} onClose={onClose}
          returnFocus={returnFocus} fallbackFocus={fallbackFocus}>
          {children}
        </DrawerPanel>
      )}
    </AnimatePresence>
  );
}

function DrawerPanel({
  id,
  title,
  icon: Icon,
  width,
  onClose,
  returnFocus,
  fallbackFocus,
  children,
}: Omit<Parameters<typeof LibraryDrawer>[0], "open">) {
  const panelRef = useRef<HTMLElement>(null);
  const titleId = `${id}-title`;

  function close() {
    const hadFocus = panelRef.current?.contains(document.activeElement) ?? false;
    onClose();
    if (!hadFocus) return;
    const target = returnFocus();
    if (target?.isConnected) target.focus();
    if (!target?.isConnected || document.activeElement !== target) fallbackFocus()?.focus({ preventScroll: true });
  }
  const onEscape = useEffectEvent((e: KeyboardEvent) => {
    if (e.key === "Escape" && !e.defaultPrevented) close();
  });

  useEffect(() => {
    panelRef.current?.focus({ preventScroll: true });
    // Window-level: clicking the table moves focus out of a non-modal drawer. Radix layers inside
    // (Select, Dialog) prevent their own Esc, and React events bubble through portals.
    const onKey = (e: KeyboardEvent) => onEscape(e);
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  return (
    <motion.section
      ref={panelRef}
      id={id}
      role="dialog"
      aria-modal="false"
      aria-labelledby={titleId}
      tabIndex={-1}
      style={{ width }}
      initial={{ x: "100%", opacity: 0 }}
      animate={{ x: 0, opacity: 1, transition: { duration: 0.3, ease: EASE_DRAWER, opacity: { duration: 0.15 } } }}
      exit={{ x: "100%", opacity: 0, transition: { duration: 0.2, ease: EASE_DRAWER, opacity: { duration: 0.2 } } }}
      className="glass-strong absolute inset-y-0 right-0 z-40 flex flex-col rounded-l-2xl outline-none"
    >
      <header className="flex shrink-0 items-center gap-2 border-b border-cm-border px-4 py-3">
        <Icon className="h-4 w-4 shrink-0 text-cm-cyan" aria-hidden="true" />
        <h2 id={titleId} className="min-w-0 flex-1 truncate text-sm font-semibold text-cm-text">{title}</h2>
        <button
          type="button"
          onClick={close}
          aria-label={`Κλείσιμο: ${title}`}
          title="Κλείσιμο (Esc)"
          className="relative grid size-8 place-items-center rounded-lg text-cm-muted transition-[background-color,color,scale] duration-150 hover:bg-cm-contrast/8 hover:text-cm-text motion-safe:active:scale-[0.94] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cm-cyan/60"
        >
          <X className="size-4" />
        </button>
      </header>
      <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain">{children}</div>
    </motion.section>
  );
}

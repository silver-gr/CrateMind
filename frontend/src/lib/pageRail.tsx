import { createContext, useContext, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";

/** The shell's right rail (layout/AppShell.tsx): one element for the app's lifetime, beside the page column. */
/** The default width of every page side panel, left or right (Library, Set Builder, «Χαρακτηρισμός tracks»): they all open as
 *  wide as the Library's inspector, so the screens line up. A width the user dragged is kept. */
export const SIDE_PANEL_WIDTH = 384;

export const PageRailContext = createContext<HTMLElement | null>(null);

/**
 * A page's right panel. Inside the shell it is portalled into the rail, so it runs from under the top bar beside the page (and,
 * when the dock leaves it room, beside the dock to the window's bottom); elsewhere (tests, a page outside the shell) it stays in
 * place. The rail is the same element from the page's first render, so the panel never remounts. `inline` keeps it in place (the
 * Library's narrow layout, which stacks its inspector under the table); switching it remounts the panel.
 */
export function PageRail({ children, inline = false }: { children: ReactNode; inline?: boolean }) {
  const rail = useContext(PageRailContext);
  return rail && !inline ? createPortal(children, rail) : children;
}

/**
 * The shell's left column for a page's left panel: `host` is one element for the app's lifetime, in the sidebar's grid column;
 * `shown` is true only while no app sidebar column is shown (the floating bar), the one state in which a page's left panel takes
 * that column. Null outside the shell.
 */
export type PageLeftRailValue = { host: HTMLElement; shown: boolean };
export const PageLeftRailContext = createContext<PageLeftRailValue | null>(null);

/** Whether a page's left panel may take the shell's left column now (no app sidebar column is shown). */
export function useLeftRailShown(): boolean {
  return useContext(PageLeftRailContext)?.shown ?? false;
}

/**
 * A page's left panel (the Library's «Φίλτρα / Καλλιτέχνες / Ιστορικό», Set Builder's candidates). It renders, through a portal,
 * into a box made once, and that box is moved between its place in the page and the shell's left column, so switching the sidebar
 * between full, icon rail and floating bar never remounts the panel (its lists, fetches and state stay); only scroll positions
 * inside it start over, as with any moved element. The box and its place in the page are `display: contents`, so the panel lays
 * out as a child of the page's own row. It goes to the left column while the shell shows no sidebar column and `inline` is false;
 * outside the shell it renders in place.
 */
export function PageLeftRail({ children, inline = false }: { children: ReactNode; inline?: boolean }) {
  const rail = useContext(PageLeftRailContext);
  const [box] = useState(() => {
    if (typeof document === "undefined") return null;
    const el = document.createElement("div");
    el.className = "contents";
    return el;
  });
  const slot = useRef<HTMLDivElement>(null);
  const toRail = Boolean(rail?.shown) && !inline;
  const host = rail?.host ?? null;
  useLayoutEffect(() => {
    if (!box) return;
    const target = toRail ? host : slot.current;
    if (target && box.parentElement !== target) target.appendChild(box);
  }, [box, host, toRail]);
  useLayoutEffect(() => () => box?.remove(), [box]);
  if (!rail || !box) return children;
  return <><div ref={slot} className="contents" />{createPortal(children, box)}</>;
}

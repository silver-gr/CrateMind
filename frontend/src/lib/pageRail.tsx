import { createContext, useContext, type ReactNode } from "react";
import { createPortal } from "react-dom";

/** The shell's right rail (layout/AppShell.tsx): one element for the app's lifetime, beside the page column. */
export const PageRailContext = createContext<HTMLElement | null>(null);

/**
 * A page's right panel. Inside the shell it is portalled into the rail, so with the two-deck dock in the page column it runs
 * beside the dock to the window's bottom; elsewhere (tests, a page outside the shell) it stays in place. The rail is the same
 * element from the page's first render, so the panel never remounts.
 */
export function PageRail({ children }: { children: ReactNode }) {
  const rail = useContext(PageRailContext);
  return rail ? createPortal(children, rail) : children;
}

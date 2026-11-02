import { useCallback, useEffect, useState } from "react";
import { cn } from "../../lib/cn";
import { IS_MAXIMIZED_COMMAND, captionButtons, hasCustomTitlebar, invokeWindow } from "../../lib/windowControls";

const NO_DRAG = { pointerEvents: "auto", appRegion: "no-drag", WebkitAppRegion: "no-drag" } as React.CSSProperties;

export default function WindowControls() {
  const custom = hasCustomTitlebar();
  const [maximized, setMaximized] = useState(false);
  const sync = useCallback(() => {
    invokeWindow(IS_MAXIMIZED_COMMAND).then((r) => setMaximized(Boolean(r)), () => undefined);
  }, []);

  useEffect(() => {
    if (!custom) return;
    sync();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const onResize = () => { clearTimeout(timer); timer = setTimeout(sync, 150); };
    window.addEventListener("resize", onResize);
    return () => { window.removeEventListener("resize", onResize); clearTimeout(timer); };
  }, [custom, sync]);

  if (!custom) return null;
  return (
    <div
      role="group"
      aria-label="Έλεγχοι παραθύρου"
      className="fixed right-0 top-0 z-[2147483000] flex"
      style={{ ...NO_DRAG, height: "var(--cm-titlebar-height)" }}
    >
      {captionButtons(maximized).map((b) => (
        <button
          key={b.id}
          type="button"
          tabIndex={-1}
          aria-label={b.label}
          title={b.label}
          style={NO_DRAG}
          className={cn(
            "flex h-full w-[46px] items-center justify-center text-cm-text outline-none transition-colors focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-cm-cyan",
            b.id === "close"
              ? "hover:bg-[#c42b1c] hover:text-white active:bg-[#b02418] active:text-white"
              : "hover:bg-black/[0.06] active:bg-black/[0.10] dark:hover:bg-white/[0.08] dark:active:bg-white/[0.12]",
          )}
          onClick={() => {
            invokeWindow(b.command).catch(() => undefined).then(() => { if (b.id === "maximize") sync(); });
          }}
        >
          <span aria-hidden="true" style={{ fontFamily: '"Segoe Fluent Icons", "Segoe MDL2 Assets"', fontSize: 10 }}>{b.glyph}</span>
        </button>
      ))}
    </div>
  );
}

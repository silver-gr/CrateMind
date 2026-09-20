import { useId } from "react";
import { Disc3 } from "../../lib/icons";

export function CatalogLoading({title, description = "Ανάγνωση κομματιών και μεταδεδομένων…"}: {title: string; description?: string}) {
 const id = useId();
 return (<div role="status" aria-live="polite" className="flex h-full min-h-[420px] w-full flex-col items-center justify-center p-6 text-center select-none">
            {/* 250x250 Animated Deck / Celestial Turntable Element */}
            <div className="relative flex h-[250px] w-[250px] shrink-0 items-center justify-center">
              {/* Ambient atmospheric glow */}
              <div className="pointer-events-none absolute inset-4 rounded-full bg-cm-cyan/15 blur-2xl animate-pulse [animation-duration:3s]" />
              <div className="pointer-events-none absolute inset-10 rounded-full bg-cm-violet/12 blur-xl animate-pulse [animation-duration:4s]" />

              <svg viewBox="0 0 250 250" className="h-full w-full pointer-events-none">
                <defs>
                  <linearGradient id={`${id}-cm-loader-grad`} x1="0%" y1="0%" x2="100%" y2="100%">
                    <stop offset="0%" stopColor="var(--color-cm-cyan)" stopOpacity="0.8" />
                    <stop offset="50%" stopColor="var(--color-cm-blue)" stopOpacity="0.6" />
                    <stop offset="100%" stopColor="var(--color-cm-violet)" stopOpacity="0.8" />
                  </linearGradient>
                  <linearGradient id={`${id}-cm-vinyl-sheen`} x1="0%" y1="0%" x2="100%" y2="100%">
                    <stop offset="0%" stopColor="white" stopOpacity="0.08" />
                    <stop offset="50%" stopColor="transparent" stopOpacity="0" />
                    <stop offset="100%" stopColor="white" stopOpacity="0.05" />
                  </linearGradient>
                </defs>

                {/* Outer dashed spinning radar ring */}
                <g className="animate-spin [animation-duration:32s] origin-center">
                  <circle
                    cx="125"
                    cy="125"
                    r="118"
                    fill="none"
                    stroke="var(--color-cm-cyan)"
                    strokeWidth="1"
                    strokeDasharray="4 8"
                    className="opacity-35"
                  />
                  <circle cx="125" cy="7" r="3.5" fill="var(--color-cm-cyan)" className="animate-pulse" />
                  <circle cx="125" cy="243" r="2.5" fill="var(--color-cm-violet)" className="animate-pulse" />
                </g>

                {/* Counter-rotating elliptical orbit ring */}
                <g className="animate-spin [animation-duration:22s] [animation-direction:reverse] origin-center">
                  <ellipse
                    cx="125"
                    cy="125"
                    rx="110"
                    ry="80"
                    fill="none"
                    stroke="var(--color-cm-violet)"
                    strokeWidth="0.9"
                    className="opacity-30"
                  />
                  <circle cx="235" cy="125" r="3" fill="var(--color-cm-violet)" className="animate-pulse" />
                  <circle cx="15" cy="125" r="2.5" fill="var(--color-cm-cyan)" className="animate-pulse" />
                </g>

                {/* Diagonal orbit ring */}
                <g className="animate-spin [animation-duration:18s] origin-center">
                  <ellipse
                    cx="125"
                    cy="125"
                    rx="86"
                    ry="108"
                    fill="none"
                    stroke="var(--color-cm-blue)"
                    strokeWidth="0.8"
                    strokeDasharray="2 5"
                    className="opacity-30"
                  />
                </g>

                {/* Center vinyl record (diameter 152px, r=76) */}
                <circle
                  cx="125"
                  cy="125"
                  r="76"
                  className="fill-black/70 dark:fill-black/90 stroke-white/15"
                  strokeWidth="1.2"
                />
                {/* Vinyl sheen overlay */}
                <circle cx="125" cy="125" r="76" fill={`url(#${id}-cm-vinyl-sheen)`} />

                {/* Grooves */}
                <circle cx="125" cy="125" r="70" fill="none" stroke="currentColor" strokeWidth="0.5" className="text-white/10" />
                <circle cx="125" cy="125" r="64" fill="none" stroke="currentColor" strokeWidth="0.5" className="text-white/10" />
                <circle cx="125" cy="125" r="58" fill="none" stroke="currentColor" strokeWidth="0.5" className="text-white/8" />
                <circle cx="125" cy="125" r="52" fill="none" stroke="currentColor" strokeWidth="0.5" className="text-white/10" />
                <circle cx="125" cy="125" r="46" fill="none" stroke="currentColor" strokeWidth="0.5" className="text-white/8" />
                <circle cx="125" cy="125" r="40" fill="none" stroke="currentColor" strokeWidth="0.5" className="text-white/10" />

                {/* Center label (sticker) */}
                <circle
                  cx="125"
                  cy="125"
                  r="32"
                  fill={`url(#${id}-cm-loader-grad)`}
                  className="stroke-white/20"
                  strokeWidth="1"
                />
                <circle cx="125" cy="125" r="30" fill="none" stroke="currentColor" strokeWidth="0.6" className="text-white/20" />
                <circle cx="125" cy="125" r="7" fill="black" className="opacity-80" />
                <circle cx="125" cy="125" r="3.5" fill="var(--color-cm-cyan)" />
              </svg>

              {/* Center spinning disc icon */}
              <div className="pointer-events-none absolute flex h-14 w-14 items-center justify-center">
                <Disc3 className="h-8 w-8 text-white/90 animate-spin [animation-duration:3s]" />
              </div>
            </div>

            {/* EQ visualizer bars */}
            <div className="mt-4 flex h-5 items-end justify-center gap-1.5">
              {[0, 1, 2, 3, 4, 5, 6].map((i) => (
                <span
                  key={i}
                  className="cm-eq-bar w-1 rounded-full bg-gradient-to-t from-cm-cyan via-cm-blue to-cm-violet"
                  style={{
                    height: "100%",
                    animationDelay: `${i * 120}ms`,
                    animationDuration: `${650 + (i % 3) * 180}ms`,
                  }}
                />
              ))}
            </div>

            <div className="mt-3 space-y-1">
              <div className="text-base font-semibold text-cm-text">
                {title}
              </div>
              <div className="text-xs text-cm-muted">
                {description}
              </div>
            </div>
          </div>);
}

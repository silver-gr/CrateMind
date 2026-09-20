import { type CSSProperties, useEffect, useState } from "react";
import { cn } from "@/lib/cn";
import { Disc3 } from "@/lib/icons";

/**
 * Album-art display component with graceful degradation:
 * 1. If trackId is provided (or numeric seed), attempts to fetch real artwork
 *    from `/api/tracks/{trackId}/artwork` (embedded file tag -> SoundCloud match -> 404).
 * 2. If delayMs is set (>0), debounce loading so fast virtual-scroll doesn't hammer the server.
 * 3. Keeps module-level memory sets for failed and loaded artwork to eliminate duplicate requests.
 * 4. Falls back to deterministic neon gradient tile keyed on seed if no artwork exists or during load.
 */
const HUES = [205, 252, 300, 340, 128, 78, 18]; // cm cyan/blue/violet/magenta/chartreuse/amber/rose

// Module-level caches to avoid repeating failed requests or flashing re-renders across virtualized rows
const failedArtworkIds = new Set<number>();
const loadedArtworkIds = new Set<number>();

function hash(seed: string | number): number {
  const s = String(seed);
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return Math.abs(h);
}

export interface ArtworkProps {
  seed: string | number;
  trackId?: number;
  delayMs?: number;
  className?: string;
  circle?: boolean;
  glyph?: boolean;
  alt?: string;
}

export function Artwork({
  seed,
  trackId: explicitTrackId,
  delayMs = 0,
  className,
  circle = false,
  glyph = true,
  alt = "",
}: ArtworkProps) {
  const trackId = explicitTrackId ?? (typeof seed === "number" && seed > 0 ? seed : undefined);

  // Status: 'none' (gradient only), 'waiting' (debouncing), 'loading' (img rendering), 'loaded' (img visible)
  const [status, setStatus] = useState<"none" | "waiting" | "loading" | "loaded">(() => {
    if (!trackId || failedArtworkIds.has(trackId)) return "none";
    if (loadedArtworkIds.has(trackId)) return "loaded";
    if (delayMs > 0) return "waiting";
    return "loading";
  });

  useEffect(() => {
    if (!trackId || failedArtworkIds.has(trackId)) {
      setStatus("none");
      return;
    }
    if (loadedArtworkIds.has(trackId)) {
      setStatus("loaded");
      return;
    }

    if (delayMs > 0) {
      setStatus("waiting");
      const timer = setTimeout(() => {
        setStatus("loading");
      }, delayMs);
      return () => clearTimeout(timer);
    } else {
      setStatus("loading");
    }
  }, [trackId, delayMs]);

  const h = hash(seed);
  const a = HUES[h % HUES.length];
  const b = HUES[(h >> 4) % HUES.length];
  const ang = h % 360;
  const gradientStyle: CSSProperties = {
    backgroundImage: `linear-gradient(${ang}deg, oklch(0.58 0.18 ${a}), oklch(0.26 0.10 ${b}))`,
  };

  const shouldRenderImg = trackId != null && (status === "loading" || status === "loaded");
  const isLoaded = status === "loaded";

  return (
    <div
      aria-hidden={alt ? undefined : true}
      className={cn(
        "relative grid shrink-0 place-items-center overflow-hidden select-none",
        circle ? "rounded-full" : "rounded-lg",
        className,
      )}
      style={gradientStyle}
    >
      {/* Subtle radial highlight for procedural gradient */}
      <div
        className={cn(
          "absolute inset-0 pointer-events-none transition-opacity duration-300",
          isLoaded ? "opacity-0" : "opacity-100",
        )}
        style={{ backgroundImage: "radial-gradient(circle at 28% 22%, oklch(1 0 0 / 0.20), transparent 55%)" }}
      />

      {/* Center disc icon when no artwork is loaded */}
      {glyph && !isLoaded && (
        <Disc3 className="relative h-1/3 w-1/3 text-white/25 pointer-events-none" />
      )}

      {/* Real artwork img if available */}
      {shouldRenderImg && (
        <img
          src={`/api/tracks/${trackId}/artwork`}
          alt={alt}
          loading="lazy"
          decoding="async"
          onLoad={() => {
            if (trackId) loadedArtworkIds.add(trackId);
            setStatus("loaded");
          }}
          onError={() => {
            if (trackId) failedArtworkIds.add(trackId);
            setStatus("none");
          }}
          className={cn(
            "absolute inset-0 h-full w-full object-cover transition-opacity duration-200",
            isLoaded ? "opacity-100" : "opacity-0",
          )}
        />
      )}
    </div>
  );
}

export default Artwork;

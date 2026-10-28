import { preferenceStorage } from "./preferenceStorage";
import { useCallback, useEffect, useRef, useState } from "react";
import type { PointerEvent as ReactPointerEvent } from "react";

export interface UseResizableOptions {
  direction: "horizontal" | "vertical";
  initial: number;
  min: number;
  max: number;
  storageKey?: string;
  /**
   * If true, dragging in the negative direction (left/up) INCREASES the size.
   * Typical for right-docked sidebars (drag handle is on left)
   * or bottom-docked players (drag handle is on top).
   */
  reverse?: boolean;
}

export function useResizable({
  direction,
  initial,
  min,
  max,
  storageKey,
  reverse = false,
}: UseResizableOptions) {
  const [size, setSize] = useState<number>(() => {
    if (typeof window === "undefined" || !storageKey) return initial;
    try {
      const stored = preferenceStorage.getItem(storageKey);
      if (stored !== null) {
        const parsed = Number(stored);
        if (!Number.isNaN(parsed) && parsed >= min && parsed <= max) {
          return parsed;
        }
      }
    } catch {
      /* ignore storage error */
    }
    return initial;
  });

  const [isDragging, setIsDragging] = useState(false);
  const sizeRef = useRef(size);
  sizeRef.current = size;

  const persist = useCallback(
    (newSize: number) => {
      if (!storageKey || typeof window === "undefined") return;
      try {
        preferenceStorage.setItem(storageKey, String(newSize));
      } catch {
        /* ignore */
      }
    },
    [storageKey],
  );

  const reset = useCallback(() => {
    setSize(initial);
    persist(initial);
  }, [initial, persist]);

  const onPointerDown = useCallback(
    (e: ReactPointerEvent) => {
      // Primary button only
      if (e.button !== 0) return;
      e.preventDefault();
      e.stopPropagation();

      setIsDragging(true);
      const startCoord = direction === "horizontal" ? e.clientX : e.clientY;
      const startSize = sizeRef.current;

      const cursor = direction === "horizontal" ? "col-resize" : "row-resize";
      document.body.style.cursor = cursor;
      document.body.style.userSelect = "none";

      let latestSize = startSize;

      function onPointerMove(ev: PointerEvent) {
        const currentCoord = direction === "horizontal" ? ev.clientX : ev.clientY;
        const delta = (currentCoord - startCoord) * (reverse ? -1 : 1);
        const clamped = Math.round(Math.max(min, Math.min(max, startSize + delta)));
        latestSize = clamped;
        setSize(clamped);
      }

      function onPointerUp() {
        window.removeEventListener("pointermove", onPointerMove);
        window.removeEventListener("pointerup", onPointerUp);
        document.body.style.cursor = "";
        document.body.style.userSelect = "";
        setIsDragging(false);
        persist(latestSize);
      }

      window.addEventListener("pointermove", onPointerMove);
      window.addEventListener("pointerup", onPointerUp);
    },
    [direction, min, max, reverse, persist],
  );

  // Sync back to storage whenever size changes externally if needed
  useEffect(() => {
    sizeRef.current = size;
  }, [size]);

  return {
    size,
    setSize,
    isDragging,
    reset,
    handleProps: {
      onPointerDown,
      onDoubleClick: reset,
    },
  };
}

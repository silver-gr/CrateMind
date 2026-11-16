import { useRef, useState, type DragEvent } from "react";
import type { Track } from "./types";

/** Drag a track (Library table, Set Builder list) onto a deck to load it. */
export const TRACK_DRAG_TYPE = "application/x-cratemind-track";

// dataTransfer only carries strings, and only on drop; the Track itself stays here while it is dragged.
let dragged: Track | null = null;

export function startTrackDrag(e: DragEvent, track: Track) {
  dragged = track;
  e.dataTransfer.effectAllowed = "copy";
  e.dataTransfer.setData(TRACK_DRAG_TYPE, String(track.id));
  e.dataTransfer.setData("text/plain", [track.artist, track.title || track.file_name].filter(Boolean).join(" — "));
  // A small chip instead of the browser's ghost of the whole row.
  const chip = document.createElement("div");
  chip.textContent = track.title || track.file_name;
  chip.style.cssText = "position:fixed;top:-100px;left:-100px;max-width:240px;padding:6px 10px;border-radius:10px;"
    + "font:500 12px system-ui,sans-serif;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;"
    + "background:#0b1220;color:#e6f6ff;border:1px solid rgba(34,211,238,.6)";
  document.body.appendChild(chip);
  e.dataTransfer.setDragImage(chip, 12, 12);
  setTimeout(() => chip.remove(), 0);
}

export function endTrackDrag() {
  dragged = null;
}

const isTrackDrag = (e: DragEvent) => Array.from(e.dataTransfer.types).includes(TRACK_DRAG_TYPE);

/** Drop-zone handlers for a deck; `over` is true while a dragged track hovers it. */
export function useTrackDrop(onDropTrack: (track: Track) => void) {
  const [over, setOver] = useState(false);
  const depth = useRef(0); // dragenter/dragleave also fire for every child
  const handlers = {
    onDragEnter: (e: DragEvent) => {
      if (!isTrackDrag(e)) return;
      e.preventDefault();
      depth.current += 1;
      setOver(true);
    },
    onDragOver: (e: DragEvent) => {
      if (!isTrackDrag(e)) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = "copy";
    },
    onDragLeave: (e: DragEvent) => {
      if (!isTrackDrag(e)) return;
      depth.current = Math.max(0, depth.current - 1);
      if (depth.current === 0) setOver(false);
    },
    onDrop: (e: DragEvent) => {
      if (!isTrackDrag(e)) return;
      e.preventDefault();
      depth.current = 0;
      setOver(false);
      const track = dragged && String(dragged.id) === e.dataTransfer.getData(TRACK_DRAG_TYPE) ? dragged : null;
      dragged = null;
      if (track) onDropTrack(track);
    },
  };
  return { over, handlers };
}

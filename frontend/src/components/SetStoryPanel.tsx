import { useEffect, useState } from "react";
import { api } from "../lib/api";
import { describeSetStory, type SetStoryText } from "../lib/setStory";
import { GlassPanel } from "./ui/GlassPanel";
import { SectionHeader } from "./ui/SectionHeader";

/** «Η αφήγηση του set»: what the set's tempo plateaus say, read again whenever `refreshKey` changes. */
export default function SetStoryPanel({ setId, refreshKey }: { setId: number | null; refreshKey: unknown }) {
  // Kept with the set it was read for, so another set's story never shows while the new one loads.
  const [story, setStory] = useState<{ setId: number; text: SetStoryText } | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    if (setId === null || !refreshKey) { setStory(null); setFailed(false); return; }
    let alive = true;
    api.setStory(setId).then(reading => {
      if (!alive) return;
      setStory({ setId, text: describeSetStory(reading) });
      setFailed(false);
    }).catch(() => { if (alive) setFailed(true); });
    return () => { alive = false; };
  }, [setId, refreshKey]);

  if (setId === null || !refreshKey) return null;
  const text = story?.setId === setId ? story.text : null;
  return (
    <GlassPanel className="p-4">
      <SectionHeader>Η αφήγηση του set</SectionHeader>
      {failed ? (
        <p className="text-xs text-cm-faint">Η αφήγηση δεν φορτώθηκε. Δοκίμασε ξανά σε λίγο.</p>
      ) : !text ? (
        <p className="text-xs text-cm-faint">Διαβάζω το set…</p>
      ) : (
        <div className="space-y-3">
          <p className="text-sm font-medium text-cm-text">{text.summary}</p>
          {text.chapters.length > 0 && (
            <ol className="space-y-2.5">
              {text.chapters.map(chapter => (
                <li key={chapter.title} className="space-y-0.5 border-l-2 border-cm-cyan/30 pl-2.5">
                  {chapter.entry && <p className="text-xs text-cm-muted">{chapter.entry}</p>}
                  <p className="text-[11px] text-cm-faint">{chapter.title}</p>
                  <p className="text-sm leading-snug text-cm-text">{chapter.body}</p>
                  {chapter.drift && <p className="text-xs leading-snug text-cm-muted">{chapter.drift}</p>}
                </li>
              ))}
            </ol>
          )}
          {text.notes.length > 0 && (
            <ul className="space-y-1 text-xs leading-snug text-cm-muted">
              {text.notes.map(note => <li key={note}>{note}</li>)}
            </ul>
          )}
          {text.chapters.length > 0 && (
            <p className="text-[11px] text-cm-faint">Οι χρόνοι είναι περίπου: στη μίξη τα tracks πατάνε το ένα πάνω στο άλλο.</p>
          )}
        </div>
      )}
    </GlassPanel>
  );
}

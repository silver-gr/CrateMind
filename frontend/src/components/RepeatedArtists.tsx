const colors = ["cyan", "chartreuse", "violet", "blue", "amber"] as const;

export default function RepeatedArtists({ artists }: { artists: Record<string, number> }) {
  const entries = Object.entries(artists);
  if (!entries.length) return null;
  return (
    <div className="mt-3 flex flex-wrap items-center gap-1.5">
      <span className="text-[11px] text-cm-faint">Επανάληψη:</span>
      {entries.map(([artist, count], index) => {
        const color = `var(--color-cm-${colors[Math.floor(index / 2) % colors.length]})`;
        const alternate = index % 2 === 1;
        return (
          <span key={artist} className="inline-flex max-w-full items-center gap-1 rounded-full border px-2 py-0.5 text-[11px]"
            style={{
              backgroundColor: `color-mix(in oklch, ${color} ${alternate ? 22 : 12}%, transparent)`,
              borderColor: `color-mix(in oklch, ${color} ${alternate ? 45 : 28}%, transparent)`,
              // The text token is light in dark mode and dark in light mode.
              color: `color-mix(in oklch, ${color} ${alternate ? 65 : 85}%, var(--color-cm-text))`,
            }}>
            <span className="truncate" title={artist}>{artist}</span>
            <span className="shrink-0 font-semibold tabular-nums">×{count}</span>
          </span>
        );
      })}
    </div>
  );
}

## CrateMind — "Psy Void Neon" Design System

Always-dark, glassy, aurora-lit cockpit for DJ workflows. OKLCH color tokens, glass surfaces with backdrop-filter, neon accent glows.

### Setup

No provider wrapper needed. Components are self-contained. The root element must have `class="dark"` and a dark background for the theme to render correctly:

```jsx
<div className="dark" style={{ background: 'var(--color-cm-bg)', color: 'var(--color-cm-text)', minHeight: '100vh' }}>
  {/* your layout */}
</div>
```

### Styling idiom — Tailwind utility classes

Style via Tailwind classes. The DS defines two token families:

**`cm-*` palette** (surfaces, ink, accents — use as `bg-cm-*`, `text-cm-*`, `border-cm-*`):

| Token | Role |
|---|---|
| `cm-bg`, `cm-bg-2` | Deep void surfaces |
| `cm-panel`, `cm-panel-2` | Elevated card/panel surfaces |
| `cm-line` | Subtle dividers |
| `cm-text` | Primary text |
| `cm-muted` | Secondary text |
| `cm-faint` | Tertiary/disabled text |
| `cm-cyan` | Primary accent (actions, focus rings) |
| `cm-blue` | Secondary accent |
| `cm-violet` | Tertiary accent |
| `cm-magenta` | Highlight accent |
| `cm-chartreuse` | Success/energy accent |
| `cm-amber` | Warning accent |
| `cm-rose` | Destructive accent |

**Shadcn semantic tokens** (use as `bg-primary`, `text-muted-foreground`, `border-input`, etc.):
`background`, `foreground`, `card`, `primary`, `secondary`, `muted`, `accent`, `destructive`, `border`, `input`, `ring` — all mapped to cm-* values.

**Custom utilities** (apply directly as class names):
- `glass` — translucent panel with backdrop-blur and subtle border/shadow
- `glass-strong` — heavier glass for prominent panels
- `lift` — adds hover-lift transition
- `glow-cyan`, `glow-chartreuse`, `glow-violet` — neon box-shadow accents

### Where the truth lives

Read `_ds/styles.css` and its imports (`_ds_bundle.css`, `fonts/fonts.css`) for the full token set and utility definitions. Each component's `.d.ts` and `.prompt.md` document its API.

### Example

```jsx
<div className="dark min-h-screen bg-cm-bg text-cm-text p-8">
  <GlassCard className="p-6 max-w-md" interactive spotlight>
    <h2 className="text-lg font-semibold text-cm-text mb-2">Track Analysis</h2>
    <p className="text-sm text-cm-muted mb-4">Energy and harmonic profile</p>
    <div className="flex items-center gap-4">
      <EnergyMeter value={7} metric="energy" />
      <Badge variant="outline">128 BPM</Badge>
      <StatusBadge status="approved" />
    </div>
    <div className="mt-4 flex gap-2">
      <Button size="sm">Approve</Button>
      <Button variant="ghost" size="sm">Skip</Button>
    </div>
  </GlassCard>
</div>
```

Fonts: Inter Variable (body) and JetBrains Mono (code/numbers). Both ship in `fonts/`.

# CrateMind Therapy Phase B Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship Phase B of the music-therapy roadmap:
- BPM analysis with a selectable tempo window per profile, music folder and crate;
- a manual «×½ / ×2» BPM fix in both profiles;
- the Library facet filter panel;
- the arousal × valence map;
- the therapy dashboard.

**Architecture:**
- **Tempo windows:** a registry in `services/tempo_ranges.py` (pure, no DSP) names four windows.
  - The DJ windows run the existing multi-lag scorer on a parameterised grid.
  - The therapy window runs a new wide estimator ("final-A", picked by a prototype panel, judges and skeptics on 900+ synthetic cases).
  - Every analysis request carries a window key plus a per-folder map. A temp JSON "analysis plan" carries them to the spawned child, so spawn arguments stay constant-size.
- **Manual BPM:** stored as a manual consensus (`manual:octave`), which already wins everywhere BPM is shown, searched or exported. The numpy-only consensus helpers move to `services/bpm_consensus.py` so the desktop API process can recompute without loading the DSP stack.
- **B1–B3:** frontend only, on Phase A's grammar, facets and profile helpers.

**Tech Stack:** FastAPI, SQLModel, SQLite, numpy/scipy/librosa (analysis child only), pytest (uv) / React 19, TypeScript, Vite, bun test, Tauri sidecar (PyInstaller).

**Spec:** `docs/superpowers/specs/2026-11-02-music-therapy-design.md`, Phase B. B4 was rewritten on 2026-11-03 with the decisions below. Read it with this plan.

## Decisions taken with the user (2026-11-02/03)

1. **DJ windows** for the multi-lag scorer. Only explicit actions apply a non-default window.
   - `psy` 133–286 (the new default, was 135–286)
   - `mixed` 118–250 (mixed 4/4)
   - `slow` 70–125 (downtempo, slow psy)
2. **Therapy window** `therapy` 40–240 on the wide estimator. 6/8 reports the dotted-quarter pulse; 3/4 reports the beat, not the bar. No clear tempo means no value, never a confident guess.
3. **Where a window applies:**
   - per music folder (Ρυθμίσεις, DJ profile);
   - per crate («Ανάλυση BPM» on a crate);
   - per Library selection or search (bulk bar).

   Precedence: an explicit scope's window, then the folder window, then the profile default. The therapy profile always uses `therapy`.
4. **Manual fix:** «×½ / ×2» in both profiles, in three places: the deck BPM chip, the «Ουρά tagging» hero chip and the Library side card. A reset returns to the automatic value.
5. **Facet panel logic:** two values of one vocabulary are ANDed, as the grammar does today, and the counts are conjunctive. OR within a facet is a recorded follow-up; build the toggle helper so OR can be added later.

## Global Constraints

- **Data safety:**
  - Analysis writes only `bpm_analyzed*`, `key_analyzed*`, `analyzed_at`, `analysis_error` and the consensus columns.
  - The manual fix writes only `bpm_consensus`, `bpm_consensus_sources` and `bpm_needs_review`, plus one audit row. Its reset re-runs `_refresh_consensus`, which also rewrites `bpm_disagreement` and `bpm_disagreement_percent`.
  - Nothing touches tags, audio files or djay data. Stored values change only through an analysis job or a manual fix the user starts.
- **DJ default change is intentional.** `psy` moves the grid floor from 135 to 133; pin it with golden tests (Task 2). Values already stored do not change until the user re-analyses.
- **Desktop API process:** never import `scipy`, `librosa`, `essentia`, `app.services.audio_analysis` or `app.api.analysis` (the `bootstrap.py:116-118` forbidden list, `test_desktop_profile.py:12-30`). New API-side code may import only `services/tempo_ranges.py` and `services/bpm_consensus.py` (numpy only).
- **Windows spawn:**
  - Spawn arguments stay constant-size. Track ids, the window key and the folder map travel in the temp JSON plan file (the `_write_track_ids` pattern, `worker.py:209-222`).
  - Phase B adds no new subprocess. Any future one needs `stdin=DEVNULL` / the `desktop_runtime/std_handles.py` isolation, or Windows hangs at startup.
- **Web providers:** scoped analysis jobs (`track_ids` or `query`) are primary-only (`local_only=True`) and never call Essentia, ReccoBeats, GetSongBPM or Cyanite.
- **Routes:** GET/POST/DELETE only. Each new route goes in `FOLLOWUP_ROUTES` in `scripts/desktop/check_parity_inventory.py` with an owner and an existing pytest oracle (template: the downbeat entries, lines 82-103). Phase B needs no schema change: confirm `generate_schema_contract.py --check` is unchanged.
- **Prefs:**
  - New prefs are fields of the existing single `cratemind:prefs:v1` blob (`prefs.ts:80`). They are not new storage keys, so the desktop 128-key cap (`preferenceStorage.ts:39-41`) is not touched.
  - Validate stored window keys against the registry before sending them, so a stale value never causes a 422.
- **Execution order:**
  - Backend Tasks 1→5 run strictly in order; they share `audio_analysis.py`, `worker.py` and `schemas.py`.
  - Frontend Tasks 6→7→8 run strictly in order, never as parallel subagents; they share `api.ts`, `types.ts`, `prefs.ts` and `Library.tsx`.
  - Tasks 9 and 10 are independent of each other and of 6–8.
- **Greek UI copy:** never show method strings, window keys, facet keys or English reason codes.
- **Hot files:**
  - `MiniPlayer.tsx` gets one import and one JSX insertion only. The load effect stays keyed on `[current?.id, token, autoPlay]` (`MiniPlayer.tsx:369`).
  - `EnergyMaps.tsx` keeps `useGSAP` with `{ scope: containerRef }` and no `dependencies` (the 0.2.1 reveal fix).
- **Commits:**
  - Imperative intent-style subject. Stage the task's files by explicit path, never `git add -A`.
  - Main moves under parallel sessions: run `git status -sb` and `git log --oneline -3` before each commit.
  - Attribution trailers.
- **Commands:**
  - `cd backend && uv run pytest tests/<file>::<name> -v`
  - `cd frontend && bun test tests/<file>`
  - `bun run build` (type check plus build)
  - `bun run build:desktop`

## Review Focus

Failure modes the spec implies but no spec test pins; each has a test in the task named.

1. **«×½» on a deck that is playing** halves the shown BPM, Sync and new loop lengths without restarting playback. A fast double click must not compound to ×4 (Tasks 5, 7).
2. **A therapy track with no clear tempo** (ambient, voice) stores no BPM and no error. «Μόνο νέα» must not retry it forever (Task 3).
3. **«Ανάλυση BPM» on 5,000 tracks on Windows:** the spawn payload stays constant-size, progress shows, and quitting stops the child (Task 4).
4. **A mixed library with nested and Windows-style music folders:** the longest folder prefix wins, and `C:\Music\Down` must not match `C:\Music\Downtempo\…`. Case and separators fold (Task 4).
5. **The facet panel on a typed accentless token** (`purpose:χαλαρωση`): it shows «χαλάρωση» as active, a click removes it rather than adding a duplicate, and single-value facets act as radios (Task 8).

## File Structure

**Backend** (`backend/app/`):
- Create:
  - `services/tempo_ranges.py`: window registry, method strings, `fold_into`, `resolve_track_range`.
  - `services/bpm_consensus.py`: numpy-only consensus helpers, moved from `audio_analysis.py`.
- Modify:
  - `services/audio_analysis.py`: parameterised multi-lag grid, wide estimator, `NoClearTempo`, window plumbing.
  - `schemas.py`; `api/scan.py`; `jobs/worker.py`.
  - `api/tracks.py`: manual BPM routes.
  - `desktop_runtime/spawn_probe.py` and `desktop_runtime/bootstrap.py`: window method, therapy probe.
- Modify outside `app/`: `scripts/desktop/smoke_installed.py`, `scripts/desktop/check_parity_inventory.py`.
- Tests:
  - create `tests/test_tempo_ranges.py`, `tests/test_tempo_wide.py`, `tests/test_tempo_range_plumbing.py`, `tests/test_manual_bpm.py`, `tests/test_bpm_consensus_module.py`;
  - edit `tests/test_audio_analysis.py`, `tests/test_desktop_analysis.py`, `tests/test_effective_bpm.py`.

**Frontend** (`frontend/src/`):
- Create:
  - `lib/tempoRanges.ts`; `lib/bpmUpdates.ts`; `lib/energyMapAxes.ts`; `lib/dashboardTherapy.ts`;
  - `components/BpmOctaveButtons.tsx`, `components/AnalyzeBpmDialog.tsx`, `components/FacetFilterPanel.tsx`.
- Modify:
  - `lib/{prefs,api,types,tempo,queryGrammar,queryChips,queuePaging}.ts`, `lib/player.tsx`;
  - `pages/{Settings,Library,Crates,TaggingQueue,EnergyMaps,Dashboard}.tsx`;
  - `components/{BulkTagBar,ProfileEditor,MiniPlayer}.tsx`, `components/layout/Sidebar.tsx`.
- Tests: `tests/{tempoRanges,bpmUpdates,facetPanel,energyMapAxes,dashboardTherapy}.test.ts`, plus edits to `deckSlots`, `queuePaging`, `tempo` and `facetUi`.

**Docs:**
- `docs/README.md`: «Εύρος BPM», «Διόρθωση BPM», «Φίλτρα».
- The spec: B4 decisions plus the OR follow-up.

## Shared Interfaces (defined once; later tasks reuse these exact names)

**`services/tempo_ranges.py`** (pure; imports only stdlib and `dataclasses`):

```python
TempoRangeKey = Literal["psy", "mixed", "slow", "therapy"]
DjRangeKey = Literal["psy", "mixed", "slow"]

@dataclass(frozen=True)
class TempoRange:
    key: str
    lo: float
    hi: float
    estimator: Literal["multilag", "wide"]
    method: str                    # stored in Track.bpm_analyzed_method
    fallback_method: str | None    # multilag windows only

TEMPO_RANGES: dict[str, TempoRange]
#   psy     133-286 multilag  "librosa-onset-multilag-v2@133-286"  fallback "ffmpeg+onset-autocorr-v1@133-286"
#   mixed   118-250 multilag  "librosa-onset-multilag-v2@118-250"  fallback "ffmpeg+onset-autocorr-v1@118-250"
#   slow     70-125 multilag  "librosa-onset-multilag-v2@70-125"   fallback "ffmpeg+onset-autocorr-v1@70-125"
#   therapy  40-240 wide      "librosa-onset-wide-v1@40-240"       fallback None
DEFAULT_TEMPO_RANGE = "psy"

def get_range(key: str) -> TempoRange                     # ValueError("unknown tempo range") on a bad key
def range_for_method(method: str | None) -> TempoRange | None  # registered method or fallback -> its range; anything else -> None (pre-Phase-B rows)
def fold_into(bpm: float, lo: float, hi: float) -> float  # bpm*2**k (|k|<=4) inside [lo, hi]; if none fits, the closest in log distance
def resolve_track_range(path: str, default: str, root_ranges: Mapping[str, str]) -> str
# path must be the CONNECTED path, str(resolve_source_path(track.absolute_path)), not the logical one stored
# in Track.absolute_path. root_ranges keys are the connected root strings that Settings lists
# (settings.library_roots).
# Path and roots: "\\" -> "/", casefold, roots end with "/". The longest root prefix wins; no match -> default.
# default == "therapy" ignores root_ranges.
```

**`services/bpm_consensus.py`** (numpy only):
- Moved verbatim from `audio_analysis.py`: `HALF_TEMPO_THRESHOLD`, `_corrected_bpm`, `bpm_disagreement`, `_octave_adjusted`, `bpm_consensus`, `_refresh_consensus`. `audio_analysis.py` re-exports every name.
- Task 2 then extends two of them:
  - `bpm_consensus(votes, threshold_percent, window: TempoRange | None = None)`: `window is None` keeps `_corrected_bpm(median)`; otherwise `fold_into(median, window.lo, window.hi)`.
  - `_refresh_consensus(track, threshold_percent)` passes `range_for_method(track.bpm_analyzed_method)`.

**`services/audio_analysis.py`:**

```python
BPM_METHOD = TEMPO_RANGES["psy"].method               # "librosa-onset-multilag-v2@133-286"; spawn_probe and tests follow it
FALLBACK_METHOD = TEMPO_RANGES["psy"].fallback_method  # "ffmpeg+onset-autocorr-v1@133-286"
class NoClearTempo(RuntimeError):
    def __init__(self, confidence: float): ...   # message "no clear tempo"; .confidence kept
THERAPY_CONF_GATE = 0.18
def _estimate_bpm_librosa(audio, lo: float = 133.0, hi: float = 286.0) -> tuple[float, float]   # grid np.arange(lo, hi + 0.001, 0.02)
def _estimate_bpm_wide(audio, lo: float = 40.0, hi: float = 240.0) -> tuple[float, float]       # final-A; raises NoClearTempo below the gate
def estimate_bpm(audio, tempo_range: TempoRange = TEMPO_RANGES["psy"]) -> tuple[float, float, float, str]  # (bpm, raw, conf, method)
def estimate_file_bpm(path, intro_audio, tempo_range: TempoRange = TEMPO_RANGES["psy"]) -> tuple[float, float, float, str]
def analyze_file(path, *, run_primary=True, run_essentia=True, tempo_range: TempoRange = TEMPO_RANGES["psy"]) -> AnalysisResult
def analyze_all(session, *, force=False, limit=None, job=None, only_unprocessed=False, track_ids=None,
                local_only=False, tempo_range: str = "psy", root_ranges: Mapping[str, str] | None = None) -> dict
```

**Requests** (`schemas.py`):
- `ScanRequest` adds:
  - `tempo_range: TempoRangeKey = "psy"`
  - `root_ranges: dict[str, DjRangeKey] = {}`
- `AnalyzeRequest` adds the same two fields, plus:
  - `track_ids: list[int] | None = None`
  - `query: str | None = None`
  - `dry_run: bool = False`
- **Scope rules,** the same as `BatchProfileUpdate` (`schemas.py:97`):
  - a scope is `track_ids` XOR `query`, resolved by `bulk_edit._scope_ids` (`bulk_edit.py:19-24`);
  - `query: ""` means the whole library (BulkTagBar sends exactly that when nothing is selected, `BulkTagBar.tsx:51`);
  - a request with both is a 422;
  - tracks with `missing == True` are excluded from the scope and from the dry-run count.

**Worker:**
- `write_analysis_plan(plan: dict) -> str` and `read_analysis_plan(path) -> dict`. The read side takes the dict format only; the temp files never cross versions.
- `start_analyze(job_id, force=False, limit=None, plan_path=None) -> bool`.
- `start_scan(job_id, roots, mode="full", tempo_range="psy", root_ranges=None)`.

**Manual BPM routes** (tracks router; both runtimes):
- `POST /api/tracks/{track_id}/bpm` with body `{"factor": 0.5 | 2}`.
- `DELETE /api/tracks/{track_id}/bpm`.
- Both return `{"track_id", "bpm_consensus", "bpm_consensus_sources", "effective_bpm"}`.
- The source string is `"manual:octave"`; the audit action is `"bpm_manual_update"`.

**Frontend:**

```ts
// lib/tempoRanges.ts
export type TempoRangeKey = "psy" | "mixed" | "slow" | "therapy";
export type DjRangeKey = Exclude<TempoRangeKey, "therapy">;
export const TEMPO_RANGE_LABELS: Record<TempoRangeKey, string>;   // «Psy / hi-tech (133–286)», «Μικτό 4/4 (118–250)», «Αργά / downtempo (70–125)», «Μουσικοθεραπεία (40–240)»
export function activeTempoRange(): TempoRangeKey;                 // therapy profile -> "therapy", else getPref("djTempoRange")
export function activeRootRanges(): Record<string, DjRangeKey>;    // therapy -> {}, else getPref("tempoRangeByRoot")
export function methodLabel(method?: string | null): string | null;  // Greek; never the raw string
// prefs.ts adds djTempoRange: DjRangeKey = "psy"; tempoRangeByRoot: Record<string, DjRangeKey> = {}

// lib/bpmUpdates.ts
export const BPM_UPDATED = "cratemind:bpm-updated";   // CustomEvent<{ trackId: number; fields: BpmFields }>
export type BpmFields = Pick<Track, "bpm_consensus" | "bpm_consensus_sources">;
export function applyBpmFields<T extends Track>(track: T, fields: BpmFields): T;
export function notifyBpmUpdated(trackId: number, fields: BpmFields): void;

// api.ts
startScan(roots?, mode?, opts?: { tempoRange: TempoRangeKey; rootRanges: Record<string, DjRangeKey> })
startAnalyze(opts?: { force?; limit?; tempoRange?; rootRanges?; trackIds?: number[]; query?: string }): Promise<Job>
analyzeDryRun(opts: { tempoRange: TempoRangeKey; trackIds?: number[]; query?: string }): Promise<{ matched: number }>
setBpmOctave(trackId: number, factor: 0.5 | 2): Promise<BpmUpdate>
resetBpm(trackId: number): Promise<BpmUpdate>
```

---

### Task 1: Move the consensus helpers into a DSP-free module (refactor)

**Files:**
- Create: `backend/app/services/bpm_consensus.py`, `backend/tests/test_bpm_consensus_module.py`.
- Modify: `backend/app/services/audio_analysis.py:59, 217-221, 350-458`.

**Interfaces:**
- Produces: `services/bpm_consensus.py`, with every name from Shared Interfaces moved verbatim.
- Consumes: nothing new.

- [ ] **Step 1: Write the failing tests** in `test_bpm_consensus_module.py`:
  - `test_consensus_module_imports_without_dsp`: a subprocess runs `import app.services.bpm_consensus, sys`. It asserts that none of `scipy`, `librosa`, `essentia` or `app.services.audio_analysis` is in `sys.modules`.
  - `test_audio_analysis_reexports_the_same_objects`: for each moved name, `getattr(aa, name) is getattr(bc, name)`.
- [ ] **Step 2: Run it.** `uv run pytest tests/test_bpm_consensus_module.py -v` must FAIL (module missing).
- [ ] **Step 3: Move the code verbatim.** Cut the code (lines 59, 217-221 and 350-458) into the new module and re-export it from `audio_analysis.py` with `from .bpm_consensus import ...`.
  - First grep the tests for `monkeypatch.setattr(aa, "<moved name>"`.
  - For each hit, patch `bpm_consensus` instead (calls inside the moved module resolve there).
- [ ] **Step 4: Run** `uv run pytest tests/test_bpm_consensus_module.py tests/test_audio_analysis.py tests/test_effective_bpm.py -v`. All must PASS, existing consensus tests unchanged.
- [ ] **Step 5: Commit** "Move the BPM consensus helpers into a module the desktop API process can import".

### Task 2: DJ windows on the multi-lag scorer, window-aware fallback and consensus

**Files:**
- Create: `backend/app/services/tempo_ranges.py`, `backend/tests/test_tempo_ranges.py`.
- Modify:
  - `backend/app/services/audio_analysis.py:113-141` (grid parameters), `:224-261` (estimate_bpm / estimate_file_bpm);
  - `backend/app/services/bpm_consensus.py`;
  - `backend/tests/test_audio_analysis.py`.

**Interfaces:**
- Produces: `tempo_ranges.py` (all of it); `_estimate_bpm_librosa(audio, lo, hi)`; `estimate_bpm(audio, tempo_range)` and `estimate_file_bpm(path, intro, tempo_range)` for multilag windows; `bpm_consensus(..., window)`.
- Consumes: Task 1's module.

- [ ] **Step 1: Capture golden values before any edit.** Use a test helper `click_track(bpm, seconds, sr=22050)` (impulses plus a short decaying noise burst, `np.random.default_rng(int(bpm*100))`) and a `rolling_psy(bpm)` helper (kick on every beat, bass on the three off-beat 16ths). Run the **current** `aa._estimate_bpm_librosa` on clicks at 60, 120 and 140 and on rolling psy at 142, and paste the tuples into the test as literals.
- [ ] **Step 2: Write the failing tests:**
  - `test_tempo_ranges.py`:
    - `test_registry_and_methods`: the exact windows and method strings from Shared Interfaces.
    - `test_range_for_method_roundtrip`: each method and fallback method maps back; legacy strings and `None` map to `None`.
    - `test_fold_into`:
      - `(62, 133, 286) -> 248`
      - `(300, 133, 286) -> 150`
      - `(130, 70, 125) -> 130` (no octave fits; closest)
      - `(100, 40, 240) -> 100`
    - `test_resolve_track_range`, with roots `{"/Music/Downtempo": "slow", "/Music": "mixed"}`:
      - `/Music/Downtempo/a.mp3` → slow
      - `/Music/House/b.mp3` → mixed
      - `/Other/c.mp3` → default
      - `C:\Music\Downtempo\x.flac` with root `c:/music/downtempo` → slow
      - root `/Music/Down` does not match `/Music/Downtempo/a.mp3`
      - default `therapy` ignores the roots
  - `test_audio_analysis.py`:
    - `test_multilag_with_legacy_grid_matches_golden`: `_estimate_bpm_librosa(x, 135, 286)` equals the Step 1 tuples exactly.
    - `test_psy_window_reads_133`: click 133 → 133 ± 0.3 (legacy read 266).
    - `test_mixed_window_reads_house`: click 124 → 124 ± 0.3.
    - `test_slow_window_reads_downtempo`: click 90 → 90 ± 0.3.
    - `test_estimate_bpm_method_carries_window`: `estimate_bpm(x, TEMPO_RANGES["mixed"])[3] == "librosa-onset-multilag-v2@118-250"`, and corrected == raw.
    - `test_fallback_folds_into_window`: monkeypatch `_estimate_bpm_librosa` to raise RuntimeError and `_estimate_bpm_autocorr` to return `(100.0, 0.5)`. psy gives `(200.0, 100.0, 0.5, "ffmpeg+onset-autocorr-v1@133-286")`; slow gives 100.0.
    - `test_section_median_keeps_window_methods`: the refined filter at `:254` becomes `r[3] != tempo_range.fallback_method`.
    - `test_consensus_folds_into_window`: `bpm_consensus([("local", 60.0), ("essentia", 120.0)], 5.0, window=TEMPO_RANGES["therapy"])[0] == 60.0`, while `window=None` still gives 120.0.
    - `test_refresh_consensus_uses_the_tracks_window`.
  - The existing `test_refined_psytrance_tempos` and `test_estimate_bpm_recovers_tempo` stay unchanged and must pass. The `:37` check against `(aa.BPM_METHOD, aa.FALLBACK_METHOD)` holds because those constants now name the psy window.
  - Update the two existing monkeypatched lambdas so they accept the forwarded window:
    - `test_audio_analysis.py:179` becomes `lambda path, audio, *_, **__:`;
    - `test_audio_analysis.py:247` becomes `lambda audio, *_, **__:`.
- [ ] **Step 3: Run the tests.** They must FAIL.
- [ ] **Step 4: Implement:**
  - Set `BPM_METHOD` and `FALLBACK_METHOD` from the registry (Shared Interfaces).
  - Parameterise the grid: `np.arange(lo, hi + 0.001, 0.02)`.
  - For multilag windows `estimate_bpm` returns `(raw, raw, conf, range.method)`. On a librosa failure it returns `(fold_into(fallback, lo, hi), fallback, conf, range.fallback_method)`; `_corrected_bpm` is no longer called there.
  - `estimate_file_bpm` forwards the window to all three sections and the intro fallback (`:248`, `:252`).
- [ ] **Step 5: Run** `uv run pytest tests/test_tempo_ranges.py tests/test_audio_analysis.py tests/test_bpm_consensus_module.py tests/test_desktop_analysis_child.py -v`. Everything must PASS, including `test_spawn_probe_targets_run_in_process` (`:256` compares against `aa.BPM_METHOD`).
- [ ] **Step 6: Commit** "Run the DJ BPM scorer on selectable windows with psy at 133-286".

### Task 3: Therapy wide estimator (final-A) and the no-clear-tempo outcome

**Files:**
- Modify: `backend/app/services/audio_analysis.py`: add `_estimate_bpm_wide` after `_estimate_bpm_librosa`, plus `NoClearTempo`, the therapy branches and the `analyze_file` handling.
- Test: `backend/tests/test_tempo_wide.py`, with the measured synthetic generators ported into `backend/tests/tempo_signals.py` (Step 1).

**Interfaces:**
- Produces: `_estimate_bpm_wide`, `NoClearTempo`, `THERAPY_CONF_GATE`, and the therapy branches of `estimate_bpm`, `estimate_file_bpm` and `analyze_file`.
- Consumes: Task 2.

**Algorithm** (port exactly; validated at 515/537 ok, 3 non-octave, 56/56 no-tempo; reference prototype `scratchpad/phase-b/b4/final-A/estimator.py`):

```python
SR, HOP = 22050, 128; FPS = SR / HOP
WIDE_COMB_MAX = 960.0; WIDE_LOG_STEP = 2.5e-4; WIDE_MULTIPLES = 24
WIDE_HALF_PENALTY = 0.5; WIDE_ODD_PENALTY = 0.3; WIDE_PRIMES = (2, 3, 5, 7, 11)
WIDE_GROUP_ABOVE = 200.0; WIDE_ACCENT_MIN = 1.2; WIDE_PARSIMONY = 0.9; WIDE_TOL = 0.02
THERAPY_CONF_GATE = 0.18

def _wide_autocorr(audio):
    # librosa is None -> RuntimeError("librosa not available") (as _estimate_bpm_librosa:114).
    # audio = np.asarray(audio, dtype=np.float32) first.
    # RuntimeError: size < SR*10 ("audio too short for BPM analysis"); non-finite ("non-finite audio").
    # NoClearTempo(0.0): peak <= 0 (silent), and the "insufficient rhythmic evidence" case below, so onset-free
    # therapy audio is stored as "no clear tempo", not as an error.
    # mel = melspectrogram(y=audio/peak, sr=SR, hop_length=HOP);
    # env = onset_strength(S=sqrt(mel), sr=SR, hop_length=HOP); env = max(env - median(env), 0);
    # cap = percentile(env, 99); env = min(env, cap if cap > 0 else env.max());
    # ac = fftconvolve(env, env[::-1], "full")[len(env)-1:] / max(1, arange(len(env), 0, -1));
    # ac[0] <= 1e-12 or non-finite -> NoClearTempo(0.0); return ac / ac[0]

def _wide_comb(ac, periods):
    # for k in 1..24: w = 1/sqrt(k) where periods*k <= 0.5*len(ac) else 0; wsum += w;
    #   on  += w * interp(periods*k)
    #   off += w * pen(d) * mean_j interp(periods*(k - j/d)), j = 1..d-1, for d in PRIMES; pen(2)=0.5 else 0.3
    # return (on - off) / max(wsum, 1e-12)

def _at(ac, lag):  # max of ac over [floor(lag*0.98), ceil(lag*1.02)], 0.0 if out of range
def _accent(ac, period, g):  # _at(g*period) / (mean(_at(j*period) for j < g) + 1e-12)
def _clarity(ac, period):    # k = max(2, int(4*FPS // period)); clip(mean(_at(m*P) - _at((m-0.5)*P), m=1..k), 0, 1)

def _estimate_bpm_wide(audio, lo=40.0, hi=240.0):
    ac = _wide_autocorr(audio)
    grid = exp(arange(log(lo), log(WIDE_COMB_MAX), WIDE_LOG_STEP)); periods = 60*FPS/grid
    i = argmax(_wide_comb(ac, periods)); tatum, bpm = periods[i], grid[i]
    if bpm > WIDE_GROUP_ABOVE:
        accents = {g: _accent(ac, tatum, g) for g in (2, 3, 4) if bpm/g >= lo*(1-WIDE_TOL)}
        best = max(accents.values(), default=0.0)
        if best >= WIDE_ACCENT_MIN: bpm /= min(g for g, a in accents.items() if a >= WIDE_PARSIMONY*best)
    while bpm > hi: bpm /= 2
    conf = max(_clarity(ac, 60*FPS/bpm), _clarity(ac, tatum))
    if conf < THERAPY_CONF_GATE: raise NoClearTempo(round(conf, 4))
    return round(bpm, 2), round(conf, 4)
```

`import librosa` and `scipy.signal.fftconvolve` stay inside the analysis module. It is imported only by the analysis child.

- [ ] **Step 1: Port the measured generators.** The expected values below were measured on these exact synthetic generators; a new generator would need new measurements. Copy them verbatim, with their seeds, into `tests/tempo_signals.py`.
  - The sources are under `scratchpad/phase-b/b4/`; they are synthetic (numpy plus `scipy.signal`) and use no real audio.
  - From `bench.py`: `click_train`, `piano`, `psytrance`, `ambient`, plus their private helpers (`_seed`, `_place`, `_finish`, `_beat_times`, `_click`, `_piano_note`, `_kick`, `_soft_hit`, `_bass`). Seeds are `_seed(name)` with bench names such as `"click-60"`.
  - From `skeptic-rhythmic-modern/rm_signals.py`: `metronome`, `heartbeat_drum`, `house` and the helpers they call, with seeds `seed_of(name)`.
  - From `skeptic-rhythmic-modern/rm_probe.py`: `pop_68`.
  - From `skeptic-slow-acoustic/slow_acoustic.py`: `g_lull68_piano` and `g_lull34_piano_voice`, with the helpers they call.
  - Port each suite's **case builder** as well as its raw generators: the function that turns a case name into the measured signal. That includes the name-seeded finishing and noise floor (`slow_acoustic.py:923`) and the crop rule for the 30 s case (`run.py:105` crops the finished 60 s signal). Check the same for `run_rm.py` and `bench.signals`, and keep the exact case names the measurements used (e.g. `met-116-acc2-strong`, `lull68-piano-dq56`).
- [ ] **Step 2: Write the failing tests** in `test_tempo_wide.py`. Unless stated, each runs at 60 s and 30 s and expects the measured value within 2% (source: `final-A/scoreboard_final1.json` and the skeptic `results_*.json` files).
  - `test_spec_clicks_50_60_72`: `click_train` at 50, 60 and 72. `estimate_bpm(x, TEMPO_RANGES["therapy"])` returns `bpm == raw` and method `"librosa-onset-wide-v1@40-240"`.
  - `test_slow_music_and_floor`: `piano` 60 and 72; `click_train` 40 → 40.
  - `test_fast_stays_fast`:
    - `house(128, …, "minimal")` → 128 (measured 128.01);
    - `house(124, …, "minimal")` → 124;
    - `psytrance` 142 → 142.
  - `test_six_eight_reports_dotted_quarter`:
    - `pop_68` at 50 and 70 → 50 and 70 (measured 50.01 and 69.99);
    - `g_lull68_piano` at dotted quarter 56 → 56;
    - never ×3.
  - `test_waltz_reports_beat`:
    - `metronome(120, every=3)` → 120 (measured 119.99), never 40;
    - `g_lull34_piano_voice` 72 → 72.
  - `test_heartbeat`: `heartbeat_drum` 60 and 72 → 60 and 72, with confidence ≥ the gate (measured 0.850 and 0.820).
  - `test_gait_metronome`: `metronome(116, every=2, accent_db=12)` → 116 (measured 116.0), never 58.
  - `test_no_clear_tempo`: `ambient` (bench) and white noise (`default_rng(1).standard_normal(SR*60) * 0.1`) raise `NoClearTempo`; all zeros raise `NoClearTempo` too.
  - `test_invalid_input`: 9.99 s, one NaN and one Inf raise a plain `RuntimeError`, never librosa's `ParameterError`.
  - `test_click_sweep`: `click_train` at every bench tempo (40, 45, 50, 55, 60, 66, 72, 80, 90, 100, 110, 120, 128, 135, 140, 145, 150, 160, 175, 190) → within 2% (measured 34/34 on the bench).
  - `test_deterministic`: two calls give equal tuples.
  - `test_therapy_never_falls_back`: monkeypatch `_estimate_bpm_wide` to raise `RuntimeError("x")`; `estimate_bpm(x, therapy)` raises and never calls `_estimate_bpm_autocorr`.
  - `test_file_bpm_skips_unclear_sections`: monkeypatch `decode_audio`. The order is fixed:
    1. If any section succeeded → the median of the successful sections.
    2. Else, if any section raised `NoClearTempo` → re-raise the one with the highest confidence, without re-running the intro.
    3. Else → today's intro fallback.

    Cases: clicks60 / ambient / clicks60 → 60; all ambient → `NoClearTempo` with the highest section confidence.
  - `test_therapy_consensus_never_masks_local`. For a track whose `bpm_analyzed_method` is the therapy method, `_refresh_consensus` accepts only a cluster that includes the `local` vote; with no local value, the consensus is None:
    - local 60 with stored Essentia 180 and ReccoBeats 180 → consensus None, effective 60;
    - local 60 with Essentia 120 → consensus 60;
    - local None (no clear tempo) with providers at 180 → consensus None, effective None;
    - a tag BPM and a manual value keep today's precedence.

    DJ-window tracks keep today's rule.
  - `test_analyze_file_stores_no_clear_tempo_without_error`. With an ambient decode:
    - `res.bpm is None` and `res.error is None`;
    - `res.bpm_method == TEMPO_RANGES["therapy"].method`;
    - `res.bpm_confidence < THERAPY_CONF_GATE`;
    - key analysis still runs.
- [ ] **Step 3: Run the tests.** They must FAIL.
- [ ] **Step 4: Implement the estimator and the branches:**
  - `estimate_file_bpm` follows the order in Step 2.
  - `analyze_file` catches `NoClearTempo` before the generic handler.
  - `_refresh_consensus` (in `bpm_consensus.py`) applies the local-vote rule for wide-window tracks.
  - Keep the measured runtime as a note only, with no timing test: 1.45× the DJ scorer per 60 s section, 160 ms against 110 ms.
- [ ] **Step 5: Run** `uv run pytest tests/test_tempo_wide.py tests/test_audio_analysis.py -v`. Everything must PASS.
- [ ] **Step 6: Commit** "Add the therapy tempo estimator: 40-240 BPM, no octave pull, no value when the tempo is unclear".

### Task 4: Window plumbing: requests, analysis plan file, per-folder windows, scoped jobs, self-test

**Files:**
- Modify: `backend/app/schemas.py:183-191`, `backend/app/api/scan.py:33-90`, `backend/app/jobs/worker.py:196-316, 389-410, 533-576`, `backend/app/services/audio_analysis.py:504-560` (analyze_all), `backend/app/desktop_runtime/spawn_probe.py`, `backend/app/desktop_runtime/bootstrap.py:116-121`, `scripts/desktop/smoke_installed.py:25-27`.
- Test: `backend/tests/test_tempo_range_plumbing.py`; edit `backend/tests/test_desktop_analysis.py:34, 41, 62, 96-121`.

**Interfaces:**
- Produces: the request fields, the worker plan file, the `analyze_all` window resolution, and scoped analysis with a dry run.
- Consumes: Tasks 2 and 3.

**Analyze route semantics:**

| Case | Behaviour |
|---|---|
| Scoped (`track_ids` XOR `query`) | Branch before the provider credential checks (`scan.py:63-74`): scoped jobs never call providers, so a missing GetSongBPM or Cyanite key must not block them. The ffmpeg check still applies to a start, but not to a dry run. Resolve the scope with `bulk_edit._scope_ids`, excluding missing tracks, in the API process (search compile; no DSP import). `dry_run` returns `{"matched": n}`, creates no job and skips the idle check. 0 matched → 400 «Δεν βρέθηκαν tracks για ανάλυση». While any job runs → 409 with the existing Greek busy message; never attach to the running job as the unscoped path does at `scan.py:76-80`. Otherwise write the plan `{"tempo_range", "root_ranges": {}, "track_ids", "scoped": true}` and start the job: every scoped track is re-analysed (force for those ids), primary-only, `limit` ignored. |
| Unscoped | As today (`force`, `limit`). Each track's window is `resolve_track_range(str(resolve_source_path(track.absolute_path)), tempo_range, root_ranges)`, the connected path `analyze_all` already builds at `:614`. A full «Επανανάλυση» therefore replaces crate or selection windows with folder or default windows; the Settings help text says so (Task 6). |

The plan file never leaks:
- if `start_analyze` returns False or raises, the route unlinks it;
- if the child is stopped before reading it, `_monitor_analyze_process` unlinks it, as `_analyze_scan_additions` does in its `finally` (`worker.py:315`).

`analyze_all` swaps `Track.id.in_(track_ids)` (`:533`) for `ids_in` (`services/sql_ids.py`), so a 40,000-id scope stays under SQLite's variable cap.

`start_scan` keeps `roots=None` as its default, because `test_worker.py:208` calls it with only a job id.

`job.message` keeps today's exact formats, so `translateJobMessage` (`labels.ts:211-227`) still translates it. No window suffix is added.

The scan's auto-analysis follows the unscoped rule, with the scan request's `tempo_range` and `root_ranges` in its plan file.

- [ ] **Step 1: Write the failing tests:**
  - `test_request_validation`: an unknown `tempo_range` or a bad folder value gives 422; `track_ids` and `query` together give 422.
  - `test_scoped_dry_run_counts_without_a_job`: three tracks match `artist:Zed` → `{"matched": 3}`, and no `Job` row exists.
  - `test_scoped_job_writes_a_plan_file`: monkeypatch `worker.start_analyze` to capture its arguments. The args are `(job_id, False, None, plan_path)`, and the plan JSON holds the window, ids and `scoped: true`.
  - `test_scoped_job_is_primary_only_on_web`: with providers enabled in settings, the captured `analyze_all` kwargs have `local_only=True` and `force=True` for those ids.
  - `test_scan_auto_analysis_carries_window_and_folders`: monkeypatch the scan child entry to read the plan.
  - `test_analyze_all_resolves_window_per_track`: monkeypatch `analyze_file` to record `tempo_range.key` per path. Tracks under each folder get the folder window; `tempo_range="therapy"` gives therapy for all.
  - `test_folder_windows_match_connected_paths`: a path mapping whose logical prefix (`/Volumes/Old/Music`) differs from the connected root (`/Users/x/Music`). The folder window keyed by the connected root applies.
  - `test_scoped_request_refuses_while_busy`: with an active job, a scoped request gives 409 and the dry run still answers.
  - `test_scope_excludes_missing_tracks` and `test_empty_query_means_whole_library`.
  - `test_plan_file_removed_when_start_fails`.
  - `test_spawn_args_stay_constant_size`: with 5,000 ids the `Process` args contain no list. The ids live only in the plan file, and the child deletes it.
  - `test_job_message_still_translates`: the finished message matches the existing `^analyzed (\d+), failed (\d+)$` form.
  - `test_scoped_job_ignores_missing_provider_keys`: with GetSongBPM and Cyanite enabled but no keys, a scoped dry run and a scoped start both succeed.
  - Update the monkeypatched `start_analyze` lambdas in `test_desktop_analysis.py` to the new signature. Keep their assertions on `force` and `limit`.
  - Update `test_desktop_analysis_child.py:108, 131`: the spawned helper reads `read_analysis_plan(path)["track_ids"]`.
- [ ] **Step 2: Run the tests.** They must FAIL.
- [ ] **Step 3: Implement:**
  - The request fields and route branches.
  - `write_analysis_plan` / `read_analysis_plan`. Reuse `_write_track_ids` / `_read_track_ids`, switching both to the dict format.
  - `start_analyze(..., plan_path)`, `_run_analyze(job_id, force, limit, plan_path)`, `start_scan(..., tempo_range, root_ranges)`.
  - The scan child reads the plan.
  - `analyze_all` takes `tempo_range` and `root_ranges` and submits `analyze_file(..., tempo_range=get_range(resolved))` per track.
- [ ] **Step 4: Desktop probes:**
  - `spawn_probe.py` and `bootstrap.py` expect `TEMPO_RANGES["psy"].method`.
  - The existing spawned child probe (`spawn_probe.send_analysis`, `:49`) adds a therapy result to its payload: a 60 BPM click clip through `estimate_bpm(x, TEMPO_RANGES["therapy"])` gives 60 ± 1 and the therapy method. `bootstrap.py` reports it as `"analysis_therapy"`. This proves the frozen bundle, on the real Windows child path, carries the wide estimator's librosa/scipy pieces, and it adds no new subprocess.
  - `smoke_installed.py`: `BPM_METHOD = "librosa-onset-multilag-v2@133-286"`.
- [ ] **Step 5: Run** `uv run pytest tests/test_tempo_range_plumbing.py tests/test_desktop_analysis.py tests/test_desktop_analysis_child.py tests/test_desktop_profile.py -v`. All must PASS. Also run `python3 scripts/desktop/check_parity_inventory.py` (no route change, still OK).
- [ ] **Step 6: Commit** "Carry the BPM window per request, folder and scoped job to the analysis child".

### Task 5: Manual «×½ / ×2» BPM routes

**Files:**
- Modify:
  - `backend/app/api/tracks.py`;
  - `backend/app/services/audio_analysis.py:653, 666` (the consensus-column refresh in `analyze_all`);
  - `scripts/desktop/check_parity_inventory.py` (FOLLOWUP_ROUTES, owner `manual_bpm`).
- Test: `backend/tests/test_manual_bpm.py`; extend the parametrised cases in `backend/tests/test_effective_bpm.py:17-31` with `manual:octave`.

**Interfaces:**
- Produces: the two routes from Shared Interfaces.
- Consumes: `services/tempo.effective_bpm`, `services/bpm_consensus._refresh_consensus` (Task 1), `services/audit.log(..., commit=False)`.

**Route rules:**
- **POST:**
  - The base value is the server's `effective_bpm(track)`. The result is `base * factor`, unrounded, so ×½ then ×2 restores the exact value.
  - Allowed bounds: 30 ≤ result ≤ 400. Outside them: 422 «Το BPM βγαίνει εκτός ορίων».
  - No effective BPM: 422 «Δεν υπάρχει BPM για αλλαγή». Unknown track: 404 «Το track δεν βρέθηκε».
  - Writes `bpm_consensus=result`, `bpm_consensus_sources="manual:octave"`, `bpm_needs_review=False`, plus the audit row `bpm_manual_update` with before/after `{bpm_consensus, bpm_consensus_sources}`, in one commit.
- **DELETE:**
  - On a manual value: clear it, then `_refresh_consensus(track, get_settings().bpm_disagreement_percent)` (`config.py:40`; the web "auto" path at `analysis.py:225`), audited, one commit.
  - On a non-manual value: return 200 unchanged.

- [ ] **Step 1: Write the failing tests:**
  - `test_halve_analysed_bpm`: `bpm_analyzed=190` → 95.0, with `manual:octave` and one audit row.
  - `test_manual_beats_tag`: tag BPM 145, ×0.5 → effective 72.5.
  - `test_exact_round_trip`: 147.33, ×0.5 then ×2 → exactly 147.33.
  - `test_double_twice_compounds`: ×2, ×2 → ×4 (the server is stateless; the UI must block double clicks).
  - `test_no_bpm_422` and `test_bounds_422` (30 × 0.5 = 15): both with Greek messages.
  - `test_bad_factor_422` and `test_missing_track_404`.
  - `test_reset_recomputes_auto`: with tag 145, manual 72.5, then DELETE → consensus 145 from `metadata`.
  - `test_reset_non_manual_is_noop`.
  - `test_search_follows_manual`: `bpm:90-100` finds the halved track.
  - `test_analysis_never_overwrites_a_concurrent_manual_value`. Analysis commits per track (`audio_analysis.py:663`) but recomputes consensus from the row it loaded at the start.
    - Monkeypatch `analyze_file` so that, for one track, it first writes `manual:octave` 95 through a **second** session and commits, then returns a result of 191.
    - After `analyze_all`, the row still has `bpm_consensus == 95` and `manual:octave`, and `bpm_analyzed == 191`.
    - Fix: in `analyze_all`, call `session.refresh(t, attribute_names=["bpm_consensus", "bpm_consensus_sources", "bpm_needs_review"])` immediately before each `_refresh_consensus(t, …)`, both in the per-track write and in the post-loop pass (`:653`, `:666`). `_refresh_consensus` then sees the manual value and keeps it.
    - The same test covers DELETE racing an analysis.
  - `test_desktop_core_routes_without_dsp`: use the subprocess pattern of `test_desktop_profile.py:12-30`, because an in-process check is meaningless once other tests have imported scipy. A fresh interpreter builds the desktop-core app, calls both routes through a TestClient, and asserts `scipy` and `app.services.audio_analysis` are not in `sys.modules`.
- [ ] **Step 2: Run the tests.** They must FAIL.
- [ ] **Step 3: Implement the routes** and add both to `FOLLOWUP_ROUTES`.
- [ ] **Step 4: Run** `uv run pytest tests/test_manual_bpm.py tests/test_effective_bpm.py -v` and `python3 scripts/desktop/check_parity_inventory.py`. Both must PASS.
- [ ] **Step 5: Commit** "Add a manual BPM octave fix stored only in CrateMind".

### Task 6: Frontend BPM windows: settings, per-folder windows, «Ανάλυση BPM» dialog, Greek method labels

**Files:**
- Create: `frontend/src/lib/tempoRanges.ts`, `frontend/src/components/AnalyzeBpmDialog.tsx`, `frontend/src/lib/bpmUpdates.ts` (the `ANALYSIS_FINISHED` constant only), `frontend/tests/tempoRanges.test.ts`.
- Modify: `frontend/src/lib/{prefs,api,types,tempo}.ts`, `frontend/src/pages/Settings.tsx:118-157, 228-250, 650-682`, `frontend/src/components/BulkTagBar.tsx`, `frontend/src/pages/Crates.tsx`; extend `frontend/tests/tempo.test.ts`.

**Interfaces:**
- Produces: `lib/tempoRanges.ts` and the api additions (Shared Interfaces), plus `AnalyzeBpmDialog({ scope: { trackIds: number[] } | { query: string }, open, onOpenChange, onDone })`.
- Consumes: the Task 4 request fields.

**UI** (Greek copy as written):

| Place | What it shows |
|---|---|
| Settings, DJ profile | «Εύρος BPM ανάλυσης» select with the three DJ labels, and the help line «Ισχύει για νέες αναλύσεις. Για tracks που έχουν ήδη αναλυθεί, χρησιμοποίησε «Ανάλυση BPM» σε επιλογή ή crate.» Next to each music folder in the roots list (`Settings.tsx:236-243`): a small select, «Όπως η προεπιλογή» plus the three labels, `aria-label` «Εύρος BPM για {φάκελο}». Stored in `tempoRangeByRoot`, keyed by the listed root string; «Όπως η προεπιλογή» deletes the key. The «Επανανάλυση» help text (`Settings.tsx:680`) gains: «Χρησιμοποιεί το εύρος κάθε φακέλου ή την προεπιλογή· αναλύσεις με εύρος που επέλεξες σε crate ή επιλογή αντικαθίστανται.» |
| Settings, therapy profile | One line: «Εύρος BPM: 40–240 (μουσικοθεραπεία). Μουσική χωρίς σταθερό ρυθμό μένει χωρίς BPM.» |
| Scan and analyze calls (`Settings.tsx:122, 151`) | Pass `activeTempoRange()` and `activeRootRanges()`. |
| `AnalyzeBpmDialog` | Title «Ανάλυση BPM». DJ: a window select, defaulting to the DJ default. Therapy: the fixed therapy line. On open, `api.analyzeDryRun` shows «Θα αναλυθούν ξανά {n} tracks με εύρος {label}. Οι χειροκίνητες τιμές BPM δεν αλλάζουν.» Buttons «Ανάλυση» / «Άκυρο». After start, the dialog stays open and follows the job the way Settings' `followJob` does: it polls `api.scanStatus` and shows progress «{done} / {n}». When the job ends it toasts the translated job message, calls `onDone()` so the Library or Crates rows reload, and closes. A 409 shows the server's Greek busy message. |
| Where the dialog is used | BulkTagBar's new «Ανάλυση BPM» button (scope: the selected ids, or the applied query for «Όλα τα αποτελέσματα», where `""` means the whole library), and a per-crate «Ανάλυση BPM» action in `Crates.tsx` (scope: the crate's `query`). Both appear only when `capabilities.analysis` is true, as at `Settings.tsx:658`. |
| `tempo.ts` `bpmDescription` | Uses `methodLabel`. «Χωρίς σταθερό ρυθμό» appears only when all three hold: `effectiveBpm(track) == null`, the method is therapy, and the track is analysed (`analyzed_at` set, no `analysis_error`). The check runs before the early `return undefined` at `tempo.ts:35`. A manual, tag or title-hint BPM always wins and shows its own source. |
| Job end | When any analysis job ends (dialog or Settings), dispatch `ANALYSIS_FINISHED = "cratemind:analysis-finished"` from `lib/bpmUpdates.ts`, which this task creates with that constant only. The deck listener comes in Task 7. |

`methodLabel` mapping:

| Method | Label |
|---|---|
| legacy | «Ανάλυση BPM (135–286)» |
| psy | «Ανάλυση BPM (psy 133–286)» |
| mixed | «Ανάλυση BPM (μικτό 118–250)» |
| slow | «Ανάλυση BPM (αργά 70–125)» |
| therapy | «Ανάλυση BPM (μουσικοθεραπεία 40–240)» |
| fallback | «Εναλλακτική ανάλυση BPM ({window})» |
| unknown | «Ανάλυση BPM» |

- [ ] **Step 1: Write the failing tests:**
  - `tempoRanges.test.ts`:
    - `activeTempoRange` is "therapy" under the therapy profile and the stored DJ key otherwise.
    - `activeRootRanges` is `{}` in therapy.
    - `methodLabel` covers every row above and never returns a string containing `librosa`, `ffmpeg` or `@`.
  - `tempo.test.ts`:
    - «Χωρίς σταθερό ρυθμό» for the therapy no-tempo row;
    - not shown when the same row also has a manual or tag BPM;
    - the Greek window label for a local source.
  - A source contract: `Settings.tsx` passes `activeTempoRange()` to both `startScan` and `startAnalyze`; `BulkTagBar.tsx` and `Crates.tsx` render `AnalyzeBpmDialog`.
  - A pure `analyzeRequestBody(opts)` in `api.ts`, checked for scoped and unscoped bodies. A stale `djTempoRange` value outside the registry is sent as `"psy"`.
  - A pure `jobProgressText(job)` for the dialog, plus a source contract that the dialog calls `onDone` after the job ends.
- [ ] **Step 2: Run** `bun test tests/tempoRanges.test.ts tests/tempo.test.ts`. It must FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `bun test` and `bun run build`. Both must PASS.
- [ ] **Step 5: Commit** "Choose the BPM window per profile, music folder and crate".

### Task 7: «×½ / ×2» buttons in the deck, «Ουρά tagging» and the Library card

**Files:**
- Create: `frontend/src/components/BpmOctaveButtons.tsx`, `frontend/tests/bpmUpdates.test.ts`.
- Extend: `frontend/src/lib/bpmUpdates.ts` (from Task 6) with `BPM_UPDATED`, `applyBpmFields`, `notifyBpmUpdated` and `createOctaveController`.
- Modify:
  - `frontend/src/lib/api.ts`;
  - `frontend/src/lib/player.tsx` (`patchSlotsTrack` and a `BPM_UPDATED` listener that keeps the token);
  - `frontend/src/components/MiniPlayer.tsx` (in the `bpmKey` block at `:768-771`: one import and one JSX insertion);
  - `frontend/src/pages/TaggingQueue.tsx:638-641`;
  - `frontend/src/lib/queuePaging.ts:53-64` (widen `patchQueueRow` to `Partial<Track>`);
  - `frontend/src/components/ProfileEditor.tsx:214-221`;
  - `frontend/src/pages/Library.tsx` (patch `tracks` and `selected` on `BPM_UPDATED`).
- Tests: extend `frontend/tests/deckSlots.test.ts` and `frontend/tests/queuePaging.test.ts`.

**Interfaces:**
- Produces: `BpmOctaveButtons({ track, compact?: boolean })`, plus `BPM_UPDATED` and its helpers.
- Consumes: the Task 5 routes.

**Behaviour:**
- **Buttons:** «×½» (`aria-label` «Μισό BPM») and «×2» (`aria-label` «Διπλό BPM»), and «Επαναφορά BPM» only when the source starts with `manual:` (title «Επιστροφή στο αυτόματο BPM»). The tooltip on all of them: «Αποθηκεύεται μόνο στο CrateMind, όχι στα tags ή στο djay».
- **In-flight:** all buttons are disabled while a request runs.
- **On success:**
  - Dispatch `BPM_UPDATED`.
  - Toast «BPM {old} → {new}», rounded to 1 decimal, with the action «Αναίρεση». Undo applies the inverse factor if the old source was manual; otherwise it calls DELETE.
- **No new keyboard shortcuts or controller pads.**
- **Deck:** `PlayerProvider` patches the matching slot's `track` and keeps its `token`, so playback does not reload. Sync, new loops, the BPM display and the jog-screen telemetry follow the new value. An imported djay grid keeps djay's BPM; this is documented, and djay data stays read-only.
- **After an analysis job** (`ANALYSIS_FINISHED`, Task 6): `PlayerProvider` re-reads its loaded tracks (at most two) with the call TaggingQueue's profile listener uses (`TaggingQueue.tsx:312-325`). It patches them through `patchSlotsTrack` with the tokens kept, so a deck never reloads.
- **Library:** besides patching rows, when the applied query contains a `bpm:` token it reloads quietly, using the existing reload pattern (`Library.tsx:427`), and refetches the facet counts. A halved track then leaves `bpm:140-150` as it should.
- **Button logic** lives in a pure `createOctaveController({ send, onDone, onError })`. Its `trigger(factor)` is ignored while a request is pending, and a failure clears the pending state so a retry works.

- [ ] **Step 1: Write the failing tests:**
  - `bpmUpdates.test.ts`:
    - `applyBpmFields` changes only the two fields, and `effectiveBpm` then returns the manual value.
    - The undo plan: a manual old source gives the inverse factor; otherwise reset.
  - `bpmUpdates.test.ts` (controller):
    - three rapid `trigger(2)` calls against one unresolved request send exactly one request;
    - a rejected request leaves the controller idle, and the next trigger sends again.
  - `deckSlots.test.ts`:
    - `patchSlotsTrack` patches only the matching slot and keeps `token` identical, so the load effect does not fire again;
    - the patched slot's `effectiveBpm`, which feeds Sync and new loops (`MiniPlayer.tsx:85`, `deckSync.ts:18-28`), returns the manual value.
  - `queuePaging.test.ts`: `patchQueueRow` accepts BPM fields.
  - Source contracts:
    - `MiniPlayer.tsx` still has the load effect deps `[current?.id, token, autoPlay]` and renders `<BpmOctaveButtons` once.
    - `TaggingQueue.tsx` and `ProfileEditor.tsx` render it.
    - `Library.tsx` and `TaggingQueue.tsx` listen to `BPM_UPDATED`.
- [ ] **Step 2: Run the tests.** They must FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `bun test` and `bun run build`. Both must PASS.
- [ ] **Step 5: Commit** "Halve or double a track's BPM from the deck, the tagging queue and the Library card".

### Task 8: Library facet filter panel (B1)

**Files:**
- Create: `frontend/src/components/FacetFilterPanel.tsx`, `frontend/tests/facetPanel.test.ts`.
- Modify: `frontend/src/lib/queryGrammar.ts`, `frontend/src/lib/queryChips.ts:87-100`, `frontend/src/pages/Library.tsx:41, 99-123, 241-252, 338-357`, `frontend/src/lib/prefs.ts`, `frontend/src/components/ui/slider.tsx:54` (per-thumb labels).

**Interfaces:**
- Produces, in `queryGrammar.ts`:
  - `foldText(s: string): string`: NFKD, strip combining marks, `toLowerCase()`, ς→σ.
  - `facetTokenActive(query, key, value): boolean`.
  - `toggleFacetToken(query, key, value, opts: { single: boolean; siblings: string[] }): string`.
  - `rangeFromQuery(query, field): [number, number] | null`.
  - `setRangeToken(query, field, range: [number, number] | null): string`.
- Produces: `FacetFilterPanel({ draft, applied, onApply(next: string) })`.
- Consumes: `api.facetCounts`, `useFacets`, `FACETS_CHANGED`, `axisLabel`, `components/ui/slider.tsx`.

**Behaviour:**
- **Panel and preference:** a «Φίλτρα» toggle next to «Στήλες» opens a left rail (232 px) beside the table. It is closed by default. State lives in one pref key, `libraryFacetPanel: { open: boolean; collapsed: string[] }`.
- **Facets:** each facet is a collapsible section with its values and counts.
  - Counts come from `api.facetCounts(applied q)`, refetched on an applied-q change, on `FACETS_CHANGED` and after bulk `onApplied`. A request-sequence guard drops stale responses.
  - Single-value facets act as radios: a click replaces any sibling value. Multi-value facets toggle, combined with AND.
  - Negated tokens and `key:*` stay as typed and show as a read-only state («εκτός», «οποιαδήποτε»).
- **Ranges:** BPM (therapy 40–240, DJ 60–300), energy/arousal 1–10 (`axisLabel`), and valence 1–10 in therapy or darkness 1–10 in DJ. They use two-thumb sliders that apply on `onValueCommit`. The full range writes no token. Only positive range tokens are written.
- **Applying:** each click builds the new query from the draft input text (keeping typed words) and applies it through `runQuery`. «Καθαρισμός φίλτρων» removes only the panel-managed tokens.
- **Chips:** until facets load, a facet token chip shows only its value, never the raw key (`queryChips.ts:87`).
- **Accessibility:**
  - Section toggles carry `aria-expanded` and `aria-controls`.
  - Single-value facets are a `role="radiogroup"` with radio semantics; multi-value facets use checkbox semantics.
  - Each slider thumb has its own Greek `aria-label` («Ελάχιστο BPM», «Μέγιστο BPM», and so on). Today the wrapper copies one label onto every thumb (`components/ui/slider.tsx:54`), so add a backward-compatible `thumbLabels?: string[]` prop there; that file joins this task.
  - In a single-value facet, siblings of the selected value stay clickable even when their conjunctive count shows 0, because replacing the selection can still give results.
  - Everything works from the keyboard, and focus stays on the clicked value after `runQuery`.
- **Narrow windows:** below the `lg` breakpoint the rail overlays the table instead of pushing it, so a 1366 px Windows laptop keeps a usable table next to the side card.
- **OR:** not in this task. `toggleFacetToken` takes `siblings` so an OR mode can be added later without a grammar change in this phase.

- [ ] **Step 1: Write the failing tests** in `facetPanel.test.ts`:
  - `foldText`: «Χαλάρωση» → «χαλαρωση»; «ΜΆΝΟΣ» → «μανοσ».
  - `toggleFacetToken`:
    - adds `purpose:"χαλάρωση"`;
    - removes a typed `purpose:χαλαρωση`;
    - in single mode, replaces `voice:"με στίχους"` with `voice:"οργανικό"`;
    - keeps `-mood:*`, `folder:"C:\Music"` and free words byte-for-byte.
  - `setRangeToken`:
    - writes `bpm:60-80` and replaces an existing `bpm:` token;
    - `null` removes it;
    - leaves `-bpm:90-100` alone.
  - `rangeFromQuery` parses `valence:6-8`, and returns null for a single value.
  - The counts guard: the older of two responses is ignored.
  - A radio switch: with `voice:"με στίχους"` applied, clicking «οργανικό» (count 0 under the current query) is enabled and replaces the token.
  - A slider render (`renderToStaticMarkup`) shows two distinct thumb `aria-label`s.
  - Chips (extend `frontend/tests/facetUi.test.tsx`): `parseQueryChips` with no facets loaded never returns a label containing the raw key.
  - A source contract: `Library.tsx` keys counts on the applied `q`, not the draft.
- [ ] **Step 2: Run the tests.** They must FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `bun test` and `bun run build`. Both must PASS.
- [ ] **Step 5: Commit** "Filter the Library by vocabulary values and BPM, arousal and valence ranges".

### Task 9: Circumplex map in therapy (B2)

**Files:**
- Create: `frontend/src/lib/energyMapAxes.ts`, `frontend/tests/energyMapAxes.test.ts`.
- Modify: `frontend/src/pages/EnergyMaps.tsx:49-101, 141-341`, `frontend/src/components/layout/Sidebar.tsx:81` (therapy label).

**Interfaces:**
- Produces: `energyMapAxes(profile): { cols: Axis; rows: Axis; cellQuery(col: [number, number], row: [number, number]): string }`.
- DJ:
  - cols = energy, rows = darkness (high on top);
  - `cellQuery` returns exactly `energy:${c0}-${c1} darkness:${r0}-${r1}`, as today (L90-101).
- Therapy:
  - cols = valence («Συναισθηματικό σθένος →»), rows = energy («Διέγερση ↑», high on top);
  - `cellQuery` returns `valence:${c0}-${c1} energy:${r0}-${r1}`.

**Therapy page:**
- Title and sidebar label «Χάρτης συναισθήματος».
- The darkness histogram, gauge and tile show valence.
- The roles panel and its 6 calls are skipped.
- The grid keeps 25 count calls.
- The DJ page stays byte-identical in copy and queries.
- `useGSAP` keeps `{ scope: containerRef }` with no `dependencies`, and every `data-reveal` wrapper stays mounted while loading.

- [ ] **Step 1: Write the failing tests:**
  - `energyMapAxes.test.ts`:
    - The DJ `cellQuery` for all 25 band pairs equals the old string.
    - The therapy queries use valence by energy.
    - Therapy rows run high to low.
    - Labels come from `axisLabel`.
  - A source contract: `EnergyMaps.tsx` calls `useGSAP` with `{ scope: containerRef }` and no `dependencies`, and skips the `role:` count calls when therapy.
- [ ] **Step 2: Run the tests.** They must FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `bun test` and `bun run build`. Both must PASS.
- [ ] **Step 5: Commit** "Show the arousal by valence map in therapy".

### Task 10: Therapy dashboard (B3)

**Files:**
- Create: `frontend/src/lib/dashboardTherapy.ts`, `frontend/tests/dashboardTherapy.test.ts`.
- Modify: `frontend/src/pages/Dashboard.tsx:85-141, 207-232, 268-340, 379-664`.

**Interfaces:**
- Produces: `quickLists(crates: SavedSearch[]): SavedSearch[]`, pinned only and ordered by `sort_order` then name.
- Consumes: `progressLine(total - untagged, total)` directly (`queuePaging.ts:90-92`), `profileCopy.ts`, and `SavedSearch.pinned` (no schema change).

**Therapy view:**
- **Hidden:** «Κύριο Crate», the hero, the «Όπλα» tile and IntelRow, and the Peak Bridge card.
- **Fetches:** skip the standalone `weapons` count and `QUEUES`. The "approved" count still uses the `status:approved,weapon` query.
- **Quick-list cards** never print the crate's raw query (`Dashboard.tsx:516` shows `c.query` today, which exposes keys such as `purpose:`). Show the name and the count only.
- **Labels:**
  - "approved" counts `status:approved,weapon`;
  - «Χωρίς tags» becomes «Αταξινόμητα»;
  - "Energy Balance" becomes «Διέγερση».
- **«Γρήγορες λίστες»** replaces Memory Crates. It offers unpin only (every crate shown is pinned), with no delete. Empty state: «Καρφίτσωσε ένα crate για να εμφανιστεί εδώ.», linking to /crates.
- **Progress:** the line «Ταξινομημένα x / y» links to /tag and uses the existing stats with no extra calls.
- **Layout:** the tile grid uses `lg:grid-cols-5` in therapy.
- **DJ view:** unchanged.
- **Keep:** the `api.importBackup(payload); notifyFacetsChanged();` sequence (`facetCache.test.ts:35-38`).

- [ ] **Step 1: Write the failing tests:**
  - `dashboardTherapy.test.ts`: `quickLists` filters and orders; the therapy progress line for total 6800 and untagged 5560 reads «Ταξινομημένα 1.240 / 6.800».
  - A source contract: the therapy branch issues no `weapon` count and renders no «Όπλα».
- [ ] **Step 2: Run the tests.** They must FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `bun test` and `bun run build`. Both must PASS.
- [ ] **Step 5: Commit** "Give the therapy dashboard quick lists and the sorting progress".

### Task 11: Docs and desktop verification

**Files:**
- Modify: `docs/README.md` (sections «Εύρος BPM», «Διόρθωση BPM (×½ / ×2)», «Φίλτρα στη Βιβλιοθήκη»), `docs/superpowers/specs/2026-11-02-music-therapy-design.md` (decisions; follow-ups OR filter and ÷3).

- [ ] **Step 1: Write the docs.**
- [ ] **Step 2: Backend.** `cd backend && uv run pytest` must pass, except for the known failures: `test_manual_identity::test_whole_component_guards_and_no_autoretirement`, the timing-flaky `test_desktop_analysis_child` stall test, and the order-dependent `test_runtime_capabilities` pair. Report each one.
- [ ] **Step 3: Frontend.** `cd frontend && bun test && bun run build && bun run build:desktop` must pass.
- [ ] **Step 4: Contracts.** `python3 scripts/desktop/generate_schema_contract.py --check` must be unchanged, and `python3 scripts/desktop/check_parity_inventory.py` and `--runtime desktop-core` must pass.
- [ ] **Step 5: Mac desktop build.** Follow `docs/TAURI_DESKTOP_OPERATIONS.md`. `build_backend.py --self-test` must report `analysis_therapy` 60 ± 1 with the therapy method, and verify_bundle and smoke must pass.
- [ ] **Step 6: Manual smoke** on the Mac app, using a copy of real music or the user's own check (agents never read real audio):
  - ×½ on a playing deck;
  - a folder window plus a scan;
  - a crate «Ανάλυση BPM» dry run;
  - the facet panel;
  - the therapy dashboard and the circumplex map.
- [ ] **Step 7: Windows check.** This needs the user's OK, because it is a push.
  - Push the branch to `windows-build`. CI then runs `build_backend.py --self-test`, including the `analysis_therapy` probe frozen on Windows, plus `verify_bundle` and `smoke_installed.py` (`windows.yml:45, 72-73`).
  - Then the user's installed offline Windows smoke for Phase B (spec Verification): the facet panel, the circumplex map, ×½ / ×2 on a deck, and a therapy analysis of a folder.
- [ ] **Step 8: Commit** "Document BPM windows, the octave fix and Library filters".

Releasing (version bump, CHANGELOG, tag) is a separate step and needs the user's OK.

## Known limitations (pinned in tests, shown in the docs)

- **Wide estimator: octave errors on eighth-note textures.** Strummed or fingerpicked eighths, ballads with eighth hats, reggae, clave and some lo-fi read ×2 or ×½. The «×½ / ×2» fix covers them.
- **Wide estimator: ×3 on weak-accent compound metre.** 6/8 or 12/8 with a barely accented beat (harp triplets without bass, a soft-thumb lullaby, 12/8 djembe) reads ×3, which ×½ / ×2 cannot fix. Recorded as a follow-up: «÷3» or manual BPM entry in therapy.
- **Wide estimator: solo voice and choir.** These often fall under the gate and get no BPM. That fails safe: no value rather than a wrong one.
- **Wide estimator: steady tonal drones** can get a confident false tempo. Measured: a static 3-sine chord gave 41.35 BPM at confidence 0.46, and a rubbed singing bowl gave 48 at 0.54. Pure tone and drone tracks, and binaural material mixed to mono, are the likely cases in a therapy library. The docs say so.
- **The `slow` DJ window is narrower than an octave.** A track outside 70–125 analysed with it can read at a non-octave ratio, so the window is applied only per folder, crate or selection, never by default.
- **Evidence base.** Every estimator choice rests on synthetic signals. The only real-audio evidence is the old 135–286 psy benchmark, which must not be rerun because it reads real audio. The user validates on their own library through the app.

## Self-Review

- **Spec coverage:**
  - B4: Tasks 2–7.
  - B1: Task 8.
  - B2: Task 9.
  - B3: Task 10, which also covers the Phase A follow-up about weapon tiles.
  - Docs and desktop: Task 11.
- **Interfaces:** every name used in a later task is defined in Shared Interfaces or in an earlier task's Produces.
- **Review Focus mapping:** 1 → Tasks 5 and 7; 2 → Task 3; 3 → Tasks 4 and 6 (plan file, `ids_in`, dialog progress); 4 → Tasks 2 and 4; 5 → Task 8.
- **Proportion:** each task carries its interfaces, test names and assertions. The only code body is the therapy estimator, whose algorithm neither the signature nor the tests determine.

## Plan review (2-pass)

### Pass 1: `plan-reviewer` on Opus 5.5, effort high

The verdict was "fix the blockers first; the design underneath is sound." It found 3 blockers, 14 should-fix items, 8 suggestions and 5 cuts. Each was checked against the code; all were applied except S8, where I chose the warning text over stickiness.

**Blockers:**
- **B1. Folder windows matched the logical path instead of the connected path.** In dataset mode no track would ever match. Fixed: `resolve_track_range` takes the connected path, with a test for a mapping whose logical and connected paths differ.
- **B2. Existing tests and probes would go red after Task 2.** Unspecified method constants and two monkeypatched lambdas. Fixed: `BPM_METHOD` and `FALLBACK_METHOD` follow the psy window, the lambdas are updated, and Step 5 runs the spawn-probe test.
- **B3. The therapy tests were planned on unmeasured generators.** The reviewer measured a naive static chord at 41 BPM with confidence 0.46. Fixed: port the measured generators verbatim, and pin every expectation to a measured case.

**Should-fix:**
- The job-message suffix was dropped, because it broke the Greek translation.
- Scoped requests now return 409 instead of attaching to a running job.
- The scope reuses `bulk_edit._scope_ids`, where an empty query means the whole library, and excludes missing tracks.
- The dialog follows the job, refreshes the rows and is gated on `capabilities.analysis`.
- The correct settings field is `bpm_disagreement_percent`.
- The no-DSP test runs in a subprocess.
- Onset-free therapy audio becomes `NoClearTempo`; the order in `estimate_file_bpm` is fixed.
- S8, re-analysis windows not sticky: I chose a warning in the «Επανανάλυση» help text over stickiness, because stickiness would stop a folder-window change from ever reaching tracks that were already analysed.
- Port omissions fixed: the float32 cast and the librosa guard.
- The plan file is unlinked on start failure and when the job is stopped.
- `analyzeDryRun` is now separate from `startAnalyze`.
- A Windows CI and smoke step was added, behind the user's OK.
- The `bpmDescription` check now comes before the early return.
- The data-safety text now covers the reset's consensus columns.

**Suggestions applied:**
- facet-panel accessibility;
- the rail overlays the table below `lg`;
- strict task order;
- `ids_in` for scoped ids;
- the steady-drone limitation;
- the prefs text corrected (they are one blob);
- unpin only in «Γρήγορες λίστες»;
- `facetUi` test edits assigned to Task 8;
- release kept separate.

**Cuts applied:** `LEGACY_METHODS`, legacy bare-list plans, the job suffix, the timing test, and the `sortingProgress` wrapper.

### Pass 2: Codex gpt-6.1-sol, `model_reasoning_effort=xhigh`, read-only, its own plan-reviewer

The verdict was "changes required before execution". It found 2 blockers, 6 should-fix items, 2 suggestions and 2 cuts. Each was checked against the code and all were applied.

**Blockers:**
- **An analysis could overwrite a manual value written while it ran.** It commits per track (`:663`) but recomputes consensus from the row it loaded. Fixed: refresh the consensus columns before every `_refresh_consensus`, with an interleaving regression test (Task 5).
- **Stale provider votes could mask a therapy result.** Essentia and ReccoBeats agreeing at 180 outvoted a therapy 60. Fixed: for wide-window tracks, consensus requires the local vote (Task 3).

**Should-fix:**
- Scoped requests skip the provider credential checks.
- `test_desktop_analysis_child` reads the new plan format; `start_scan` keeps `roots=None`; the `Track.id.in_` reference is corrected to `:533`.
- BPM writes reload `bpm:`-filtered queries, and finished analyses refresh the loaded decks with their tokens kept.
- «Χωρίς σταθερό ρυθμό» appears only when no effective BPM exists.
- The slider gets per-thumb labels.
- Each suite's case builder is ported, including its finishing, noise and cropping.

**Suggestions applied:**
- The therapy probe runs inside the existing spawned child probe.
- Zero-count radio siblings stay clickable.
- The weapons fetch and the "approved" query are clarified.

**Cuts applied:**
- Raw queries are hidden on therapy quick-list cards.
- Task 7's behaviour is tested through a pure controller and slot tests instead of source strings.

## Execution record (2026-11-03)

**Lanes.** The work ran as one workflow, with a fresh Opus implementer per task, test-first, in three git worktree lanes:
- backend, Tasks 1–5;
- frontend A, Tasks 6–8;
- frontend B, Tasks 9–10.

All 10 tasks finished. Deviations are recorded in each commit body. The ones that matter:
- `analyze_file` took its window in Task 3.
- The unscoped analyze route also writes a plan file.
- `test_desktop_contract_inventory.py` pins the new follow-up routes.
- The dialog reuses BulkTagBar's `onApplied`.

**Port check (Task 3).** The repo's `_estimate_bpm_wide` reproduces final-A on the unified scoreboard (537 cases, gate 0.18): 515 ok, 19 octave, 3 non-octave, 56/56 no-tempo. The 70 ported signals are byte-identical to the measured suites.

**Integration.** The lanes were applied in a straight line on `phase-b/integration`, with no conflicts. They were later rebased onto `cb419dd` (the parallel session's 0.3.1 follow-ups), again with no conflicts.

**Review workflow.** 154 agents ran three rounds, each with six lenses (analysis, plumbing and routes, frontend logic, plan compliance, copy and accessibility, desktop safety). Every finding went to 3 skeptics and needed a majority to stand.
- **Result:** 44 distinct findings; 41 confirmed (14 major, 27 minor) and fixed with regression tests. The blind acceptance tests (`test_acceptance_phase_b.py`) found no product failure.
- **Fixes that change behaviour:**
  - The psy window keeps the legacy octave rule for consensus and fallback (≥ 109 stays), so DJ values change only at 133–135.
  - Therapy sections align to the majority octave before the median; ×3 and ×1.5 sections are left out.
  - The manual fix is guarded against every analysis phase.
  - The octave buttons block double clicks at the source.
  - The «Ανάλυση BPM» dialog can hide while its job runs, and a hidden job finishes with the current callbacks.
  - Settings jobs are followed past the page.
  - Whole-number `bpm:A-B` ranges match the BPM as displayed (rounded), so `bpm:140-145` keeps 139.6. This also affects DJ searches.
  - Many keyboard and focus fixes in the facet panel, Crates and the dashboard; Greek copy fixes.
- **Not converged:** round 3 still found new minor issues, mostly in code the earlier rounds had added. The loop stopped at its 3-round cap. The two mechanisms that grew (section alignment and the hidden dialog job) were re-read by hand and are bounded.

**Gates on the rebased branch:**
- Backend: everything passes except `test_library_exchange_writers::…refuse_idle_service_before_main` and `test_identity_import.py`. Both need the untracked `verification/` folder, which worktrees lack, so they run on main after the merge.
- Frontend: 673 pass, 0 fail; `build` and `build:desktop` ok.
- Desktop: the schema contract is unchanged (bb121f6f…); the parity inventory passes for web and desktop-core.

**Mac desktop build (Task 11, step 5) from main at `a6a9666`:**
- **Frontend:** 673 tests pass, and `build:desktop` succeeded.
- **Frozen self-test:** ok.
  - `forbidden_imports` is empty, so no DSP stack loads in the API process.
  - The psy window reads 140.0 BPM with method `librosa-onset-multilag-v2@133-286`.
  - `analysis_therapy` reads 60.0 with method `librosa-onset-wide-v1@40-240`, in-process and in the spawned child probe.
- **Bundle and smoke:** `verify_bundle` passed (data exclusion included); `smoke_installed` ok.
- **App:** `native/src-tauri/target/release/bundle/macos/CrateMind Preview.app`, 286.57 MiB.

**Still open:**
- the Windows CI run (a push to `windows-build`, which needs the user's OK);
- the user's manual smoke on the Mac and Windows apps;
- the release.

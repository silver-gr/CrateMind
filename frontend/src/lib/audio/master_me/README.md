# master_me (vendored)

The built-in Maximizer's DSP: [master_me](https://github.com/trummerschlunk/master_me) 1.3.1 by Klaus Scheuermann, GPL-3 (`COPYING`), compiled to WebAssembly with Faust. **Not for release** while the licence decision is open (see `AGENTS.md`).

- `master_me.wasm`: float build, no JS runtime template; it imports only `_expf`, `_logf`, `_log10f`, `_powf` and `_tanf` from `env`. Loaded by `../master-me.worklet.js`.
- `params.json`: `{size, params: {symbol → byte index}}`, derived from the build's `dsp-meta.json` (each control's `symbol` meta, or its address when it has none). Regenerate it with every rebuild.
- `master_me.dsp`, `expanders.lib`, `lib/ebur128.dsp`: the sources the wasm was built from.

## Patch

Two lines of `master_me.dsp` (439 and 454 upstream) drop `ba.linear2db :` in front of the limiter and brickwall gain-reduction bargraphs, so `limiter_gain_reduction` and `brickwall_limit` read in dB, ≤ 0 (the signal there is already in dB; upstream's build reads about −758 dB at rest).

## Rebuild

With `@grame/faustwasm@0.20.1` installed in a scratch folder, copy the three DSP files into `dsp/` (keeping `lib/`), then:

```bash
node node_modules/@grame/faustwasm/scripts/faust2wasm.js dsp/master_me.dsp out -no-template
```

Copy `out/dsp-module.wasm` here as `master_me.wasm`, and rebuild `params.json` from `out/dsp-meta.json`. Then run `bun test tests/maximizerDsp.test.ts`.

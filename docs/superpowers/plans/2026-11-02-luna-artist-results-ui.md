# Luna artist result UI cleanup plan

The user wants the Tauri Artists page to show only the final genre results generated with GPT-6 Luna. The old comparison card is confusing and is superseded by one result per artist.

## Scope and acceptance criteria

- Show completed results whose stored research model is exactly gpt-6-luna. Do not label legacy estimates, failed/pending research or rejected proposals as Luna results.
- Display one genre, optional secondary genres, and a simple proposal/confirmed state. No old/new columns, scene-cluster badges, competing confidence badges, BPM/energy estimates or old biographies.
- Keep sources/rationale collapsed until requested. Only unconfirmed results offer confirmation/correction; human-confirmed entries retain their existing protected status.
- Preserve the separately requested Unknown Artist utility card with its Library navigation and no editing controls.
- Use Greek UI copy. Genre names remain their established English labels.
- Make the same UI available in the packaged Tauri preview, not only the Vite development build. Keep desktop credentials in explicit per-device config; never bundle the checkout .env.
- Preserve all unrelated waveform/native work. No catalog changes, audio mutations, provider jobs or personal-data QA.

## Implementation

1. Add a typed selector for completed Luna results and focused fixtures covering ready, confirmed, rejected, legacy, unresolved and outside-list states.
2. Replace the comparison card with one result component. Put correction controls and source evidence behind explicit disclosure.
3. Filter the page to these results; remove the comparison action and legacy-only filters. Show an honest empty state and a research action.
4. Run frontend tests and both frontend builds; verify interactions using synthetic data.
5. Build/stage the packaged backend and frontend with the existing native scripts; check schema/parity and packaged fixture smoke checks. Verify native rendering only with disposable marked fixtures.
6. Update the local Tauri preview artifact while retaining a recoverable prior app build. Do not treat a successful browser build as proof of native QA.

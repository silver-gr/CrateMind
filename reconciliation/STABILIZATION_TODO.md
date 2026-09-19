# Integration and Collections
- [x] One canonical provider projection; legacy panel compatibility and transitive regression
- [x] Actionable review filters; source/manual distinction; neutral artist credit semantics
- [x] Consistency audit and frozen identity/scorer evidence
- [x] Collection browser, availability, native creation and ordered provenance
- [x] Regression tests, browser checks and handoff

Refactor scope: move provider serialization/resolution into one service; keep original scorer, promotion function and acceptance rows unchanged. Preserve source observations and imported membership rows. Add only local collection writes.

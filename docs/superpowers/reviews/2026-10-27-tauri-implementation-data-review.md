# Independent data review and fixes

Reviewed during implementation by a separate GPT-6.1 Sol/high code-reviewer. The reviewer used temporary SQLite/sentinel fixtures; no user databases/audio were opened. The session was interrupted before the reviewer could save a final report; these are its reported, reproduced findings and the integrating agent's dispositions.

| Finding | Fix | Regression evidence |
|---|---|---|
| Enrollment interruption between retired markers and active pointer stranded originals | Durable enrollment intent, recovery under lease, idempotent retry producing S0 from same generation | test_desktop_review_regressions.py enrollment crash test; independent reviewer reran recovery successfully |
| Local asset retirement checked stored paths on the wrong machine | Resolve obsolete and survivor paths through shared mapping; unavailable roots fail closed | test_desktop_review_regressions.py mapped retirement test |
| CLI exchange export bypassed HTTP source/internal-path protection | Shared service rejects music/internal destinations and changed-content overwrites | test_desktop_review_regressions.py export safety test |
| Detached import previews inherited public directory permissions | Private mkdtemp parent and mode0700 preview directory | test_desktop_review_regressions.py umask022 test |
| Same snapshot ID with altered content was reported already applied | Compare current baseline digest, schema fingerprint and parent before replay | test_desktop_review_regressions.py replay identity test |

After resumption, the five review regressions plus real subprocess desktop/web/helper/restart and auth tests passed together (9 tests). This record covers these data-safety findings; it is not a claim that every platform, installer or UI scenario has been reviewed or tested.

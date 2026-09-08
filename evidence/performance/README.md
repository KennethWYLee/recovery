# Classroom performance verification — 2026-09-08

The user authorized all three proposed areas: classroom reads, background updates, and typing/ranking responsiveness, followed by publishing to the existing Site.

## Evidence and scope

Before implementation, a bounded production Worker-log sample contained 21 successful reads of the active course workspace: wall time 4,085–5,505 ms (median 4,472 ms), CPU 14–39 ms (median 20 ms). This sample suggests waiting outside JavaScript execution; it is not a browser interaction measurement or a representative production percentile. No real student answers or ranking records were changed for this investigation.

`before.json` and `after.json` measure 50 distinct synthetic students reading the built Worker with isolated local D1. Each run performs one full-read burst and three unchanged-update bursts. Both use identical seeded classes, users, roster entries and memberships, and the production authentication code with simulated platform identity headers only inside Miniflare. The updated run includes additional correctness checks after measurement. No benchmark request reaches the hosted Site.

| Measurement | Before | After |
| --- | ---: | ---: |
| Full reads, P95 | 1,597 ms | 621 ms |
| Unchanged updates, P95 | 1,623 ms | 291 ms |
| Mean unchanged response body | 5,048 bytes | 0 bytes |
| Unchanged updates returning HTTP 304 | 0 / 150 | 150 / 150 |

HTTP headers still consume bandwidth. The full response body remains 5,048 bytes. These single-run local comparisons are not a guarantee of the same production improvement, and do not establish a production P95 below two seconds. A read-only HTTP probe without a signed-in classroom identity returned 401 and was excluded from performance comparisons. Production authenticated latency after deployment remains to be checked against actual classroom traffic.

## Implementation inspected

- `db/classroom-live.ts`, `db/classroom-snapshot-queries.ts`, and `db/classroom-snapshot-data.ts`: combine authorization queries and use two D1 batches to assemble the snapshot, avoiding repeated ranking reads and a response/ranking Cartesian join.
- `db/classroom.ts` and `db/classroom-student-access.ts`: initialize built-in defaults once per Worker isolate; recheck access on every request, but write roster memberships only when missing or inactive.
- `db/classroom-workspace-revision.ts` and the course-session GET route: compute an actor/question-specific revision from current database state. Matching revisions return an empty 304 only after current authorization succeeds.
- `useWorkspaceLoader.ts`: accept conditional responses without reapplying local drafts/ranking choices, pause hidden tabs, and check students every three seconds. Remove the duplicate group-answer poll from `CourseWorkspace.tsx`.
- `AnswerCountdown.tsx`: one-second timer state is confined to the timer component. `StudentProgressiveRanking.tsx` reuses a group lookup and focuses instructions without scrolling. Typing remains synchronous, and the existing draft/version protection remains in place.

No schema migrations, new dependencies, production test accounts, or data resets are required.

## Reproduction and checks

Baseline application source: `bcc93bb826cdcf2f79a46eca7b239bf3151c9117`. To repeat the baseline, build that application in a separate checkout with the current benchmark scripts copied in and use label `before`; the additional refresh checks run only with label `after`. Do not overwrite the recorded evidence unless intentionally rerunning the experiment.

For the updated source, run `npm run build`, then `node scripts/benchmark-classroom-performance.mjs after`. Keep other local builds and load tests stopped during measurement. The script creates and removes its own temporary database.

Validation performed:

- `npm run gate:static`: types, lint and existing code-quality limits; reduced existing baselines rather than adding exceptions.
- `npm run test:unit`: 90 tests, including slow/failed autosave, latest one-character submission, unchanged polling preserving local text, visibility changes and actor/question separation.
- `npm run test:workflow`: 17 SQL workflow tests.
- `npm run gate:build`: deployment build and four bundle/integration checks.
- `npm run test:api-simulation`: 343 isolated requests covering response conflicts, representative permissions, student ranking, publication, history and group management; no unexpected failures. The intentionally cancelled request produces the existing local Windows workerd disconnect diagnostic.
- The performance runner verifies empty unchanged responses, no repeated active-membership writes, fresh draft/speaker/group/ranking/phase/course updates, cross-actor/question separation, access removal and deleted-course rejection.

Browser interaction timings, real student devices, a prolonged production load test, and dependency/mutation audits were not run for this change. Existing dependencies and ranking/answer rules remain unchanged.

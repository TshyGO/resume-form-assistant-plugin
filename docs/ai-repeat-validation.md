# AI-assisted repeated sections: validation

Date: 2026-09-05. Synthetic data only. Model: SiliconFlow `deepseek-ai/DeepSeek-V4-Flash`.

## Real API + browser prototype

Actual `background.js` planning/matching and actual content scripts were connected through a localhost-only test bridge. The bridge replaced Chrome messaging/storage, retained the credential only in process memory, used the official API URL, and enforced a four-request budget. The test page exposed its shadow root for browser automation. This was not a packaged-extension test on a real recruitment site.

| Scenario | Plan | Browser result | API duration |
| --- | --- | --- | --- |
| Papers: one row, three source records | Add two papers | Three rows; all nine text fields correct | Plan 1.23 s; matching 1.48 s |
| Education, work, projects: one row each, two source records each | Add one row per section | Two rows each; all 17 empty fields correct; manually entered company preserved | Plan 2.31 s; matching 3.74 s |

Both scenarios used real confirm previews and asynchronous insertion of fieldsets. The unrelated field was unchanged, and the instrumented submit button was never clicked. Four inference calls total; no retries. These samples establish feasibility, not a universal success rate.

## Automated regression coverage

`node --test tests/*.test.js`: 96 tests pass, including:

- Record counting and anchored keys; complete/ambiguous sections skipped.
- Submit/delete/instruction-like labels rejected; only exact add buttons accepted.
- Invented selectors/code, invalid IDs, duplicate actions, invalid/excessive counts rejected.
- Add-and-rescan loop; no-growth stops after one click; changed content/button and abnormal row growth stop.
- Stop and declined preview perform no additions and clean UI timers.
- Existing/unrelated fields and edits made during the API wait are not overwritten in assisted mode.
- Planner sends only candidate labels/types/counts, not resume values.
- Existing date, cascade detection, PDF, cancellation and diagnostic tests remain passing.

## Deliberate limits

Opt-in preview, at most five additions, exact supported section/button structure, visible text inputs/textareas only. No arbitrary scripts, navigation, submit, deletion or automatic rollback. A short value readback does not prove server-side persistence. Native/browser lifecycle termination remains possible. Real websites using custom controls, modals, iframes, shadow DOM or reactive row replacement require separately verified adapters; users should use the manual fallback and review before submitting.

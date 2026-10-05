# Control adapter browser acceptance (#221)

All values are fictional. Never save, submit, or apply from a recruitment page.

`date-controls.html` is self-contained. Serve the repository root over localhost,
open this path, and evaluate `await runCases()`. It covers native month acceptance,
a 60 ms blur rollback, a removed target, and an unsupported readonly control.
Expected reasons are respectively success, `value_reverted`,
`element_disconnected`, and `unsupported_control`. Success must survive focus change.

`antd-v4.html` uses actual controlled AntD components (month/date/year), not a mock
of React state. Extract npm packages react@17.0.2, react-dom@17.0.2,
moment@2.30.1 and antd@4.24.16 into
`output/playwright/vendor/<package-name>/package/`. Those development files are
ignored and are not extension dependencies or release assets. Serve the repository
root, open this fixture, and evaluate `await runCases()`. All three controls must
return `ok: true` and `retainedAfterFocusChange: true`. Repeat with `?locale=zh-cn`
to validate actual Chinese locale cell titles. Its month wrapper class and
readonly input mirror the inspected Liepin birth-month structure; library tests
alone do not establish live-site acceptance.

Live Liepin verification uses `https://c.liepin.com/resume/create`, then “立即填写”,
and only the empty birth-month control. The old native value setter plus
input/change/synthetic blur reported success for fictional `1998-06`, but an
actual focus/blur cleared it. For the candidate, invoke `operate()` on
`.resume-valid-birthday input` with `pickerType: 'antd'`, deliberately retaining the
scanner's inferred `pickerInputType: 'date'`. The actual month panel must determine
the format. After operation, click blank space, focus another field, and return:
the birth month must remain. Refresh afterwards; do not save the resume.

The self-contained fixture also checks actual native select/radio/checkbox
activation. Native `.click()` may emit trusted input/change; those synchronous
events must not be confused with a later user edit.
The React fixture additionally rejects radio/checkbox activation on purpose. Both
must return `value_not_committed` and remain unchecked; do not force DOM state after
the framework rejected a click.

Record each browser/version, Windows platform, source SHA, page/fixture and results
in the PR. Keep live-site and synthetic/library evidence separate. Cancellation,
trusted edits and final success-count corrections also have integration coverage
in `tests/fill-highlight.test.js`; adapter guard and settlement failures are covered
in `tests/control-adapters.test.js`.

# #222 custom control fixtures

These pages mount actual libraries; they are not library-shaped HTML mocks. All
values are fictional. No submit/save buttons or API writes are present.

Versions: React/ReactDOM 17.0.2, Ant Design 4.24.16, Element Plus 2.14.6 with Vue
3.5.43, and Arco React 2.66.16. Library files live under the ignored
`output/playwright/vendor/<name>/package/` directories, never in the plugin zip.
Use `npm pack <package>@<version> --ignore-scripts` into that ignored directory
and unpack each tarball into its library subdirectory. `custom-antd.html` also
needs Moment 2.30.1. See the paths in each page for the UMD files and CSS.

Serve the repository root on localhost. Pages:

- `custom-antd.html`
- `custom-element.html`
- `custom-arco.html`

In each page, `await runCases()` runs a controlled single select, a three-level
cascader, and a controlled select which refuses the requested value. The first
two must return `ok: true`, retain the expected selection after focus changes,
and pass the read-only final check. The rejecting field must return failure,
leave its committed selection empty and have no success check. The scanner must
return exactly three logical fields with the matching titles; component roots,
inputs and popup contents must not appear as duplicate fields.

Use Chrome and Edge independently and record the candidate commit, browser
version, library version, returned reasons and final state. These fixture runs
do not replace the separate live Ant Design/Element website acceptance required
by #222. Synthetic DOM tests also cover portal association, delayed options,
search changes, disabled/placeholder choices, duplicate choices, blur rollback,
cancellation, and refusal to reuse a stale child column after a rejected parent.

The adapter dispatches synthetic pointer/mouse events; it does not turn them
into `isTrusted` user events. Unsupported multi-select shapes fail closed.

Repository verification:

```powershell
node --test tests/custom-controls.test.js tests/field-scan-content.test.js
npm test
npm run typecheck
node desktop/scripts/check-plugin-release-allowlist.js
```

The package check expands HEAD: first commit the new runtime module so the
check can verify the exact files that git archive will package.

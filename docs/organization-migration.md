# PTJ Works ownership compatibility

Target: `ptjworks/resume-form-assistant-plugin`, preserving repository name,
extension/store IDs, Native Messaging identities and the public website URL.
The repository remains at `TshyGO` until the legacy-client gate below is resolved.
No private repository is part of this work.

## Released-client gate: transfer is not approved

The published desktop `0.4.4` updater comes from commit
`d7d7331e6294efd002d6b9e2d77a8490462914ba`. It only accepts release-page paths
under `/TshyGO/resume-form-assistant-plugin/releases/`. GitHub follows the old API
route after a repository transfer but returns canonical new-owner `html_url`
values. That released binary rejects those values and reports `UPDATE_FAILED`.

The Windows CI step **Replay released updater ownership gate** fetches that exact
public source commit, compiles its original updater in a test harness, and checks
both outcomes: it can offer a synthetic next Stable version with an old-owner
URL before transfer, and rejects the same response using the organization URL.
This is released-source algorithm replay, not an installed-binary upgrade test.
Its success proves the blocker, not that transfer is safe.

The compatibility changes in current source do not patch installed binaries.
Publishing a bridge release while the repository is still personal gives existing
users a working route to that bridge. It cannot guarantee that every user has
installed it. Do not transfer the repository merely because a bridge exists:
unmigrated clients still lose in-app update discovery after transfer. Any accepted
one-time manual-download requirement must be explicitly agreed before transfer.

Desktop updates only open the verified download page; they do not silently
download or install unsigned installers. A bridge release still needs the existing
release SOP, real Windows/macOS upgrade and Native Messaging acceptance, and the
final published artifact hashes. Do not reuse an existing version or move a tag.

## Compatible current source

- The updater requests public Releases through immutable repository ID
  `1217054301`. Release-page validation accepts exactly the personal and
  organization paths, retaining HTTPS, host, credential, port and path guards.
  Beta and extension releases remain excluded from Stable desktop offers.
- The statistics Worker uses that same fixed API identity and retains manual
  redirect rejection. It never forwards its credential to a redirected host.
  The historical snapshot `repository` value stays
  `TshyGO/resume-form-assistant-plugin`: it is a dataset key, not the transport
  route. Existing release/asset IDs and counters keep their history; no D1 schema
  or table reset is needed.
- The release workflow enables production metrics for Stable tag pushes from
  either approved owner. Forks, Beta, plugin tags and workflow-dispatch dry runs
  keep production metrics disabled. Stable-main ancestry and packaging guards
  remain required.
- The central AI configuration registers both identities without changing Lane
  policy or credential slots. Both caller SHA fields must remain identical.

## Remaining cutover checks

1. Publish and accept the bridge under the personal owner; record the exact
   installed old version, candidate/final hashes, retained profile data and actual
   extension/Native Messaging connection on the relevant real machines.
2. Resolve the old-binary population/manual-download decision above.
3. Deploy the reviewed statistics Worker while preserving production bindings,
   enabled flags, email restrictions and D1 data. Check a real read-only GitHub
   collection and historical asset continuity. A CI Workerd fixture is not a
   production collection, and a dry-run build is not deployment.
4. Verify the public website and any store submission service can still resolve
   the current release; preserve store IDs and staged/manual publication policy.
5. Re-inventory repository state, transfer only after the gates pass, then verify
   repository/Release IDs and assets, old/new Git/API/download routes, updater
   behavior, production metrics, new-owner AI review and Stable pipeline behavior.

The existing public production Worker remains unchanged until its reviewed
deployment is performed separately. Do not treat this preparation as migration,
production deployment, publication or real-device upgrade acceptance.

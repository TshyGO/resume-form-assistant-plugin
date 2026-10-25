# PTJ Works ownership compatibility

Target: `ptjworks/resume-form-assistant-plugin`, preserving repository name,
extension/store IDs, Native Messaging identities and the public website URL.
The operator accepted the manual-download cutover on 2026-10-25. No bridge
version will be published; operational cutover verification is still required.
No private repository is part of this work.

## Released-client limitation and accepted manual-download cutover

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
On 2026-10-25 the operator explicitly chose not to publish a bridge and accepted
manual downloads for existing users. Desktop 0.4.4 continues to require manual
update discovery after transfer; downloading the same old 0.4.4 installer does
not repair it. The next ordinary release containing the new updater restores
in-app discovery for users who install that release manually. This is accepted
behavior, not a claim that released old binaries pass organization URL checks.

Desktop updates only open the verified download page; they do not silently
download or install unsigned installers. No version, tag or Release is created
as part of this migration. Future ordinary releases still require the existing
release SOP, real Windows/macOS and Native Messaging acceptance, and published
artifact hashes. Do not reuse an existing version or move a tag.

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
  Collection remains bounded at 40 GitHub requests (below the Workers Free limit
  of 50 external subrequests). The prior 24-call budget barely covered the 22
  current releases and could not collect two further desktop/extension releases.
  Budget exhaustion still rejects the entire collection without partial writes.
- The release workflow enables production metrics for Stable tag pushes from
  either approved owner. Forks, Beta, plugin tags and workflow-dispatch dry runs
  keep production metrics disabled. Stable-main ancestry and packaging guards
  remain required.
- The central AI configuration registers both identities without changing Lane
  policy or credential slots. Both caller SHA fields must remain identical.

## Cutover checks

1. Deploy the reviewed statistics Worker while preserving production bindings,
   enabled flags, email restrictions and D1 data. Use the exact tested bundle
   and SHA-256 saved by the Test workflow; verify a real GitHub collection and
   historical asset continuity. A fixture or dry-run is not production acceptance.
2. Verify the public website resolves the current release through the immutable
   ID and accepts canonical organization assets; preserve store IDs and staged
   publication policy. No bridge or store submission is required for this cutover.
3. Re-inventory public repository state, transfer the original repository, and
   verify repository/Release IDs and assets, old/new Git/API/download routes,
   organization AI review and Stable workflow configuration.
4. Future normal versions must include the dual-owner updater and enable
   production metrics only for actual Stable tag pushes from the organization.
   An actual Stable publication remains separate from a workflow dry run.

No private repository is changed. Keep the public website and client statistics
endpoint stable. Only the GitHub repository identity changes; historical asset
counters and the statistics dataset key remain continuous.

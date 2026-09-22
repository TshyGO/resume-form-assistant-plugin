# Desktop application workspace UI

Selected direction: Superdesign B, 专注工作台 (2026-09-22).
Design: https://p.superdesign.dev/draft/bb1861d3-2211-477a-90f7-68bee622e68c

Visual thesis: charcoal navigation, quiet green actions, white list and a pale contextual inspector.
Content plan: application heading and primary action; search/filter toolbar; readable company/role list; selected application facts and grouped actions; timeline/evidence/snapshot tabs.
Interaction thesis: subtle hover/selection color changes, visible keyboard focus, native dialogs and disclosures with Escape, reduced-motion support.

## Scope

Desktop navigation, shared visual tokens and controls, applications list/detail, settings, evidence inbox and todos. Browser extension and Rust command/data contracts are unchanged. Existing imperative views remain mounted through their current controllers; the new detail controls only manage presentation. No remote fonts, icon scripts, Tailwind runtime or other design-preview CDN dependencies are shipped.

The source retains every stage and action, explicit submission confirmation, history-only progress default, unknown occurrence dates, evidence classification semantics and snapshot disclaimers. Application labels remain escaped before entering HTML.

## Layout

At 1440px the list and up-to-420px inspector are side by side. At the default 1100px width the inspector is at least 320px and the list location column is omitted (location is available in detail). At 960px and below, the list and inspector stack in a scrollable workspace. Navigation remains visible and the toolbar wraps.

## Validation

- TypeScript check and production Vite build passed.
- 153 existing frontend logic tests passed.
- 55 DOM/React tests passed, including new integration coverage using the actual HTML shell for keyboard tabs, selected application changes and preservation of all action entries.
- Chromium checks at 1440x960, 1100x740 and 860x560 with synthetic in-memory IPC: selection, keyboard tabs, progress cancellation, edit save, stage filter, search no-results and long role titles. No page errors in that check.
- git diff --check passed.

This is not native Tauri acceptance. An existing desktop process was left running, and port 1420 returned EACCES. Browser checks used Vite on port 5178 and a temporary preview on 5180. No real archive was read or changed. Native WebView and installation acceptance remain to be run before release.
## Settings

The settings screen now has five categories: General, Browser connection, AI, Data and backup, and About and diagnostics. General is the initial category. Technical runtime facts are collapsed under About; internal milestone labels and raw lifecycle enum values are translated. Empty notices do not render a box. Installation shortcuts select the browser category before focusing its action.

All original command-bound element ids remain present. Category changes hide panels without unmounting them, preserving unsaved AI and extension fields. Data-category refresh preserves a pending restore preview; only its explicit confirmation calls the restore command. Backup privacy notices and destructive-action confirmation remain intact.

Additional checks: settings keyboard navigation, preserved inputs, original restore-preview/confirmation controller integration, installation shortcut, five browser-rendered categories, and overflow checks at 860px. Browser checks use synthetic IPC; native dialogs and archive mutations have not been exercised in this preview.
## Evidence inbox and todos

The evidence inbox uses a workspace header, compact import area, selectable evidence list and a scrollable preview/organize pane. Original text remains escaped; association still requires an explicit application selection, and classification/AI commands remain unchanged. A removed selection now invalidates any outstanding preview response. Narrow windows stack the list and preview.

Todos now lead with due-date groups and filtering. New/edit use a native dialog, with fields locked during submission and cancel/Escape blocked while saving. Successful submission closes the dialog; errors retain input. Editing displays and locks the linked application because the existing edit command does not change that link. The filter is outside the form, so reset no longer changes it.

Checks: existing 153 logic tests; DOM/React suite including creation cancellation, failed-save draft retention, edit association and evidence escaping/explicit association; browser smoke at 1100x740, 1440x960 and 860x560 covering classification, association, create, edit, complete, filter and Escape. Preview data and writes are in-memory only. Native import dialogs, OS notifications and real archive operations remain outside this browser validation.

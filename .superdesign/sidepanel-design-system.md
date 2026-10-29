# Side panel design system

Static HTML and vanilla CSS, no runtime UI library. Existing app identity: dark #1c2330 header; white cards on #f2f4f7; restrained #36756b green actions, #20242d text, #687080 secondary text; 14px Segoe UI / PingFang SC / Microsoft YaHei. Cards radius14px, controls10px, segmented navigation12px.

Fixed navigation: 填写 / 简历字段 / 邮件. Always default to 填写. No red dot, auto-switch or automatic email reading. Fill keeps its existing48px prominent action. Mail uses a flat44px green save button within its own panel. Mail workflow: title, purpose, current mailbox context; always-visible step 1 application association; step 2 save action and selection summary within the same white card. Use a subtle inner divider, shared left edges and a continuous scroll surface; no separate pinned save bar. Unsupported pages show short instructions and disabled controls. Email page has no resume-template or AI setup prompts. Footer is shared and fixed.

Application association: Enter and the search button run the same explicit lookup. Feedback appears beside search. Results are visible company/role radio rows; never auto-select a match. A pale green row marks the selected choice. Always offer an unassociated choice and show the current company/role in the same-card save section. Editing company text clears stale choices. Keep native radio keyboard behavior and preserve focus when changing selection.

Jobs precede the unassociated radio row. Both use identical two-line row structure, padding, width, radio alignment and selection treatment. Never collapse association. Primary save text explicitly distinguishes 保存并关联 from 暂不关联并保存. Scroll search results, outcomes and excerpt confirmation into view.

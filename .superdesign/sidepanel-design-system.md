# Side panel design system

Static HTML and vanilla CSS, no runtime UI library. Existing app identity: dark #1c2330 header; white cards on #f2f4f7; restrained #36756b green actions, #20242d text, #687080 secondary text; 14px Segoe UI / PingFang SC / Microsoft YaHei. Cards radius14px, controls10px, segmented navigation12px.

Fixed navigation: 填写 / 简历字段 / 邮件. Always default to 填写. No red dot, auto-switch or automatic email reading. Fill keeps its existing48px prominent action. Mail uses a flat44px green save button within its own panel. Mail card: title, short purpose, current mailbox context, collapsed optional association, save, result. Unsupported pages show short instructions and disabled controls. Email page has no resume-template or AI setup prompts. Footer is shared and fixed.

Application association: Enter and the search button run the same explicit lookup. Feedback appears beside search. Results are visible company/role radio rows; never auto-select a match. A pale green row marks the selected choice. Always offer an unassociated choice and show the current company/role outside the collapsible area. Editing company text clears stale choices. Keep native radio keyboard behavior and preserve focus when changing selection.

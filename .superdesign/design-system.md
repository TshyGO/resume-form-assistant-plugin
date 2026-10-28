# Visual tokens
:root {
  --bg: #f5f6f8;
  --panel: #ffffff;
  --ink: #20242d;
  --muted: #687080;
  --line: #e2e6ed;
  --accent: #36756b;
  --accent-pale: #e9f3f0;
  /* 搜索命中高亮：由 --accent 派生。底色比 --accent-pale 深一档，选中行（底色 --accent-pale）上也看得出来。 */
  --accent-strong: #24534b;
  --accent-mark: #cfe3de;
  --danger: #b44747;
  --ok: #24785b;
  --surface: #f5f6f8;
  --card-line: #e2e6ed;
  --shadow: 0 1px 2px #1c23300a, 0 4px 16px #1c23300d;
}


Font 14px/1.6 Segoe UI, PingFang SC, Microsoft YaHei. White cards on #f5f6f8; dark nav, restrained green primary action. Controls 34–38px high, corner radii 6–16px, subtle borders and shadows. Dialog close/escape restore focus.

Mail attachments should use compact full-width rows and a 960px-wide native dialog. Left attachment list 220px, right PDF/image viewer. At narrow viewport stack list selector on top. File operations in top bar, page/zoom toolbar below. No logo inside dialog. Use inline line icons (same strokes as app). All text Chinese.

Notification recycle uses the existing inbox segmented status tabs (待确认 / 待关联 / 回收站), reader and list. Move is a neutral action beside organizer; restore is a restrained green primary action. Preserve original and attachments, explain recovery near the body. No permanent-delete action.

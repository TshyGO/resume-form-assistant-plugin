export interface Notice {
  tone: "ok" | "warn" | "error";
  text: string;
}

// 手改完 Excel 之后，用户一眼能核对的只有字段数，所以要说出来；数量没变多半是选错了文件。
export function importMessage(fieldCount: number, previous: number | null): Notice {
  if (previous === null) return { tone: "ok", text: `简历模板导入成功，共 ${fieldCount} 个字段。` };
  if (previous === fieldCount) {
    return {
      tone: "warn",
      text: `模板已覆盖，仍是 ${fieldCount} 个字段，数量没有变化。如果刚在 Excel 里加过内容，请确认选中的是改完并保存后的那份文件。`,
    };
  }
  return { tone: "ok", text: `模板已覆盖，字段 ${previous} → ${fieldCount} 个。` };
}

// 与 resume-sheet 的 export_file_name 同一口径：导入时模板名取自文件名，所以保留原名。
export function exportFileName(templateName: string): string {
  const safe = templateName.replace(/[\\/:*?"<>|\u0000-\u001f]/g, "").trim();
  return `${safe || "简历模板"}.xlsx`;
}

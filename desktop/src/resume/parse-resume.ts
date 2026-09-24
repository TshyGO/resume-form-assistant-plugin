import type { TemplateGroupView } from "../api.ts";
import { parseHelpers, RESUME_PARSE_SYSTEM_PROMPT, RESUME_PARSE_USER_PREFIX } from "./parse-helpers.ts";
import type { ParsedField } from "./parse-helpers.ts";

// 与插件 ai-worker.js parseJsonContent 一致。
function parseJsonContent(content: string): unknown {
  const cleaned = content.trim().replace(/^```json/i, "").replace(/^```/i, "").replace(/```$/i, "").trim();
  return JSON.parse(cleaned);
}

export function parseModelReply(reply: string): ParsedField[] {
  let fields: ParsedField[];
  try {
    fields = parseHelpers.normalizeParsedFields(parseJsonContent(reply));
  } catch {
    throw new Error("AI 返回格式异常，无法解析。");
  }
  if (!fields.length) throw new Error("AI 未能提取到有效信息，请检查文件内容。");
  return fields;
}

// 与插件 popup.js parsedFieldsToGroups 一致。
export function fieldsToGroups(fields: ParsedField[]): TemplateGroupView[] {
  const map = new Map<string, Array<{ key: string; value: string }>>();
  for (const field of fields) {
    if (!map.has(field.group)) map.set(field.group, []);
    map.get(field.group)!.push({ key: field.key, value: field.value });
  }
  return [...map].map(([name, groupFields]) => ({ name, fields: groupFields }));
}

export function templateNameFor(fileName: string): string {
  const stem = fileName.replace(/\.[^.]+$/, "").trim();
  return `${stem || "简历"}（AI 解析）`;
}

export function buildRequest(text: string): { system: string; user: string } {
  return { system: RESUME_PARSE_SYSTEM_PROMPT, user: `${RESUME_PARSE_USER_PREFIX}${text}` };
}

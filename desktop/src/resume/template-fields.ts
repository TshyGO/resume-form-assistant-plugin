// 插件的 template-fields.js 是 IIFE：没有 CommonJS 时把 API 挂到 globalThis.ResumeProTemplateFields。
// 与 profile.ts 一样只做一次副作用导入，再给 TS 一个有类型的入口（#273）。
import "./template-fields.js";
import type { TemplateGroupView } from "../api.ts";

export interface DraftField {
  id: string;
  category: string;
  key: string;
  value: string;
  origin: { category: string; key: string; value: string } | null;
}

export interface TemplateDraft {
  templateId: string;
  templateName: string;
  base: TemplateGroupView[];
  categories: string[];
  fields: DraftField[];
  nextId: number;
}

export interface DraftCheck {
  fieldErrors: Record<string, string>;
  problems: string[];
  warnings: string[];
  ok: boolean;
}

export interface ChangeSummary {
  added: number;
  changed: number;
  moved: number;
  removed: number;
}

interface TemplateFieldsApi {
  MAX_TEMPLATE_BYTES: number;
  UNGROUPED: string;
  createDraft(template: { id: string; name: string; groups: TemplateGroupView[] }): TemplateDraft;
  addCategory(draft: TemplateDraft, name: string): { draft: TemplateDraft; category: string | null; error: string | null };
  addField(draft: TemplateDraft, field: { category: string; key?: string; value?: string }): { draft: TemplateDraft; id: string };
  updateField(draft: TemplateDraft, id: string, patch: Partial<Pick<DraftField, "key" | "value" | "category">>): TemplateDraft;
  removeField(draft: TemplateDraft, id: string): TemplateDraft;
  toGroups(draft: TemplateDraft): TemplateGroupView[];
  emptyCategories(draft: TemplateDraft): string[];
  validateDraft(draft: TemplateDraft): DraftCheck;
  isDirty(draft: TemplateDraft): boolean;
  summarizeChanges(draft: TemplateDraft): ChangeSummary;
  describeChanges(summary: ChangeSummary): string;
  profileFallbacks(
    draft: TemplateDraft,
    profileFields: Array<{ key: string; value: string }>,
    normalizeKey?: (value: string) => string,
  ): string[];
  contentSha256(groups: TemplateGroupView[]): Promise<string>;
}

export const templateFields = (globalThis as unknown as { ResumeProTemplateFields: TemplateFieldsApi }).ResumeProTemplateFields;

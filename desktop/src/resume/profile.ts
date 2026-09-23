// 插件的 profile-fields.js 是 IIFE：没有 CommonJS 时把 API 挂到 globalThis.ResumeProProfile。
// 这里只做一次副作用导入，再给 TS 一个有类型的入口。
import "./profile-fields.js";

export interface ProfileFieldDef {
  id: string;
  key: string;
  label?: string;
  type?: "select" | "month" | "textarea";
  options?: string[];
  placeholder?: string;
  aliases?: string[];
}

export interface ProfileGroupDef {
  name: string;
  fields: ProfileFieldDef[];
}

export interface FamilyMember {
  relation: string;
  [field: string]: string;
}

export interface CustomField {
  key: string;
  value: string;
}

export interface Profile {
  values: Record<string, string>;
  family: FamilyMember[];
  custom: CustomField[];
}

interface ProfileApi {
  PROFILE_SCHEMA: ProfileGroupDef[];
  FAMILY_FIELDS: ProfileFieldDef[];
  FAMILY_RELATIONS: string[];
  FAMILY_GROUP: string;
  CUSTOM_GROUP: string;
  normalizeProfile(raw: unknown): Profile;
  emptyProfile(): Profile;
  countPendingFields(profile: Profile): number;
}

export const profileApi = (globalThis as unknown as { ResumeProProfile: ProfileApi }).ResumeProProfile;

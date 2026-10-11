import { profileApi } from "./profile.ts";
import type { CustomField, Profile } from "./profile.ts";

export type ProfileConflict =
  | { id: string; kind: "value"; field: string; label: string; local: string; remote: string; remoteValue: string }
  | { id: string; kind: "family-field"; index: number; field: string; label: string; local: string; remote: string; remoteValue: string }
  | { id: string; kind: "family"; label: string; local: string; remote: string }
  | { id: string; kind: "custom"; key: string; label: string; local: string; remote: string; localItem?: CustomField; remoteItem?: CustomField; newlyAdded: boolean };

export type ConflictChoice = "local" | "remote" | "both";

const fieldLabels = new Map(profileApi.PROFILE_SCHEMA.flatMap((group) =>
  group.fields.map((field) => [field.id, field.label ?? field.key] as const),
));
const familyLabels = new Map(profileApi.FAMILY_FIELDS.map((field) => [field.id, field.label ?? field.key] as const));

function show(value: string | undefined): string {
  return value || "（未填写）";
}

function customMap(items: CustomField[]): Map<string, CustomField> {
  return new Map(items.map((item) => [profileApi.normalizeKey(item.key), item]));
}

function sameCustom(left?: CustomField, right?: CustomField): boolean {
  return left?.key === right?.key && left?.value === right?.value;
}

function familySummary(profile: Profile): string {
  return profile.family.map((member, index) => {
    const details = Object.entries(member).filter(([, value]) => value).map(([key, value]) =>
      `${familyLabels.get(key) ?? key}：${value}`,
    );
    return `成员 ${index + 1} ${details.join("，")}`;
  }).join("；") || "（无家庭成员）";
}

// 只把能证明是新增、无重名且为空的字段自动加入草稿；其余外部变化让用户决定。
export function inspectProfileUpdate(base: Profile, draft: Profile, incoming: Profile): {
  additions: CustomField[];
  conflicts: ProfileConflict[];
} {
  const baseClean = profileApi.normalizeProfile(base);
  const remote = profileApi.normalizeProfile(incoming);
  const conflicts: ProfileConflict[] = [];
  const additions: CustomField[] = [];

  for (const field of new Set([...Object.keys(baseClean.values), ...Object.keys(remote.values)])) {
    const before = baseClean.values[field] ?? "";
    const outside = remote.values[field] ?? "";
    const local = draft.values[field] ?? "";
    if (outside !== before && outside !== local) {
      conflicts.push({ id: `value:${field}`, kind: "value", field, label: fieldLabels.get(field) ?? field, local: show(local), remote: show(outside), remoteValue: outside });
    }
  }

  if (JSON.stringify(baseClean.family) !== JSON.stringify(remote.family)) {
    const draftStructureChanged = draft.family.length !== baseClean.family.length
      || draft.family.some((member, index) =>
        member.relation !== baseClean.family[index].relation || member.name !== baseClean.family[index].name,
      );
    if (baseClean.family.length !== remote.family.length || draftStructureChanged) {
      if (JSON.stringify(draft.family) !== JSON.stringify(remote.family)) {
        conflicts.push({ id: "family", kind: "family", label: "家庭成员", local: familySummary(draft), remote: familySummary(remote) });
      }
    } else {
      remote.family.forEach((member, index) => {
        for (const field of new Set([...Object.keys(baseClean.family[index]), ...Object.keys(member)])) {
          const before = baseClean.family[index][field] ?? "";
          const outside = member[field] ?? "";
          const local = draft.family[index]?.[field] ?? "";
          if (outside !== before && outside !== local) {
            conflicts.push({ id: `family:${index}:${field}`, kind: "family-field", index, field,
              label: `成员 ${index + 1} ${familyLabels.get(field) ?? field}`, local: show(local), remote: show(outside), remoteValue: outside });
          }
        }
      });
    }
  }

  const previous = customMap(baseClean.custom);
  const current = customMap(draft.custom);
  const latest = customMap(remote.custom);
  for (const key of new Set([...previous.keys(), ...latest.keys()])) {
    const before = previous.get(key);
    const outside = latest.get(key);
    if (sameCustom(before, outside)) continue;
    const local = current.get(key);
    if (sameCustom(local, outside)) continue;
    if (!before && outside && !outside.value && !local) {
      additions.push(outside);
      continue;
    }
    conflicts.push({ id: `custom:${key}`, kind: "custom", key,
      label: outside?.key ?? local?.key ?? before?.key ?? "补充字段",
      local: local ? show(local.value) : "（无此字段）",
      remote: outside ? show(outside.value) : "（已删除）",
      localItem: local, remoteItem: outside, newlyAdded: !before && Boolean(outside) });
  }
  return { additions, conflicts };
}

export function applyProfileChoices(
  draft: Profile,
  additions: CustomField[],
  conflicts: ProfileConflict[],
  choices: Record<string, ConflictChoice>,
  renames: Record<string, string>,
): Profile {
  const next: Profile = {
    values: { ...draft.values },
    family: draft.family.map((member) => ({ ...member })),
    custom: draft.custom.map((item) => ({ ...item })),
  };
  for (const conflict of conflicts) {
    const choice = choices[conflict.id];
    if (choice === "local") continue;
    if (conflict.kind === "value") {
      next.values[conflict.field] = conflict.remoteValue;
    } else if (conflict.kind === "family") {
      // Full-family replacement is applied separately by the caller with the remote snapshot.
      continue;
    } else if (conflict.kind === "family-field") {
      if (next.family[conflict.index]) next.family[conflict.index][conflict.field] = conflict.remoteValue;
    } else {
      const index = next.custom.findIndex((item) => profileApi.normalizeKey(item.key) === conflict.key);
      if (choice === "both" && conflict.localItem && conflict.remoteItem) {
        if (index >= 0) next.custom[index] = { ...next.custom[index], key: renames[conflict.id].trim() };
        next.custom.push({ ...conflict.remoteItem });
      } else if (index >= 0 && conflict.remoteItem) {
        next.custom[index] = { ...conflict.remoteItem };
      } else if (index >= 0) {
        next.custom.splice(index, 1);
      } else if (conflict.remoteItem) {
        next.custom.push({ ...conflict.remoteItem });
      }
    }
  }
  next.custom.push(...additions.filter((item) =>
    !next.custom.some((existing) => profileApi.normalizeKey(existing.key) === profileApi.normalizeKey(item.key)),
  ));
  return next;
}

export function validSeparateName(name: string, profile: Profile, conflict: ProfileConflict): boolean {
  if (conflict.kind !== "custom") return false;
  const normalized = profileApi.normalizeKey(name);
  return Boolean(normalized) && !profile.custom.some((item) =>
    profileApi.normalizeKey(item.key) === normalized && profileApi.normalizeKey(item.key) !== conflict.key,
  ) && normalized !== conflict.key;
}

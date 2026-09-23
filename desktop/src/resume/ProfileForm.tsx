import { useCallback, useEffect, useState } from "react";
import type { ProfileRecordView } from "../api.ts";
import { useInvoke } from "../react/invoke.tsx";
import { profileApi } from "./profile.ts";
import type { FamilyMember, Profile, ProfileFieldDef } from "./profile.ts";
import type { Notice } from "./resume-text.ts";

function emptyMember(): FamilyMember {
  const member: FamilyMember = { relation: profileApi.FAMILY_RELATIONS[0] };
  profileApi.FAMILY_FIELDS.forEach((field) => {
    member[field.id] = "";
  });
  return member;
}

function FieldInput({
  id,
  def,
  value,
  onChange,
  labelPrefix = "",
}: {
  id: string;
  def: ProfileFieldDef;
  value: string;
  onChange(value: string): void;
  /** 家庭成员的「姓名」「出生年月」和本人的同名，加前缀才能让读屏和测试分得清。 */
  labelPrefix?: string;
}) {
  const label = `${labelPrefix}${def.label ?? def.key}`;
  if (def.type === "select") {
    return (
      <label htmlFor={id}>
        {label}
        <select id={id} value={value} onChange={(event) => onChange(event.target.value)}>
          <option value="">未填</option>
          {(def.options ?? []).map((option) => (
            <option key={option} value={option}>
              {option}
            </option>
          ))}
        </select>
      </label>
    );
  }
  if (def.type === "textarea") {
    return (
      <label htmlFor={id}>
        {label}
        <textarea id={id} value={value} placeholder={def.placeholder} onChange={(event) => onChange(event.target.value)} />
      </label>
    );
  }
  return (
    <label htmlFor={id}>
      {label}
      <input
        id={id}
        type={def.type === "month" ? "month" : "text"}
        value={value}
        placeholder={def.placeholder}
        onChange={(event) => onChange(event.target.value)}
      />
    </label>
  );
}

export function ProfileForm() {
  const invoke = useInvoke();
  const [profile, setProfile] = useState<Profile | null>(null);
  const [revision, setRevision] = useState(0);
  const [notice, setNotice] = useState<Notice | null>(null);
  const [conflict, setConflict] = useState(false);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    if (!invoke) return;
    try {
      const record = await invoke<ProfileRecordView>("get_profile_cmd");
      setProfile(profileApi.normalizeProfile(record.profile));
      setRevision(record.revision);
      setConflict(false);
      setNotice(null);
    } catch (error) {
      setNotice({ tone: "error", text: (error as { message?: string })?.message ?? "读取失败。" });
    }
  }, [invoke]);

  useEffect(() => {
    void load();
  }, [load]);

  if (!invoke) return <p className="muted">没有连上桌面程序，「我的信息」要在桌面程序里编辑。</p>;
  if (!profile) return notice ? <p className={`note ${notice.tone}`}>{notice.text}</p> : <p className="muted">正在读取…</p>;

  const setValue = (id: string, value: string) =>
    setProfile({ ...profile, values: { ...profile.values, [id]: value } });
  const setMember = (index: number, field: string, value: string) =>
    setProfile({ ...profile, family: profile.family.map((m, i) => (i === index ? { ...m, [field]: value } : m)) });
  const setCustom = (index: number, field: "key" | "value", value: string) =>
    setProfile({ ...profile, custom: profile.custom.map((c, i) => (i === index ? { ...c, [field]: value } : c)) });

  const save = async () => {
    if (busy) return;
    setBusy(true);
    try {
      // 规范化用插件同一份规则：空值去掉、同名补充字段合并、全空的家庭成员丢掉。
      const normalized = profileApi.normalizeProfile(profile);
      const record = await invoke<ProfileRecordView>("save_profile_cmd", { profile: normalized, revision });
      setProfile(profileApi.normalizeProfile(record.profile));
      setRevision(record.revision);
      setNotice({ tone: "ok", text: "已保存。" });
    } catch (error) {
      const err = error as { code?: string; message?: string } | null;
      setConflict(err?.code === "CONFLICT");
      setNotice({ tone: "error", text: err?.message ?? "保存失败。" });
    } finally {
      setBusy(false);
    }
  };

  return (
    <form
      className="stack profile-form"
      onSubmit={(event) => {
        event.preventDefault();
        void save();
      }}
    >
      {profileApi.PROFILE_SCHEMA.map((group) => (
        <fieldset key={group.name}>
          <legend>{group.name}</legend>
          {group.fields.map((def) => (
            <FieldInput
              key={def.id}
              id={`profile-${def.id}`}
              def={def}
              value={profile.values[def.id] ?? ""}
              onChange={(value) => setValue(def.id, value)}
            />
          ))}
        </fieldset>
      ))}

      <fieldset>
        <legend>{profileApi.FAMILY_GROUP}</legend>
        {profile.family.map((member, index) => (
          <div key={index} role="group" aria-label={`家庭成员 ${index + 1}`} className="row">
            <label htmlFor={`family-${index}-relation`}>
              成员 {index + 1} 关系
              <select
                id={`family-${index}-relation`}
                value={member.relation}
                onChange={(event) => setMember(index, "relation", event.target.value)}
              >
                {profileApi.FAMILY_RELATIONS.map((relation) => (
                  <option key={relation} value={relation}>
                    {relation}
                  </option>
                ))}
              </select>
            </label>
            {profileApi.FAMILY_FIELDS.map((def) => (
              <FieldInput
                key={def.id}
                id={`family-${index}-${def.id}`}
                def={def}
                labelPrefix={`成员 ${index + 1} `}
                value={member[def.id] ?? ""}
                onChange={(value) => setMember(index, def.id, value)}
              />
            ))}
            <button
              type="button"
              onClick={() => setProfile({ ...profile, family: profile.family.filter((_, i) => i !== index) })}
            >
              删除成员
            </button>
          </div>
        ))}
        <button type="button" onClick={() => setProfile({ ...profile, family: [...profile.family, emptyMember()] })}>
          添加家庭成员
        </button>
      </fieldset>

      <fieldset>
        <legend>{profileApi.CUSTOM_GROUP}</legend>
        <p className="muted">从网页上「加到我的信息」的字段会出现在这里，补上内容后下次就能自动填。</p>
        {profile.custom.map((item, index) => (
          <div key={index} role="group" aria-label={item.key || `补充字段 ${index + 1}`} className="row">
            <label htmlFor={`custom-${index}-key`}>
              字段名
              <input id={`custom-${index}-key`} value={item.key} onChange={(event) => setCustom(index, "key", event.target.value)} />
            </label>
            <label htmlFor={`custom-${index}-value`}>
              内容
              <input id={`custom-${index}-value`} value={item.value} onChange={(event) => setCustom(index, "value", event.target.value)} />
            </label>
            {!item.value ? <span className="pill warn">待补充</span> : null}
            <button
              type="button"
              onClick={() => setProfile({ ...profile, custom: profile.custom.filter((_, i) => i !== index) })}
            >
              删除
            </button>
          </div>
        ))}
        <button type="button" onClick={() => setProfile({ ...profile, custom: [...profile.custom, { key: "", value: "" }] })}>
          添加补充字段
        </button>
      </fieldset>

      {notice ? <p className={`note ${notice.tone}`}>{notice.text}</p> : null}
      <div className="row">
        <button type="submit" className="primary" disabled={busy}>
          保存我的信息
        </button>
        {conflict ? (
          <button type="button" onClick={() => void load()}>
            重新读取
          </button>
        ) : null}
      </div>
    </form>
  );
}

import { useCallback, useEffect, useRef, useState } from "react";
import type { ProfileRecordView } from "../api.ts";
import { useInvoke } from "../react/invoke.tsx";
import { profileApi } from "./profile.ts";
import type { FamilyMember, Profile, ProfileFieldDef } from "./profile.ts";
import type { Notice } from "./resume-text.ts";
import type { DesktopEvent, Listen } from "./LegacyImport.tsx";

type ProfileChanged = { revision: number; source: "plugin" };

function profileChangedOf(event?: DesktopEvent): ProfileChanged | null {
  const payload = event?.payload;
  if (!payload || typeof payload !== "object") return null;
  const candidate = payload as Partial<ProfileChanged>;
  return Number.isInteger(candidate.revision) && candidate.source === "plugin"
    ? candidate as ProfileChanged
    : null;
}

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
    // 备份带来的值不在选项里时也要显示出来，不能悄悄被第一个空选项吃掉（对齐插件 popup.js profileInputHtml）。
    const base = def.options ?? [];
    const options = !value || base.includes(value) ? base : [...base, value];
    return (
      <label htmlFor={id}>
        {label}
        <select id={id} value={value} onChange={(event) => onChange(event.target.value)}>
          <option value="">未填</option>
          {options.map((option) => (
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
  // macOS WKWebView 有时把 type=month 渲成普通文本框，给个占位符提示格式。
  const placeholder = def.placeholder ?? (def.type === "month" ? "YYYY-MM" : undefined);
  return (
    <label htmlFor={id}>
      {label}
      <input
        id={id}
        type={def.type === "month" ? "month" : "text"}
        value={value}
        placeholder={placeholder}
        onChange={(event) => onChange(event.target.value)}
      />
    </label>
  );
}

export function ProfileForm({ listen }: { listen?: Listen } = {}) {
  const invoke = useInvoke();
  const [profile, setProfile] = useState<Profile | null>(null);
  const [revision, setRevision] = useState(0);
  const [notice, setNotice] = useState<Notice | null>(null);
  const [conflict, setConflict] = useState(false);
  const [busy, setBusy] = useState(false);
  // 有没有没保存的修改：插件在后台写入时，靠这个决定是直接刷新还是先问用户（#177）。
  const [externalChange, setExternalChange] = useState(false);
  const dirtyRef = useRef(false);
  const revisionRef = useRef(0);
  const editVersionRef = useRef(0);
  const loadSequenceRef = useRef(0);
  const pendingExternalRevisionRef = useRef(0);
  const ignoredExternalRevisionRef = useRef(0);

  const load = useCallback(async (discardLocalChanges = false, externalRevision = 0) => {
    if (!invoke) return;
    const loadSequence = ++loadSequenceRef.current;
    const editVersion = editVersionRef.current;
    try {
      const record = await invoke<ProfileRecordView>("get_profile_cmd");
      // 多次外部更新可能同时读取。只允许最后发起的读取落地，避免旧响应晚到后
      // 把 UI 和 revision 回滚到更早的档案。
      if (loadSequence !== loadSequenceRef.current) return;
      // 自动刷新等待数据库期间，用户可能已经开始输入。此时不能用刚读回的数据覆盖；
      // 改为提示，由用户明确选择是否放弃本地修改。
      if (!discardLocalChanges && editVersionRef.current !== editVersion) {
        pendingExternalRevisionRef.current = Math.max(
          pendingExternalRevisionRef.current,
          externalRevision || record.revision,
        );
        setExternalChange(true);
        return;
      }
      setProfile(profileApi.normalizeProfile(record.profile));
      setRevision(record.revision);
      revisionRef.current = record.revision;
      setConflict(false);
      setNotice(null);
      dirtyRef.current = false;
      setExternalChange(false);
      pendingExternalRevisionRef.current = 0;
      ignoredExternalRevisionRef.current = 0;
    } catch (error) {
      if (loadSequence !== loadSequenceRef.current) return;
      setNotice({ tone: "error", text: (error as { message?: string })?.message ?? "读取失败。" });
    }
  }, [invoke]);

  useEffect(() => {
    void load();
  }, [load]);

  // 插件把补充字段写进档案后发的信号，不带字段内容（#177）。没有未保存的修改就直接重新读取；
  // 有未保存的修改不能替用户做主覆盖掉，只弹提示，读不读由用户自己点。
  useEffect(() => {
    if (!listen) return;
    let active = true;
    let unlisten: (() => void) | undefined;
    void Promise.resolve(
      listen("resume-profile-changed", (event) => {
        if (!active) return;
        const change = profileChangedOf(event);
        // 正式事件总有 revision/source。兼容无 payload 的测试/旧宿主时仍刷新一次；
        // 对当前或更旧 revision 的重复通知则直接忽略。
        if (change && (
          change.revision <= revisionRef.current
          || change.revision <= ignoredExternalRevisionRef.current
        )) return;
        const externalRevision = change?.revision ?? revisionRef.current + 1;
        if (dirtyRef.current) {
          pendingExternalRevisionRef.current = Math.max(
            pendingExternalRevisionRef.current,
            externalRevision,
          );
          setExternalChange(true);
        } else {
          pendingExternalRevisionRef.current = Math.max(
            pendingExternalRevisionRef.current,
            externalRevision,
          );
          void load(false, externalRevision);
        }
      }),
    ).then((stop) => {
      if (!stop) return;
      if (active) unlisten = stop;
      else stop();
    });
    return () => {
      active = false;
      unlisten?.();
    };
  }, [listen, load]);

  if (!invoke) return <p className="muted">没有连上桌面程序，「我的信息」要在桌面程序里编辑。</p>;
  if (!profile)
    return notice ? (
      <p className={`note ${notice.tone}`} role="status">
        {notice.text}
      </p>
    ) : (
      <p className="muted">正在读取…</p>
    );

  // 用户一动手改，上一次保存/冲突的提示就过时了，清掉以免误导。
  const updateProfile = (next: Profile) => {
    editVersionRef.current += 1;
    dirtyRef.current = true;
    setProfile(next);
    setNotice(null);
  };
  const setValue = (id: string, value: string) =>
    updateProfile({ ...profile, values: { ...profile.values, [id]: value } });
  const setMember = (index: number, field: string, value: string) =>
    updateProfile({ ...profile, family: profile.family.map((m, i) => (i === index ? { ...m, [field]: value } : m)) });
  const setCustom = (index: number, field: "key" | "value", value: string) =>
    updateProfile({ ...profile, custom: profile.custom.map((c, i) => (i === index ? { ...c, [field]: value } : c)) });

  const save = async () => {
    if (busy) return;
    setBusy(true);
    try {
      // 规范化用插件同一份规则：空值去掉、同名补充字段合并、全空的家庭成员丢掉。
      const normalized = profileApi.normalizeProfile(profile);
      const record = await invoke<ProfileRecordView>("save_profile_cmd", { profile: normalized, revision });
      const saved = profileApi.normalizeProfile(record.profile);
      setProfile(saved);
      setRevision(record.revision);
      revisionRef.current = record.revision;
      dirtyRef.current = false;
      setExternalChange(false);
      pendingExternalRevisionRef.current = 0;
      ignoredExternalRevisionRef.current = 0;
      // 与插件 popup.js saveProfile 同款措辞：已保存的项数，剩下多少补充字段还没填内容。
      const count = profileApi.countProfileValues(saved);
      const pending = profileApi.countPendingFields(saved);
      setNotice({
        tone: "ok",
        text: pending ? `已保存 ${count} 项，还有 ${pending} 个字段没填内容。` : `已保存 ${count} 项。`,
      });
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
      {externalChange ? (
        <div className="note warn stack" role="status">
          <p>插件添加了新的补充字段。当前页面还有未保存的修改。</p>
          <div className="row">
            <button type="button" onClick={() => void load(true)}>
              重新读取
            </button>
            <button type="button" onClick={() => {
              ignoredExternalRevisionRef.current = Math.max(
                ignoredExternalRevisionRef.current,
                pendingExternalRevisionRef.current,
              );
              pendingExternalRevisionRef.current = 0;
              setExternalChange(false);
            }}>
              稍后处理
            </button>
          </div>
        </div>
      ) : null}

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
              onClick={() => updateProfile({ ...profile, family: profile.family.filter((_, i) => i !== index) })}
            >
              删除成员
            </button>
          </div>
        ))}
        <button type="button" onClick={() => updateProfile({ ...profile, family: [...profile.family, emptyMember()] })}>
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
            {item.key && !item.value ? <span className="pill warn">待补充</span> : null}
            <button
              type="button"
              onClick={() => updateProfile({ ...profile, custom: profile.custom.filter((_, i) => i !== index) })}
            >
              删除
            </button>
          </div>
        ))}
        <button type="button" onClick={() => updateProfile({ ...profile, custom: [...profile.custom, { key: "", value: "" }] })}>
          添加补充字段
        </button>
      </fieldset>

      {notice ? (
        <p className={`note ${notice.tone}`} role="status">
          {notice.text}
        </p>
      ) : null}
      <div className="row">
        <button type="submit" className="primary" disabled={busy}>
          保存我的信息
        </button>
        {conflict ? (
          <button type="button" onClick={() => void load(true)}>
            重新读取
          </button>
        ) : null}
      </div>
    </form>
  );
}

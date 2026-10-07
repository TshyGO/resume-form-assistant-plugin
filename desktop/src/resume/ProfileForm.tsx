import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import type { KeyboardEvent } from "react";
import type { ProfileRecordView } from "../api.ts";
import { useInvoke } from "../react/invoke.tsx";
import { profileApi } from "./profile.ts";
import type { FamilyMember, Profile, ProfileFieldDef } from "./profile.ts";
import type { Notice } from "./resume-text.ts";
import type { DesktopEvent, Listen } from "./LegacyImport.tsx";
import { applyProfileChoices, inspectProfileUpdate, validSeparateName } from "./profile-draft-sync.ts";
import type { ConflictChoice } from "./profile-draft-sync.ts";

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

// 补充字段的一行（#228）：网页上的长题目要整句看得到。字段名和内容用一样宽的自动换行框，
// 两个框取较高的那个一起撑高，看起来是对齐的一行。保存的仍是单行：回车不换行，粘贴进来的换行变成空格。
function CustomFieldRow({
  index,
  item,
  onChange,
  onRemove,
}: {
  index: number;
  item: { key: string; value: string };
  onChange(field: "key" | "value", value: string): void;
  onRemove(): void;
}) {
  const keyRef = useRef<HTMLTextAreaElement>(null);
  const valueRef = useRef<HTMLTextAreaElement>(null);
  const [width, setWidth] = useState(0);

  useLayoutEffect(() => {
    const boxes = [keyRef.current, valueRef.current].filter((box): box is HTMLTextAreaElement => Boolean(box));
    boxes.forEach((box) => {
      box.style.height = "auto";
    });
    const height = Math.max(...boxes.map((box) => box.scrollHeight + box.offsetHeight - box.clientHeight));
    boxes.forEach((box) => {
      box.style.height = `${height}px`;
    });
  }, [item.key, item.value, width]);

  // 窗口变宽变窄时文字重新折行，高度跟着重算。
  useEffect(() => {
    const box = keyRef.current;
    if (!box || typeof ResizeObserver === "undefined") return undefined;
    const observer = new ResizeObserver(() => setWidth(box.clientWidth));
    observer.observe(box);
    return () => observer.disconnect();
  }, []);

  const singleLine = (text: string) => text.replace(/\r?\n/g, " ");
  const noEnter = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === "Enter" && !event.nativeEvent.isComposing) event.preventDefault();
  };

  return (
    <div role="group" aria-label={item.key || `补充字段 ${index + 1}`} className="custom-field-row">
      {/* 「字段名」「内容」只在列表顶上显示一次，这里留给读屏。 */}
      <label htmlFor={`custom-${index}-key`}>
        <span className="sr-only">字段名</span>
        <textarea
          ref={keyRef}
          id={`custom-${index}-key`}
          rows={1}
          value={item.key}
          onKeyDown={noEnter}
          onChange={(event) => onChange("key", singleLine(event.target.value))}
        />
      </label>
      <label htmlFor={`custom-${index}-value`}>
        <span className="sr-only">内容</span>
        <textarea
          ref={valueRef}
          id={`custom-${index}-value`}
          rows={1}
          value={item.value}
          onKeyDown={noEnter}
          onChange={(event) => onChange("value", singleLine(event.target.value))}
        />
      </label>
      <div className="custom-field-actions">
        <span className="custom-field-status">{item.key && !item.value ? <span className="pill warn">待补充</span> : null}</span>
        <button type="button" onClick={onRemove}>
          删除
        </button>
      </div>
    </div>
  );
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
  // 插件更新可以到达正在编辑的表单，草稿与上次读取的基准分别保存。
  const [externalChange, setExternalChange] = useState(false);
  const [deferredExternalChange, setDeferredExternalChange] = useState(false);
  const [confirmDiscard, setConfirmDiscard] = useState(false);
  const [reloading, setReloading] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [pendingRemote, setPendingRemote] = useState<ProfileRecordView | null>(null);
  const [showConflictDetails, setShowConflictDetails] = useState(false);
  const [choices, setChoices] = useState<Record<string, ConflictChoice>>({});
  const [renames, setRenames] = useState<Record<string, string>>({});
  const [confirmExternalChoice, setConfirmExternalChoice] = useState<string | null>(null);
  const reloadPendingRef = useRef(false);
  const savingRef = useRef(false);
  const reloadButtonRef = useRef<HTMLButtonElement>(null);
  const dirtyRef = useRef(false);
  const profileRef = useRef<Profile | null>(null);
  const baseProfileRef = useRef<Profile | null>(null);
  const revisionRef = useRef(0);
  const editVersionRef = useRef(0);
  const loadSequenceRef = useRef(0);
  const pendingExternalRevisionRef = useRef(0);

  const load = useCallback(async (discardLocalChanges = false, externalRevision = 0) => {
    if (!invoke || (discardLocalChanges && reloadPendingRef.current)) return;
    if (discardLocalChanges) {
      reloadPendingRef.current = true;
      setReloading(true);
    } else if (externalRevision) {
      setSyncing(true);
    }
    const loadSequence = ++loadSequenceRef.current;
    const editVersion = editVersionRef.current;
    try {
      const record = await invoke<ProfileRecordView>("get_profile_cmd");
      // 多次外部更新可能同时读取。只允许最后发起的读取落地，避免旧响应晚到后
      // 把 UI 和 revision 回滚到更早的档案。
      if (loadSequence !== loadSequenceRef.current) return;
      const remote = profileApi.normalizeProfile(record.profile);
      const latestRequested = Math.max(externalRevision, pendingExternalRevisionRef.current);
      if (externalRevision && record.revision < latestRequested) {
        setDeferredExternalChange(true);
        return;
      }
      // 用户确认放弃后若又开始输入，不能让晚到的读取覆盖新输入。
      if (discardLocalChanges && editVersionRef.current !== editVersion) {
        setNotice({ tone: "warn", text: "读取期间内容又有修改，已保留当前输入。请停止编辑后再重新读取。" });
        return;
      }
      const draft = profileRef.current;
      const base = baseProfileRef.current;
      if (!discardLocalChanges && draft && base && dirtyRef.current) {
        if (record.revision <= revisionRef.current) return;
        const result = inspectProfileUpdate(base, draft, remote);
        if (result.conflicts.length) {
          setPendingRemote(record);
          setNotice(null);
          setChoices({});
          setRenames({});
          setConfirmExternalChoice(null);
          setExternalChange(false);
          setConflict(true);
          setDeferredExternalChange(false);
          pendingExternalRevisionRef.current = Math.max(pendingExternalRevisionRef.current, record.revision);
          return;
        }
        const merged = { ...draft, custom: [...draft.custom, ...result.additions] };
        profileRef.current = merged;
        setProfile(merged);
        baseProfileRef.current = remote;
        setRevision(record.revision);
        revisionRef.current = record.revision;
        setPendingRemote(null);
        setConflict(false);
        setExternalChange(false);
        setDeferredExternalChange(false);
        pendingExternalRevisionRef.current = 0;
        setNotice(result.additions.length
          ? { tone: "warn", text: "插件新增了补充字段，已加入当前草稿；你的修改仍未保存。" }
          : null);
        return;
      }
      profileRef.current = remote;
      baseProfileRef.current = remote;
      setProfile(remote);
      setRevision(record.revision);
      revisionRef.current = record.revision;
      setConflict(false);
      setPendingRemote(null);
      setShowConflictDetails(false);
      const newerRevision = pendingExternalRevisionRef.current;
      const hasNewerRevision = newerRevision > record.revision;
      setDeferredExternalChange(hasNewerRevision);
      setConfirmDiscard(false);
      setNotice(null);
      dirtyRef.current = false;
      setExternalChange(false);
      pendingExternalRevisionRef.current = hasNewerRevision ? newerRevision : 0;
    } catch (error) {
      if (loadSequence !== loadSequenceRef.current) return;
      if (externalRevision) setDeferredExternalChange(true);
      setNotice({ tone: "error", text: (error as { message?: string })?.message ?? "读取失败。" });
    } finally {
      if (discardLocalChanges) {
        reloadPendingRef.current = false;
        setReloading(false);
      }
      if (externalRevision && loadSequence === loadSequenceRef.current) setSyncing(false);
    }
  }, [invoke]);

  useEffect(() => {
    void load();
  }, [load]);

  // 事件不带字段内容；脏表单先读取到临时数据，再只合入可证明安全的新增空字段。
  useEffect(() => {
    if (!listen) return;
    let active = true;
    let unlisten: (() => void) | undefined;
    void Promise.resolve(
      listen("resume-profile-changed", (event) => {
        if (!active) return;
        const change = profileChangedOf(event);
        // 正式事件总有 revision/source。兼容无 payload 的测试/旧宿主时仍刷新一次；
        // 有 payload 却不符合协议的事件不能伪装成兼容事件触发刷新。
        if (event?.payload !== undefined && !change) return;
        const externalRevision = change?.revision ?? revisionRef.current + 1;
        // 当前、旧、已忽略或已经在读取的 revision 都不重复处理。
        if (
          externalRevision <= revisionRef.current
          || externalRevision <= pendingExternalRevisionRef.current
        ) return;
        pendingExternalRevisionRef.current = Math.max(pendingExternalRevisionRef.current, externalRevision);
        setExternalChange(true);
        if (!savingRef.current && !reloadPendingRef.current) void load(false, externalRevision);
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
    profileRef.current = next;
    setProfile(next);
    if (pendingRemote) {
      setChoices({});
      setConfirmExternalChoice(null);
    }
    setNotice(null);
  };
  const setValue = (id: string, value: string) =>
    updateProfile({ ...profile, values: { ...profile.values, [id]: value } });
  const setMember = (index: number, field: string, value: string) =>
    updateProfile({ ...profile, family: profile.family.map((m, i) => (i === index ? { ...m, [field]: value } : m)) });
  const setCustom = (index: number, field: "key" | "value", value: string) =>
    updateProfile({ ...profile, custom: profile.custom.map((c, i) => (i === index ? { ...c, [field]: value } : c)) });

  const save = async () => {
    if (busy || reloadPendingRef.current || confirmDiscard) return;
    if (pendingRemote || externalChange || deferredExternalChange || conflict || syncing) {
      setShowConflictDetails(true);
      setNotice({ tone: "warn", text: "请先处理外部更新，再保存当前草稿。" });
      return;
    }
    setBusy(true);
    savingRef.current = true;
    const editVersion = editVersionRef.current;
    try {
      // 规范化用插件同一份规则：空值去掉、同名补充字段合并、全空的家庭成员丢掉。
      const normalized = profileApi.normalizeProfile(profile);
      const record = await invoke<ProfileRecordView>("save_profile_cmd", { profile: normalized, revision });
      const saved = profileApi.normalizeProfile(record.profile);
      if (editVersionRef.current === editVersion) {
        profileRef.current = saved;
        setProfile(saved);
        dirtyRef.current = false;
      } else {
        // 保存请求发出后用户又输入，响应不能抹掉这段新草稿。
        dirtyRef.current = true;
      }
      baseProfileRef.current = saved;
      setRevision(record.revision);
      revisionRef.current = record.revision;
      // 保存结果比此前启动的任何读取都新；让那些响应回来时直接作废。
      loadSequenceRef.current += 1;
      setExternalChange(false);
      const newerRevision = pendingExternalRevisionRef.current;
      const hasNewerRevision = newerRevision > record.revision;
      setDeferredExternalChange(hasNewerRevision);
      pendingExternalRevisionRef.current = hasNewerRevision ? newerRevision : 0;
      // 与插件 popup.js saveProfile 同款措辞：已保存的项数，剩下多少补充字段还没填内容。
      const count = profileApi.countProfileValues(saved);
      const pending = profileApi.countPendingFields(saved);
      setNotice(editVersionRef.current === editVersion ? {
        tone: "ok",
        text: pending ? `已保存 ${count} 项，还有 ${pending} 个字段没填内容。` : `已保存 ${count} 项。`,
      } : { tone: "warn", text: "已保存此前的修改；保存期间的新输入仍未保存。" });
      if (hasNewerRevision) void load(false, newerRevision);
    } catch (error) {
      const err = error as { code?: string; message?: string } | null;
      const revisionConflict = err?.code === "CONFLICT";
      setConflict(revisionConflict);
      if (revisionConflict) {
        setExternalChange(true);
        pendingExternalRevisionRef.current = Math.max(pendingExternalRevisionRef.current, revisionRef.current + 1);
        void load(false, pendingExternalRevisionRef.current);
      }
      setNotice({ tone: "error", text: err?.message ?? "保存失败。" });
    } finally {
      savingRef.current = false;
      setBusy(false);
    }
  };

  const inspection = pendingRemote && baseProfileRef.current
    ? inspectProfileUpdate(baseProfileRef.current, profile, profileApi.normalizeProfile(pendingRemote.profile))
    : null;
  const chooseConflict = (id: string, choice: ConflictChoice) => {
    if (choice === "remote") {
      setConfirmExternalChoice(id);
      return;
    }
    setChoices((current) => ({ ...current, [id]: choice }));
    setConfirmExternalChoice(null);
  };
  const applyChoices = () => {
    if (!pendingRemote || !inspection) return;
    const latest = profileApi.normalizeProfile(pendingRemote.profile);
    if (pendingExternalRevisionRef.current > pendingRemote.revision) {
      setNotice({ tone: "warn", text: "又收到新的更新，请先读取最新版本。" });
      void load(false, pendingExternalRevisionRef.current);
      return;
    }
    if (inspection.conflicts.some((item) => !choices[item.id])) {
      setNotice({ tone: "warn", text: "请为每一处更新选择处理方式。" });
      return;
    }
    const invalidRename = inspection.conflicts.find((item) => choices[item.id] === "both" && (
      !validSeparateName(renames[item.id] ?? "", profile, item)
      || latest.custom.some((field) => profileApi.normalizeKey(field.key) === profileApi.normalizeKey(renames[item.id] ?? ""))
    ));
    if (invalidRename) {
      setNotice({ tone: "warn", text: `请为「${invalidRename.label}」填写一个不同且未使用的字段名。` });
      return;
    }
    const merged = applyProfileChoices(profile, inspection.additions, inspection.conflicts, choices, renames);
    if (choices.family === "remote") merged.family = latest.family.map((member) => ({ ...member }));
    const intendedKeys = merged.custom.map((item) => profileApi.normalizeKey(item.key)).filter(Boolean);
    if (new Set(intendedKeys).size !== intendedKeys.length || profileApi.normalizeProfile(merged).custom.length !== intendedKeys.length) {
      setNotice({ tone: "warn", text: "补充字段存在同名项或已达数量上限，请调整后再应用。" });
      return;
    }
    profileRef.current = merged;
    baseProfileRef.current = latest;
    setProfile(merged);
    setRevision(pendingRemote.revision);
    revisionRef.current = pendingRemote.revision;
    dirtyRef.current = true;
    editVersionRef.current += 1;
    pendingExternalRevisionRef.current = 0;
    setPendingRemote(null);
    setConflict(false);
    setExternalChange(false);
    setDeferredExternalChange(false);
    setShowConflictDetails(false);
    setConfirmExternalChoice(null);
    setNotice({ tone: "warn", text: "更新已加入当前草稿；你的修改仍未保存。" });
  };

  return (
    <form
      className="stack profile-form"
      onSubmit={(event) => {
        event.preventDefault();
        void save();
      }}
    >
      {externalChange || deferredExternalChange || conflict || pendingRemote ? (
        <div className="note warn stack" role="status">
          <p>{pendingRemote
            ? `有 ${inspection?.conflicts.length ?? 0} 处更新需要确认。你的未保存修改已保留。`
            : syncing
              ? "正在检查插件更新；你的未保存修改已保留。"
              : deferredExternalChange
                ? "有待同步的更新。当前输入仍保留，可稍后处理。"
                : "档案已在别处更新。当前输入仍保留，正在读取更新。"}</p>
          <div className="row">
            {pendingRemote ? (
              <button type="button" onClick={() => setShowConflictDetails(true)}>查看并处理</button>
            ) : (
              <button type="button" disabled={syncing || reloading || busy} onClick={() => void load(false, pendingExternalRevisionRef.current || revisionRef.current + 1)}>
                重新检查更新
              </button>
            )}
            {pendingRemote && pendingExternalRevisionRef.current > pendingRemote.revision ? (
              <button type="button" disabled={syncing} onClick={() => void load(false, pendingExternalRevisionRef.current)}>读取最新更新</button>
            ) : null}
            <button type="button" disabled={syncing} onClick={() => {
              setShowConflictDetails(false);
              setDeferredExternalChange(true);
            }}>稍后处理</button>
            <button ref={reloadButtonRef} type="button" disabled={busy || reloading} onClick={() => setConfirmDiscard(true)}>
              放弃未保存修改并重新读取
            </button>
          </div>
          {pendingRemote && showConflictDetails && inspection ? (
            <div className="profile-conflict-details stack" role="group" aria-label="处理外部更新">
              <p>选择当前草稿会在下次保存时覆盖对应外部值；选择外部版本会替换当前输入。</p>
              {inspection.conflicts.map((item) => (
                <div key={item.id} className="profile-conflict-item stack" role="group" aria-label={`冲突：${item.label}`}>
                  <strong>{item.label}</strong>
                  <div className="profile-conflict-values">
                    <p>当前草稿：<span>{item.local}</span></p>
                    <p>外部版本：<span>{item.remote}</span></p>
                  </div>
                  <div className="row">
                    <button type="button" aria-pressed={choices[item.id] === "local"} onClick={() => chooseConflict(item.id, "local")}>使用当前草稿</button>
                    <button type="button" aria-pressed={choices[item.id] === "remote"} onClick={() => chooseConflict(item.id, "remote")}>使用外部版本</button>
                    {item.kind === "custom" && item.newlyAdded && item.localItem && item.remoteItem ? (
                      <button type="button" aria-pressed={choices[item.id] === "both"} onClick={() => chooseConflict(item.id, "both")}>分别保留</button>
                    ) : null}
                  </div>
                  {confirmExternalChoice === item.id ? (
                    <div className="row" role="group" aria-label={`确认使用外部版本：${item.label}`}>
                      <span>这会放弃该处当前草稿内容，确定吗？</span>
                      <button type="button" onClick={() => { setChoices((current) => ({ ...current, [item.id]: "remote" })); setConfirmExternalChoice(null); }}>确定使用外部版本</button>
                      <button type="button" onClick={() => setConfirmExternalChoice(null)}>取消</button>
                    </div>
                  ) : null}
                  {choices[item.id] === "both" ? (
                    <label>给当前草稿中的字段改名
                      <input value={renames[item.id] ?? ""} onChange={(event) => setRenames((current) => ({ ...current, [item.id]: event.target.value }))} />
                    </label>
                  ) : null}
                </div>
              ))}
              <button type="button" onClick={applyChoices}>应用选择，继续编辑</button>
            </div>
          ) : null}
        </div>
      ) : null}
      {confirmDiscard ? (
        <div className="note warn stack" role="group" aria-label="确认放弃未保存修改" aria-describedby="profile-discard-description">
          <p id="profile-discard-description">重新读取会丢弃当前未保存的修改，用已保存的档案替换。确定放弃吗？</p>
          <div className="row">
            <button type="button" disabled={busy || reloading} onClick={() => {
              setConfirmDiscard(false);
              void load(true);
            }}>确定放弃并重新读取</button>
            <button type="button" autoFocus onClick={() => { setConfirmDiscard(false); reloadButtonRef.current?.focus(); }}>取消，保留当前输入</button>
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
        {profile.custom.length ? (
          <div className="custom-field-head" aria-hidden="true">
            <span>字段名</span>
            <span>内容</span>
            <span />
          </div>
        ) : null}
        {profile.custom.map((item, index) => (
          <CustomFieldRow
            key={index}
            index={index}
            item={item}
            onChange={(field, value) => setCustom(index, field, value)}
            onRemove={() => updateProfile({ ...profile, custom: profile.custom.filter((_, i) => i !== index) })}
          />
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
        <button type="submit" className="primary" disabled={busy || reloading || confirmDiscard}>
          保存我的信息
        </button>
      </div>
    </form>
  );
}

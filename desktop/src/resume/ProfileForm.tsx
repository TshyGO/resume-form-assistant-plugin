import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import type { KeyboardEvent, MutableRefObject } from "react";
import type { ProfileRecordView } from "../api.ts";
import { useInvoke } from "../react/invoke.tsx";
import { profileApi } from "./profile.ts";
import type { FamilyMember, Profile, ProfileFieldDef } from "./profile.ts";
import type { Notice } from "./resume-text.ts";
import type { DesktopEvent, Listen } from "./LegacyImport.tsx";
import { applyProfileChoices, inspectProfileUpdate, validSeparateName } from "./profile-draft-sync.ts";
import type { ConflictChoice, ProfileConflict } from "./profile-draft-sync.ts";
import { ResumeDialog } from "./ResumeDialog.tsx";

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
      <label htmlFor={id} className="is-wide">
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

/** 简历页拿来问「有没有没保存的修改」，以及导入旧数据后让表单安全地重新核对一次档案。 */
export interface ProfileProbe {
  dirty(): boolean;
  sync(): void;
}

type Section =
  | { kind: "schema"; name: string; index: number }
  | { kind: "family"; name: string }
  | { kind: "custom"; name: string };

// 左侧的八个分组（#257）：六组固定字段，按 PROFILE_SCHEMA 原顺序，再加家庭成员与补充字段。
const SECTIONS: Section[] = [
  ...profileApi.PROFILE_SCHEMA.map((group, index): Section => ({ kind: "schema", name: group.name, index })),
  { kind: "family", name: profileApi.FAMILY_GROUP },
  { kind: "custom", name: profileApi.CUSTOM_GROUP },
];

type ConflictView = { kind: "list" } | { kind: "confirm-remote"; id: string } | { kind: "rename"; id: string; draft: string; error: string | null };

function conflictValue(item: ProfileConflict, side: "local" | "remote"): string {
  const custom = item.kind === "custom" ? (side === "local" ? item.localItem : item.remoteItem) : undefined;
  return `${custom ? `${custom.key} — ` : ""}${side === "local" ? item.local : item.remote}`;
}

export function ProfileForm({ listen, probe }: { listen?: Listen; probe?: MutableRefObject<ProfileProbe | null> } = {}) {
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
  const [conflictView, setConflictView] = useState<ConflictView>({ kind: "list" });
  const [dialogNotice, setDialogNotice] = useState<string | null>(null);
  const [dirty, setDirtyState] = useState(false);
  const [section, setSection] = useState(0);
  const reloadPendingRef = useRef(false);
  const savingRef = useRef(false);
  const reloadButtonRef = useRef<HTMLButtonElement>(null);
  // 刚新增的家庭成员/补充字段：画出来之后把它滚进视野并聚焦第一个输入框。
  const focusAddedRef = useRef<string | null>(null);
  const dirtyRef = useRef(false);
  const profileRef = useRef<Profile | null>(null);
  const baseProfileRef = useRef<Profile | null>(null);
  const revisionRef = useRef(0);
  const editVersionRef = useRef(0);
  const loadSequenceRef = useRef(0);
  const pendingExternalRevisionRef = useRef(0);
  const unknownExternalPendingRef = useRef(false);
  // 页脚的「尚未保存」要跟着重画，所以 ref 之外再存一份 state。
  const setDirty = (value: boolean) => {
    dirtyRef.current = value;
    setDirtyState(value);
  };

  const load = useCallback(async (discardLocalChanges = false, externalRevision = 0, checkExternal = externalRevision > 0) => {
    if (!invoke || (discardLocalChanges && reloadPendingRef.current)) return;
    if (discardLocalChanges) {
      reloadPendingRef.current = true;
      setReloading(true);
    } else if (checkExternal) {
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
      if (checkExternal && latestRequested && record.revision < latestRequested) {
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
        if (record.revision <= revisionRef.current) {
          // 旧宿主没有 revision 的通知只要求核对一次；读回相同版本时不能虚构待同步状态。
          if (checkExternal && !pendingExternalRevisionRef.current) {
            unknownExternalPendingRef.current = false;
            setExternalChange(false);
            setDeferredExternalChange(false);
            setConflict(false);
          }
          return;
        }
        const result = inspectProfileUpdate(base, draft, remote);
        if (result.conflicts.length) {
          unknownExternalPendingRef.current = false;
          setPendingRemote(record);
          setNotice(null);
          setChoices({});
          setRenames({});
          setConflictView({ kind: "list" });
          setDialogNotice(null);
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
        unknownExternalPendingRef.current = false;
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
      setDirty(false);
      setExternalChange(false);
      pendingExternalRevisionRef.current = hasNewerRevision ? newerRevision : 0;
      unknownExternalPendingRef.current = false;
    } catch (error) {
      if (loadSequence !== loadSequenceRef.current) return;
      if (checkExternal) setDeferredExternalChange(true);
      setNotice({ tone: "error", text: (error as { message?: string })?.message ?? "读取失败。" });
    } finally {
      if (discardLocalChanges) {
        reloadPendingRef.current = false;
        setReloading(false);
      }
      if (checkExternal && loadSequence === loadSequenceRef.current) setSyncing(false);
    }
  }, [invoke]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    const id = focusAddedRef.current;
    if (!id) return;
    focusAddedRef.current = null;
    const target = document.getElementById(id);
    if (!target) return;
    target.focus({ preventScroll: true });
    // 补充字段的框高在布局后才算好：下一帧再把整行滚进视野，免得被页脚挡住半行。
    const reveal = () => (target.closest(".custom-field-row, .profile-member") ?? target).scrollIntoView?.({ block: "nearest" });
    if (typeof requestAnimationFrame === "function") requestAnimationFrame(reveal);
    else reveal();
  });

  useEffect(() => {
    if (!probe) return undefined;
    // 导入旧数据后不整块重挂（那会丢掉草稿）：按外部更新的规则核对一次，
    // 干净的表单直接换成新档案，有草稿时走逐项冲突。
    probe.current = { dirty: () => dirtyRef.current, sync: () => void load(false, 0, true) };
    return () => {
      probe.current = null;
    };
  }, [probe, load]);

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
        const externalRevision = change?.revision ?? 0;
        // 有真实 revision 的事件去重；旧宿主的无 payload 事件只核对，不编造新版本。
        if (change) {
          if (externalRevision <= revisionRef.current || externalRevision <= pendingExternalRevisionRef.current) return;
          pendingExternalRevisionRef.current = Math.max(pendingExternalRevisionRef.current, externalRevision);
        } else {
          unknownExternalPendingRef.current = true;
        }
        setExternalChange(true);
        if (!savingRef.current && !reloadPendingRef.current) void load(false, externalRevision, true);
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

  if (!invoke) return <p className="muted resume-offline">没有连上桌面程序，「我的信息」要在桌面程序里编辑。</p>;
  if (!profile)
    return (
      <div className="resume-card resume-placeholder">
        {notice ? (
          <>
            <p className={`note ${notice.tone}`} role="status">
              {notice.text}
            </p>
            <button type="button" onClick={() => void load()}>重试</button>
          </>
        ) : (
          <p className="muted">正在读取「我的信息」…</p>
        )}
      </div>
    );

  // 用户一动手改，上一次保存/冲突的提示就过时了，清掉以免误导。
  const updateProfile = (next: Profile) => {
    editVersionRef.current += 1;
    setDirty(true);
    profileRef.current = next;
    setProfile(next);
    if (pendingRemote) {
      setChoices({});
      setConflictView({ kind: "list" });
    }
    setNotice(null);
  };
  const setValue = (id: string, value: string) =>
    updateProfile({ ...profile, values: { ...profile.values, [id]: value } });
  const setMember = (index: number, field: string, value: string) =>
    updateProfile({ ...profile, family: profile.family.map((m, i) => (i === index ? { ...m, [field]: value } : m)) });
  // 「添加」按钮在页脚、和保存按钮并排（不随列表变长被挤到下面）。
  const addMember = () => {
    focusAddedRef.current = `family-${profile.family.length}-relation`;
    updateProfile({ ...profile, family: [...profile.family, emptyMember()] });
  };
  const addCustom = () => {
    focusAddedRef.current = `custom-${profile.custom.length}-key`;
    updateProfile({ ...profile, custom: [...profile.custom, { key: "", value: "" }] });
  };
  const setCustom = (index: number, field: "key" | "value", value: string) =>
    updateProfile({ ...profile, custom: profile.custom.map((c, i) => (i === index ? { ...c, [field]: value } : c)) });

  const save = async () => {
    if (busy || reloadPendingRef.current || confirmDiscard) return;
    if (pendingRemote || externalChange || deferredExternalChange || conflict || syncing) {
      // 只有已经读到外部版本时才打开逐项处理；还在读取时等提示条里的入口。
      if (pendingRemote) setShowConflictDetails(true);
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
        setDirty(false);
      } else {
        // 保存请求发出后用户又输入，响应不能抹掉这段新草稿。
        setDirty(true);
      }
      baseProfileRef.current = saved;
      setRevision(record.revision);
      revisionRef.current = record.revision;
      // 保存结果比此前启动的任何读取都新；让那些响应回来时直接作废。
      loadSequenceRef.current += 1;
      const unknownExternalPending = unknownExternalPendingRef.current;
      setExternalChange(unknownExternalPending);
      const newerRevision = pendingExternalRevisionRef.current;
      const hasNewerRevision = newerRevision > record.revision;
      setDeferredExternalChange(hasNewerRevision || unknownExternalPending);
      pendingExternalRevisionRef.current = hasNewerRevision ? newerRevision : 0;
      // 与插件 popup.js saveProfile 同款措辞：已保存的项数，剩下多少补充字段还没填内容。
      const count = profileApi.countProfileValues(saved);
      const pending = profileApi.countPendingFields(saved);
      setNotice(editVersionRef.current === editVersion ? {
        tone: "ok",
        text: pending ? `已保存 ${count} 项，还有 ${pending} 个字段没填内容。` : `已保存 ${count} 项。`,
      } : { tone: "warn", text: "已保存此前的修改；保存期间的新输入仍未保存。" });
      if (hasNewerRevision) void load(false, newerRevision, true);
      else if (unknownExternalPending) void load(false, 0, true);
    } catch (error) {
      const err = error as { code?: string; message?: string } | null;
      const revisionConflict = err?.code === "CONFLICT";
      setConflict(revisionConflict);
      if (revisionConflict) {
        setExternalChange(true);
        pendingExternalRevisionRef.current = Math.max(pendingExternalRevisionRef.current, revisionRef.current + 1);
        void load(false, pendingExternalRevisionRef.current, true);
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
    setDialogNotice(null);
    if (choice === "remote") {
      setConflictView({ kind: "confirm-remote", id });
      return;
    }
    if (choice === "both") {
      setConflictView({ kind: "rename", id, draft: renames[id] ?? "", error: null });
      return;
    }
    setChoices((current) => ({ ...current, [id]: choice }));
  };
  const applyChoices = () => {
    if (!pendingRemote || !inspection) return;
    const latest = profileApi.normalizeProfile(pendingRemote.profile);
    if (pendingExternalRevisionRef.current > pendingRemote.revision) {
      setDialogNotice("又收到新的更新，正在读取最新版本，请再核对一遍。");
      void load(false, pendingExternalRevisionRef.current, true);
      return;
    }
    if (inspection.conflicts.some((item) => !choices[item.id])) {
      setDialogNotice("请为每一处更新选择处理方式。");
      return;
    }
    const invalidRename = inspection.conflicts.find((item) => choices[item.id] === "both" && (
      !validSeparateName(renames[item.id] ?? "", profile, item)
      || latest.custom.some((field) => profileApi.normalizeKey(field.key) === profileApi.normalizeKey(renames[item.id] ?? ""))
    ));
    if (invalidRename) {
      setDialogNotice(`请为「${invalidRename.label}」填写一个不同且未使用的字段名。`);
      return;
    }
    const merged = applyProfileChoices(profile, inspection.additions, inspection.conflicts, choices, renames);
    if (choices.family === "remote") merged.family = latest.family.map((member) => ({ ...member }));
    const intendedKeys = merged.custom.map((item) => profileApi.normalizeKey(item.key)).filter(Boolean);
    if (new Set(intendedKeys).size !== intendedKeys.length || profileApi.normalizeProfile(merged).custom.length !== intendedKeys.length) {
      setDialogNotice("补充字段存在同名项或已达数量上限，请调整后再应用。");
      return;
    }
    profileRef.current = merged;
    baseProfileRef.current = latest;
    setProfile(merged);
    setRevision(pendingRemote.revision);
    revisionRef.current = pendingRemote.revision;
    setDirty(true);
    editVersionRef.current += 1;
    pendingExternalRevisionRef.current = 0;
    setPendingRemote(null);
    setConflict(false);
    setExternalChange(false);
    setDeferredExternalChange(false);
    setShowConflictDetails(false);
    setConflictView({ kind: "list" });
    setDialogNotice(null);
    setNotice({ tone: "warn", text: "更新已加入当前草稿；你的修改仍未保存。" });
  };

  const current = SECTIONS[section] ?? SECTIONS[0];
  const pendingCount = profileApi.countPendingFields(profile);
  const syncVisible = externalChange || deferredExternalChange || conflict || Boolean(pendingRemote);
  const newerPending = Boolean(pendingRemote && pendingExternalRevisionRef.current > pendingRemote.revision);
  const conflicts = inspection?.conflicts ?? [];
  const unresolved = conflicts.filter((item) => !choices[item.id]).length;
  const latestRemote = pendingRemote ? profileApi.normalizeProfile(pendingRemote.profile) : null;
  const viewItem = conflictView.kind !== "list" ? conflicts.find((item) => item.id === conflictView.id) ?? null : null;
  const closeConflicts = () => {
    setShowConflictDetails(false);
    setConflictView({ kind: "list" });
    setDialogNotice(null);
    // 「稍后处理」只是先关掉弹窗，提示条和入口都还在。
    setDeferredExternalChange(true);
  };
  const renameProblem = (draft: string, item: ProfileConflict): string | null => {
    if (!validSeparateName(draft, profile, item)) return "请填一个与现有字段都不同的名字。";
    if (latestRemote?.custom.some((field) => profileApi.normalizeKey(field.key) === profileApi.normalizeKey(draft))) {
      return "外部版本里已经有这个字段名，请换一个。";
    }
    return null;
  };

  const conflictDialog = (() => {
    if (!pendingRemote || !showConflictDetails || !inspection) return null;
    if (conflictView.kind === "confirm-remote" && viewItem) {
      return (
        <ResumeDialog
          open
          tone="warn"
          title="改用外部版本？"
          focusKey={`remote:${viewItem.id}`}
          onCancel={() => setConflictView({ kind: "list" })}
          footer={
            <>
              <button type="button" data-autofocus onClick={() => setConflictView({ kind: "list" })}>取消</button>
              <button
                type="button"
                className="danger"
                onClick={() => {
                  setChoices((existing) => ({ ...existing, [viewItem.id]: "remote" }));
                  setConflictView({ kind: "list" });
                }}
              >
                确定使用外部版本
              </button>
            </>
          }
        >
          <p>「{viewItem.label}」的当前草稿内容将被外部值替换。其他没有冲突的输入会继续保留。</p>
          <div className="profile-conflict-values">
            <p>当前草稿：<span>{conflictValue(viewItem, "local")}</span></p>
            <p>外部版本：<span>{conflictValue(viewItem, "remote")}</span></p>
          </div>
        </ResumeDialog>
      );
    }
    if (conflictView.kind === "rename" && viewItem) {
      const problem = conflictView.draft.trim() ? renameProblem(conflictView.draft, viewItem) : null;
      return (
        <ResumeDialog
          open
          tone="warn"
          title="为当前草稿中的字段改名"
          focusKey={`rename:${viewItem.id}`}
          onCancel={() => setConflictView({ kind: "list" })}
          footer={
            <>
              <button type="button" onClick={() => setConflictView({ kind: "list" })}>返回选择</button>
              <button
                type="button"
                className="primary"
                disabled={!conflictView.draft.trim() || Boolean(problem)}
                onClick={() => {
                  const name = conflictView.draft.trim();
                  setRenames((existing) => ({ ...existing, [viewItem.id]: name }));
                  setChoices((existing) => ({ ...existing, [viewItem.id]: "both" }));
                  setConflictView({ kind: "list" });
                }}
              >
                分别保留
              </button>
            </>
          }
        >
          <p>外部版本新增了同名的「{viewItem.label}」。给当前草稿中的这一项换个名字，两项都会保留；名称必须与现有字段不同。</p>
          <label>
            新字段名
            <input
              data-autofocus
              value={conflictView.draft}
              onChange={(event) => setConflictView({ ...conflictView, draft: event.target.value.replace(/\r?\n/g, " ") })}
            />
          </label>
          {problem ? <p className="note warn">{problem}</p> : null}
        </ResumeDialog>
      );
    }
    return (
      <ResumeDialog
        open
        wide
        tone="warn"
        title="处理资料冲突"
        focusKey="list"
        onCancel={closeConflicts}
        footer={
          <>
            <button type="button" onClick={closeConflicts}>稍后处理</button>
            {newerPending ? (
              <button type="button" disabled={syncing} onClick={() => void load(false, pendingExternalRevisionRef.current, true)}>读取最新更新</button>
            ) : null}
            <button type="button" className="primary" disabled={unresolved > 0} onClick={applyChoices}>应用选择，继续编辑</button>
          </>
        }
      >
        <p className="muted">你的草稿已保留。请逐项决定使用哪个版本：选当前草稿会在下次保存时覆盖对应外部值，选外部版本会替换当前输入。处理后仍需手动保存。</p>
        {newerPending ? <p className="note warn">又收到更新的外部版本，请先读取最新更新再处理。</p> : null}
        <div className="profile-conflict-list">
          {conflicts.map((item) => {
            const chosen = choices[item.id];
            const canKeepBoth = item.kind === "custom" && item.newlyAdded && item.localItem && item.remoteItem;
            return (
              <div key={item.id} className="profile-conflict-item" role="group" aria-label={`冲突：${item.label}`}>
                <strong>{item.label}</strong>
                <div className="profile-conflict-values">
                  <p>当前草稿：<span>{conflictValue(item, "local")}</span></p>
                  <p>外部版本：<span>{conflictValue(item, "remote")}</span></p>
                </div>
                <div className="row">
                  <button type="button" aria-pressed={chosen === "local"} onClick={() => chooseConflict(item.id, "local")}>用当前草稿</button>
                  <button type="button" aria-pressed={chosen === "remote"} onClick={() => chooseConflict(item.id, "remote")}>用外部版本…</button>
                  {canKeepBoth ? (
                    <button type="button" aria-pressed={chosen === "both"} onClick={() => chooseConflict(item.id, "both")}>分别保留…</button>
                  ) : null}
                </div>
                {chosen === "both" ? <p className="muted">当前草稿中的这一项将改名为「{renames[item.id]}」，两项都保留。</p> : null}
              </div>
            );
          })}
        </div>
        {unresolved > 0 ? <p className="muted">还有 {unresolved} 处没有选择。</p> : null}
        {dialogNotice ? <p className="note warn" role="alert">{dialogNotice}</p> : null}
      </ResumeDialog>
    );
  })();

  // 八组都挂着、只显示当前这组：切换分组不会卸掉别组的输入框，焦点和草稿都不受影响。
  const renderSection = (item: Section) => {
    if (item.kind === "schema") {
      const group = profileApi.PROFILE_SCHEMA[item.index];
      return (
        <fieldset className="profile-fields">
          <legend className="sr-only">{group.name}</legend>
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
      );
    }
    if (item.kind === "family") {
      return (
        <fieldset className="profile-family">
          <legend className="sr-only">{profileApi.FAMILY_GROUP}</legend>
          {profile.family.length === 0 ? <p className="muted">还没有家庭成员。网申表常要求填父母或配偶的信息，点下方「添加家庭成员」。</p> : null}
          {profile.family.map((member, index) => (
            <div key={index} role="group" aria-label={`家庭成员 ${index + 1}`} className="profile-member">
              <div className="profile-member-head">
                <strong>成员 {index + 1}</strong>
                <button
                  type="button"
                  onClick={() => updateProfile({ ...profile, family: profile.family.filter((_, i) => i !== index) })}
                >
                  删除成员
                </button>
              </div>
              <div className="profile-fields">
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
              </div>
            </div>
          ))}
        </fieldset>
      );
    }
    return (
      <fieldset className="profile-custom">
        <legend className="sr-only">{profileApi.CUSTOM_GROUP}</legend>
        <p className="resume-panel-note">从网页上「加到我的信息」的字段会出现在这里，补上内容后下次就能自动填。</p>
        {profile.custom.length ? (
          <div className="custom-field-head" aria-hidden="true">
            <span>字段名</span>
            <span>内容</span>
            <span />
          </div>
        ) : (
          <p className="muted">还没有补充字段，点下方「添加补充字段」。</p>
        )}
        {profile.custom.map((item, index) => (
          <CustomFieldRow
            key={index}
            index={index}
            item={item}
            onChange={(field, value) => setCustom(index, field, value)}
            onRemove={() => updateProfile({ ...profile, custom: profile.custom.filter((_, i) => i !== index) })}
          />
        ))}
      </fieldset>
    );
  };

  return (
    <div className="profile-workspace">
      <nav className="resume-card profile-nav" aria-label="信息分组">
        <div className="profile-nav-head">
          <h2>信息分组</h2>
          <p>选择一组，集中编辑</p>
        </div>
        <div className="profile-nav-list">
          {SECTIONS.map((item, index) => (
            <button
              key={item.name}
              type="button"
              className={item.kind === "family" ? "has-divider" : undefined}
              aria-current={index === section ? "true" : undefined}
              onClick={() => setSection(index)}
            >
              <span>{item.name}</span>
              {item.kind === "custom" && pendingCount ? (
                <span className="profile-nav-badge">{pendingCount} 待补充</span>
              ) : (
                <span className="profile-nav-arrow" aria-hidden="true">›</span>
              )}
            </button>
          ))}
        </div>
        <p className="resume-card-foot">插件添加的新字段会出现在「补充字段」。</p>
      </nav>
      <form
        className="resume-card profile-form"
        aria-label={`${current.name}编辑`}
        onSubmit={(event) => {
          event.preventDefault();
          void save();
        }}
      >
        <div className="profile-form-head">
          <div>
            <p className="resume-kicker">资料分组 · {String(section + 1).padStart(2, "0")} / {String(SECTIONS.length).padStart(2, "0")}</p>
            <h2>{current.name}</h2>
          </div>
          <label className="profile-group-select">
            <span className="sr-only">切换信息分组</span>
            <select value={section} onChange={(event) => setSection(Number(event.target.value))}>
              {SECTIONS.map((item, index) => (
                <option key={item.name} value={index}>
                  {item.name}
                  {item.kind === "custom" && pendingCount ? `（${pendingCount} 待补充）` : ""}
                </option>
              ))}
            </select>
          </label>
          <span className={`profile-state${dirty ? " is-dirty" : ""}`}>{dirty ? "有未保存的修改" : "填写后点击保存"}</span>
        </div>
        {syncVisible ? (
          <div className="profile-sync" role="status">
            <p>{pendingRemote
              ? `有 ${conflicts.length} 处更新需要确认。你的未保存修改已保留。`
              : syncing
                ? "正在检查插件更新；你的未保存修改已保留。"
                : deferredExternalChange
                  ? "有待同步的更新。当前输入仍保留，可稍后处理。"
                  : "档案已在别处更新。当前输入仍保留，正在读取更新。"}</p>
            <div className="row">
              {pendingRemote ? (
                <button type="button" className="primary" onClick={() => setShowConflictDetails(true)}>查看并处理</button>
              ) : (
                <button type="button" disabled={syncing || reloading || busy} onClick={() => void load(false, pendingExternalRevisionRef.current, true)}>
                  重新检查更新
                </button>
              )}
              {newerPending ? (
                <button type="button" disabled={syncing} onClick={() => void load(false, pendingExternalRevisionRef.current, true)}>读取最新更新</button>
              ) : null}
              <button ref={reloadButtonRef} type="button" disabled={busy || reloading} onClick={() => setConfirmDiscard(true)}>
                放弃未保存修改并重新读取
              </button>
            </div>
          </div>
        ) : null}
        <div className="profile-form-body">
          {SECTIONS.map((item, index) => (
            <div key={item.name} hidden={index !== section}>
              {renderSection(item)}
            </div>
          ))}
        </div>
        <div className="profile-form-foot">
          {notice ? (
            <p className={`note ${notice.tone}`} role="status">
              {notice.text}
            </p>
          ) : (
            <p className="muted">{dirty ? "当前编辑内容尚未保存；插件仍使用上次保存的信息。" : "插件填写时使用这里已保存的信息。"}</p>
          )}
          <div className="profile-form-actions">
            {current.kind === "family" ? (
              <button type="button" onClick={addMember}>添加家庭成员</button>
            ) : current.kind === "custom" ? (
              <button type="button" onClick={addCustom}>添加补充字段</button>
            ) : null}
            <button type="submit" className="primary" disabled={busy || reloading || confirmDiscard}>
              {busy ? "正在保存…" : "保存我的信息"}
            </button>
          </div>
        </div>
      </form>
      {conflictDialog}
      <ResumeDialog
        open={confirmDiscard}
        tone="warn"
        title="放弃当前草稿？"
        onCancel={() => setConfirmDiscard(false)}
        footer={
          <>
            <button type="button" data-autofocus onClick={() => setConfirmDiscard(false)}>继续编辑</button>
            <button
              type="button"
              className="danger"
              disabled={busy || reloading}
              onClick={() => {
                setConfirmDiscard(false);
                void load(true);
              }}
            >
              放弃并重新读取
            </button>
          </>
        }
      >
        <p>重新读取会用已保存的资料替换当前未保存的修改。取消后，表单内容和冲突处理入口都保留。</p>
      </ResumeDialog>
    </div>
  );
}

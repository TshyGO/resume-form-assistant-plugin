import { useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";
import type { AiProviderView, AiSettingsView, ImportResultView, ResumeOverview, TemplateGroupView } from "../api.ts";
import { useInvoke } from "../react/invoke.tsx";
import { extractText } from "./extract-text.ts";
import { MAX_TEMPLATES, MAX_USER_CHARS } from "./parse-limits.ts";
import { buildRequest, fieldsToGroups, parseModelReply, templateNameFor } from "./parse-resume.ts";
import { ResumeDialog } from "./ResumeDialog.tsx";
import type { Notice } from "./resume-text.ts";

type Stage =
  | { kind: "idle" }
  | { kind: "reading"; fileName: string }
  | {
      kind: "confirm";
      fileName: string;
      text: string;
      provider: AiProviderView | null;
      templateCount: number;
      // 简历全文与「实际发出去的那串（前缀 + 全文）」各数一次，存下来渲染时直接用，
      // 不在每次渲染时重新展开字符串数一遍。
      charCount: number;
      userCharCount: number;
    }
  | { kind: "sending"; requestId: string; fileName: string; startedAt: number; cancelling: boolean }
  | { kind: "saving"; fileName: string; groups: TemplateGroupView[] }
  | { kind: "save-failed"; fileName: string; groups: TemplateGroupView[]; error: string }
  | { kind: "done" };

function errorText(error: unknown): string {
  if (typeof error === "string") return error;
  if (error instanceof Error) return error.message;
  return (error as { message?: string } | null)?.message ?? "解析失败，请重试。";
}

const ACTIVE_STAGES = new Set(["reading", "confirm", "sending", "saving", "save-failed"]);

export interface ResumeParseOptions {
  /** 新模板已建好并设为当前，带上它的 id，列表据此刷新并选中它。 */
  onCreated(templateId: string): void;
  extract?: (file: File) => Promise<string>;
}

export interface ResumeParseControls {
  /** 「上传简历，AI 解析」入口（原生文件输入）。没连上桌面程序时为 null。 */
  trigger: ReactNode;
  /** 弹窗收起后留在工作区里的进度/重新保存入口，以及结果提示。 */
  panel: ReactNode;
  dialog: ReactNode;
  /** 从选文件到建好模板之间的任何一步都算进行中；简历页的切换控件据此保留提示。 */
  active: boolean;
}

/**
 * 上传一份简历，交给「当前使用」的 AI 服务商解析，存成新模板并设为当前。
 * 发送前必须让用户看到：发给谁（服务商、主机、模型）、发多少字、对方可能留存（data-privacy §8）。
 *
 * 状态放在简历页这一层（#257）：切到「我的信息」再切回来，进行中的解析仍在，可以接着看或取消。
 */
export function useResumeParse({ onCreated, extract = extractText }: ResumeParseOptions): ResumeParseControls {
  const invoke = useInvoke();
  const [stage, setStage] = useState<Stage>({ kind: "idle" });
  const [dialogOpen, setDialogOpen] = useState(false);
  const [notice, setNotice] = useState<Notice | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const input = useRef<HTMLInputElement>(null);
  const counter = useRef(0);
  // 读文件时点了「取消」：那次读取晚点落地也要作废，不能再弹出确认。
  const pickToken = useRef(0);
  // 整个简历页被卸载时，正在等的那次 AI 请求不能假装还有界面在等它——卸载时把它取消，
  // 之后（哪怕这份 promise 稍后才落地）也不能再悄悄建模板、悄悄提示、或者叫 onCreated。
  const mountedRef = useRef(true);
  const inflightRequestId = useRef<string | null>(null);
  // 点过「取消解析」的那次请求。取消命令和 AI 成功回复会赛跑：回复先到也不能再建模板。
  const cancelledRequestId = useRef<string | null>(null);
  // invoke 来自 context，不必是 effect 的依赖：镜像进 ref，让下面这个 effect
  // 只在真正的挂载/卸载时跑一次，不会因为 context 值的引用变化而重新注册。
  const invokeRef = useRef(invoke);
  invokeRef.current = invoke;
  const onCreatedRef = useRef(onCreated);
  onCreatedRef.current = onCreated;

  useEffect(() => {
    // StrictMode 开发构建会先跑一次 cleanup 再重新执行 effect：这里要把标记改回来，
    // 否则之后每一步都以为自己已经卸载了。
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      const requestId = inflightRequestId.current;
      if (requestId && invokeRef.current) {
        void invokeRef.current("cancel_analysis_cmd", { requestId }).catch(() => {});
      }
    };
  }, []);

  // 等待时每秒刷新一次已等待的秒数，让人知道它还在跑。
  useEffect(() => {
    if (stage.kind !== "sending") return undefined;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [stage.kind]);

  const fail = (text: string) => {
    setStage({ kind: "idle" });
    setDialogOpen(false);
    setNotice({ tone: "error", text });
  };

  const pick = async (file: File | undefined) => {
    if (input.current) input.current.value = "";
    if (!file || !invoke) return;
    const token = ++pickToken.current;
    setNotice(null);
    setStage({ kind: "reading", fileName: file.name });
    setDialogOpen(true);
    try {
      const [text, settings, overview] = await Promise.all([
        extract(file),
        invoke<AiSettingsView>("get_ai_settings_cmd"),
        invoke<ResumeOverview>("resume_overview_cmd"),
      ]);
      if (!mountedRef.current || token !== pickToken.current) return;
      const provider = settings.providers.find((p) => p.id === settings.activeProviderId && p.keyConfigured) ?? null;
      setStage({
        kind: "confirm",
        fileName: file.name,
        text,
        provider,
        templateCount: overview.templates.length,
        charCount: [...text].length,
        userCharCount: [...buildRequest(text).user].length,
      });
    } catch (error) {
      if (!mountedRef.current || token !== pickToken.current) return;
      fail(errorText(error));
    }
  };

  // 保存这一步单独抽出来：AI 解析成功但建模板失败时，重试只再调一次这个函数，
  // 不必（也不该）为了重试再花一次 AI 调用。
  const trySave = async (fileName: string, groups: TemplateGroupView[]) => {
    if (!invoke) return;
    setStage({ kind: "saving", fileName, groups });
    try {
      const result = await invoke<ImportResultView>("create_resume_template_cmd", { name: templateNameFor(fileName), groups });
      if (!mountedRef.current) return;
      const skipped = result.skippedSecretFields
        ? `另有 ${result.skippedSecretFields} 个像密码或验证码的字段没有存。`
        : "";
      setNotice({
        tone: skipped ? "warn" : "ok",
        text: `已存为模板「${result.template.name}」并设为当前，共 ${result.template.fieldCount} 个字段。${skipped}`,
      });
      setStage({ kind: "done" });
      setDialogOpen(false);
      onCreatedRef.current(result.template.id);
    } catch (error) {
      if (!mountedRef.current) return;
      setStage({ kind: "save-failed", fileName, groups, error: errorText(error) });
    }
  };

  const send = async (fileName: string, text: string, providerId: string) => {
    if (!invoke) return;
    const requestId = `resume-parse-${Date.now()}-${++counter.current}`;
    inflightRequestId.current = requestId;
    setNow(Date.now());
    setStage({ kind: "sending", requestId, fileName, startedAt: Date.now(), cancelling: false });
    let reply: string;
    try {
      const { system, user } = buildRequest(text);
      // 后端会自己再核实一遍「当前使用」是不是还是确认外发时看到的这个服务商
      // （AI_PROVIDER_CHANGED）：这里传的 providerId 就是确认时快照的那个 id。
      reply = await invoke<string>("ai_complete_cmd", { system, user, requestId, providerId });
    } catch (error) {
      inflightRequestId.current = null;
      if (!mountedRef.current) return;
      fail(errorText(error));
      return;
    }
    inflightRequestId.current = null;
    // 等回来时页面已经被卸载：这次解析已经没有界面能看着它了，既不建模板，也不提示。
    if (!mountedRef.current) return;
    if (cancelledRequestId.current === requestId) {
      cancelledRequestId.current = null;
      setStage({ kind: "idle" });
      setDialogOpen(false);
      setNotice({ tone: "warn", text: "已取消，AI 返回的结果没有保存。取消不保证对方停止计算或停止计费。" });
      return;
    }
    let groups: TemplateGroupView[];
    try {
      groups = fieldsToGroups(parseModelReply(reply));
    } catch (error) {
      fail(errorText(error));
      return;
    }
    await trySave(fileName, groups);
  };

  const cancel = () => {
    if (stage.kind !== "sending" || stage.cancelling || !invoke) return;
    cancelledRequestId.current = stage.requestId;
    setStage({ ...stage, cancelling: true });
    void invoke("cancel_analysis_cmd", { requestId: stage.requestId }).catch(() => {});
  };

  const dismiss = () => {
    pickToken.current += 1;
    setStage({ kind: "idle" });
    setDialogOpen(false);
  };

  const active = ACTIVE_STAGES.has(stage.kind);

  if (!invoke) return { trigger: null, panel: null, dialog: null, active: false };

  const trigger = (
    <label className={active ? "button-like primary disabled" : "button-like primary"}>
      上传简历，AI 解析
      <input
        ref={input}
        type="file"
        accept=".pdf,.docx,.txt"
        className="sr-only"
        disabled={active}
        onChange={(event) => void pick(event.target.files?.[0])}
      />
    </label>
  );

  const waited = stage.kind === "sending" ? Math.max(0, Math.round((now - stage.startedAt) / 1000)) : 0;
  const background = !dialogOpen && (stage.kind === "sending" || stage.kind === "saving" || stage.kind === "save-failed");

  const panel = (
    <>
      {background ? (
        <div className={`resume-task${stage.kind === "save-failed" ? " is-error" : ""}`} role="group" aria-label="AI 解析进度">
          <p>
            {stage.kind === "sending"
              ? stage.cancelling
                ? `正在取消《${stage.fileName}》的解析…`
                : `AI 正在解析《${stage.fileName}》，已等待 ${waited} 秒。`
              : stage.kind === "saving"
                ? "正在保存解析出的模板…"
                : "解析结果还没存成模板。可以重新保存，不会再次发送简历。"}
          </p>
          <div className="row">
            <button type="button" onClick={() => setDialogOpen(true)}>
              {stage.kind === "save-failed" ? "查看" : "查看进度"}
            </button>
            {stage.kind === "sending" ? (
              <button type="button" disabled={stage.cancelling} onClick={cancel}>取消解析</button>
            ) : null}
            {stage.kind === "save-failed" ? (
              <>
                <button type="button" className="primary" onClick={() => void trySave(stage.fileName, stage.groups)}>重新保存</button>
                <button type="button" onClick={dismiss}>放弃这次结果</button>
              </>
            ) : null}
          </div>
        </div>
      ) : null}
      {notice ? <p role="status" className={`note ${notice.tone}`}>{notice.text}</p> : null}
    </>
  );

  const dialog = (() => {
    if (!dialogOpen) return null;
    if (stage.kind === "reading") {
      return (
        <ResumeDialog open title="正在读取简历"
          focusKey="reading" onCancel={dismiss} footer={<button type="button" data-autofocus onClick={dismiss}>取消</button>}>
          <p className="muted">正在本机读取《{stage.fileName}》的文字，读取完成后会先请你确认，再决定是否发送。</p>
        </ResumeDialog>
      );
    }
    if (stage.kind === "confirm") {
      const { provider, templateCount, charCount, userCharCount } = stage;
      const blocked = !provider
        ? "还没有可用的 AI 服务商（或它还没有 Key）。先在「设置 → AI」添加服务商并填好 Key，再重新选择文件。"
        : templateCount >= MAX_TEMPLATES
          ? `模板已经有 ${MAX_TEMPLATES} 个，先删掉用不上的再解析。`
          : userCharCount > MAX_USER_CHARS
            ? "简历文字太长（超过 6 万字），像是选错了文件。请换一份简历再试。"
            : null;
      return (
        <ResumeDialog
          open
          title="发送简历给 AI 解析？"
          focusKey="confirm"
          onCancel={dismiss}
          footer={
            <>
              <button type="button" data-autofocus onClick={dismiss}>不发送</button>
              <button
                type="button"
                className="primary"
                disabled={Boolean(blocked) || !provider}
                onClick={() => provider && void send(stage.fileName, stage.text, provider.id)}
              >
                发送并解析
              </button>
            </>
          }
        >
          <p>将把《{stage.fileName}》的全文（{charCount} 字）发送给：</p>
          {provider ? (
            <dl className="resume-dialog-facts">
              <dt>服务商</dt>
              <dd>{provider.name}</dd>
              <dt>主机</dt>
              <dd>{provider.host}</dd>
              <dt>模型</dt>
              <dd>{provider.model}</dd>
            </dl>
          ) : null}
          {provider ? (
            <p className="resume-dialog-warn">对方可能留存这些内容。解析成功后会直接新建模板并设为当前，可在模板列表里查看或删除。</p>
          ) : null}
          {blocked ? <p className="note error">{blocked}</p> : null}
        </ResumeDialog>
      );
    }
    if (stage.kind === "sending") {
      return (
        <ResumeDialog
          open
          title="AI 正在解析"
          focusKey="sending"
          onCancel={() => setDialogOpen(false)}
          footer={
            <>
              <button type="button" disabled={stage.cancelling} onClick={cancel}>
                {stage.cancelling ? "正在取消…" : "取消解析"}
              </button>
              <button type="button" className="primary" data-autofocus onClick={() => setDialogOpen(false)}>在后台继续</button>
            </>
          }
        >
          <p>正在等待 AI 解析《{stage.fileName}》，已等待 {waited} 秒。长简历可能要一两分钟。</p>
          <p className="muted">在后台继续时可以切到「我的信息」，回到「简历模板」仍能查看或取消。取消只是不再等待结果，不保证对方停止计算或计费。</p>
        </ResumeDialog>
      );
    }
    if (stage.kind === "saving") {
      return (
        <ResumeDialog open title="正在保存模板"
          focusKey="saving" onCancel={() => setDialogOpen(false)} footer={<button type="button" data-autofocus onClick={() => setDialogOpen(false)}>在后台继续</button>}>
          <p className="muted">AI 已返回字段，正在存成新模板。</p>
        </ResumeDialog>
      );
    }
    if (stage.kind === "save-failed") {
      return (
        <ResumeDialog
          open
          tone="warn"
          title="解析结果未能保存"
          focusKey="save-failed"
          onCancel={() => setDialogOpen(false)}
          footer={
            <>
              <button type="button" onClick={() => setDialogOpen(false)}>稍后处理</button>
              <button type="button" className="primary" data-autofocus onClick={() => void trySave(stage.fileName, stage.groups)}>重新保存</button>
            </>
          }
        >
          <p>AI 已返回字段，但新模板尚未创建。可以直接重试保存；不会再次向 AI 发送简历。</p>
          <p className="note error" role="alert">{stage.error}</p>
        </ResumeDialog>
      );
    }
    return null;
  })();

  return { trigger, panel, dialog, active };
}

/** 独立使用（测试）时的整块：入口、进度与提示、弹窗。简历页里由 TemplateList 分开摆放。 */
export function ResumeParse(options: { onCreated(templateId: string): void; extract?: (file: File) => Promise<string> }) {
  const parse = useResumeParse(options);
  if (!parse.trigger) return null;
  return (
    <div className="stack">
      <div className="row">{parse.trigger}</div>
      {parse.panel}
      {parse.dialog}
    </div>
  );
}

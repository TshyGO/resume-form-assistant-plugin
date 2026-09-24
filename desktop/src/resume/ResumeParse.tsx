import { useEffect, useRef, useState } from "react";
import type { AiProviderView, AiSettingsView, ImportResultView, ResumeOverview, TemplateGroupView } from "../api.ts";
import { useInvoke } from "../react/invoke.tsx";
import { extractText } from "./extract-text.ts";
import { MAX_TEMPLATES, MAX_USER_CHARS } from "./parse-limits.ts";
import { buildRequest, fieldsToGroups, parseModelReply, templateNameFor } from "./parse-resume.ts";
import type { Notice } from "./resume-text.ts";

type Stage =
  | { kind: "idle" }
  | { kind: "reading" }
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
  | { kind: "sending"; requestId: string; fileName: string }
  | { kind: "saving"; fileName: string; groups: TemplateGroupView[] }
  | { kind: "save-failed"; fileName: string; groups: TemplateGroupView[] }
  | { kind: "done" };

function errorText(error: unknown): string {
  if (typeof error === "string") return error;
  if (error instanceof Error) return error.message;
  return (error as { message?: string } | null)?.message ?? "解析失败，请重试。";
}

const BUSY_STAGES = new Set(["reading", "sending", "saving"]);

/**
 * 上传一份简历，交给「当前使用」的 AI 服务商解析，存成新模板并设为当前。
 * 发送前必须让用户看到：发给谁（服务商、主机、模型）、发多少字、对方可能留存（data-privacy §8）。
 */
export function ResumeParse({ onCreated, extract = extractText }: { onCreated(): void; extract?: (file: File) => Promise<string> }) {
  const invoke = useInvoke();
  const [stage, setStage] = useState<Stage>({ kind: "idle" });
  const [notice, setNotice] = useState<Notice | null>(null);
  const input = useRef<HTMLInputElement>(null);
  const counter = useRef(0);
  // 离开「简历」页时 ResumeView 会把这个组件整个卸载：正在等的那次 AI 请求不能假装
  // 还有界面在等它——卸载时把它取消，回来之后（哪怕这份 promise 稍后才落地）也
  // 不能再悄悄建模板、悄悄提示、或者叫一个已经没人看的 onCreated。
  const mountedRef = useRef(true);
  const inflightRequestId = useRef<string | null>(null);
  // invoke 来自 context，不必是 effect 的依赖：镜像进 ref，让下面这个 effect
  // 只在真正的挂载/卸载时跑一次，不会因为 context 值的引用变化而重新注册。
  const invokeRef = useRef(invoke);
  invokeRef.current = invoke;

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

  if (!invoke) return null;

  const pick = async (file: File | undefined) => {
    if (input.current) input.current.value = "";
    if (!file) return;
    setNotice(null);
    setStage({ kind: "reading" });
    try {
      const [text, settings, overview] = await Promise.all([
        extract(file),
        invoke<AiSettingsView>("get_ai_settings_cmd"),
        invoke<ResumeOverview>("resume_overview_cmd"),
      ]);
      if (!mountedRef.current) return;
      const provider = settings.providers.find((p) => p.id === settings.activeProviderId && p.keyConfigured) ?? null;
      const charCount = [...text].length;
      const userCharCount = [...buildRequest(text).user].length;
      setStage({
        kind: "confirm",
        fileName: file.name,
        text,
        provider,
        templateCount: overview.templates.length,
        charCount,
        userCharCount,
      });
    } catch (error) {
      if (!mountedRef.current) return;
      setStage({ kind: "idle" });
      setNotice({ tone: "error", text: errorText(error) });
    }
  };

  // 保存这一步单独抽出来：AI 解析成功但建模板失败时，重试只再调一次这个函数，
  // 不必（也不该）为了重试再花一次 AI 调用。
  const trySave = async (fileName: string, groups: TemplateGroupView[]) => {
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
      onCreated();
    } catch (error) {
      if (!mountedRef.current) return;
      setNotice({ tone: "error", text: errorText(error) });
      setStage({ kind: "save-failed", fileName, groups });
    }
  };

  const send = async (fileName: string, text: string, providerId: string) => {
    const requestId = `resume-parse-${Date.now()}-${++counter.current}`;
    inflightRequestId.current = requestId;
    setStage({ kind: "sending", requestId, fileName });
    let reply: string;
    try {
      const { system, user } = buildRequest(text);
      // 后端会自己再核实一遍「当前使用」是不是还是确认外发时看到的这个服务商
      // （AI_PROVIDER_CHANGED）：这里传的 providerId 就是确认时快照的那个 id。
      reply = await invoke<string>("ai_complete_cmd", { system, user, requestId, providerId });
    } catch (error) {
      inflightRequestId.current = null;
      if (!mountedRef.current) return;
      setStage({ kind: "idle" });
      setNotice({ tone: "error", text: errorText(error) });
      return;
    }
    inflightRequestId.current = null;
    // 等回来时页面已经被卸载：这次解析已经没有界面能看着它了，既不建模板，
    // 也不提示——onCreated 也不叫，免得打到一个已经不存在的模板列表刷新。
    if (!mountedRef.current) return;
    let groups: TemplateGroupView[];
    try {
      groups = fieldsToGroups(parseModelReply(reply));
    } catch (error) {
      setStage({ kind: "idle" });
      setNotice({ tone: "error", text: errorText(error) });
      return;
    }
    await trySave(fileName, groups);
  };

  const cancel = (requestId: string) => {
    void invoke("cancel_analysis_cmd", { requestId }).catch(() => {});
  };

  const disabled = BUSY_STAGES.has(stage.kind);

  return (
    <div className="stack">
      <div className="row">
        <label className={disabled ? "button-like disabled" : "button-like"}>
          上传简历，AI 解析
          <input
            ref={input}
            type="file"
            accept=".pdf,.docx,.txt"
            className="sr-only"
            disabled={disabled}
            onChange={(event) => void pick(event.target.files?.[0])}
          />
        </label>
        <span className="muted">支持 PDF、Word（.docx）、TXT。扫描版 PDF 抽不出文字。</span>
      </div>
      {stage.kind === "reading" ? <p className="muted">正在读取文件…</p> : null}
      {stage.kind === "confirm" ? (() => {
        const { provider, templateCount, charCount, userCharCount } = stage;
        const blocked = !provider
          ? "还没有可用的 AI 服务商（或它还没有 Key）。先在「设置 → AI」添加服务商并填好 Key。"
          : templateCount >= MAX_TEMPLATES
            ? `模板已经有 ${MAX_TEMPLATES} 个，先删掉用不上的再解析。`
            : userCharCount > MAX_USER_CHARS
              ? "简历文字太长（超过 6 万字），像是选错了文件。"
              : null;
        return (
          <div className="note warn stack" role="group" aria-label="确认外发">
            {provider ? (
              <p>
                将把简历全文（{charCount} 字）发给「{provider.name}」解析：{provider.host} · {provider.model}。对方可能留存这些内容。
                解析结果会直接存成一个新模板并设为当前，可在下面的模板列表里查看或删除。
              </p>
            ) : null}
            {blocked ? <p>{blocked}</p> : null}
            <div className="row">
              {provider && !blocked ? (
                <button type="button" className="primary" onClick={() => void send(stage.fileName, stage.text, provider.id)}>
                  发送并解析
                </button>
              ) : null}
              <button type="button" onClick={() => setStage({ kind: "idle" })}>
                不发送
              </button>
            </div>
          </div>
        );
      })() : null}
      {stage.kind === "sending" ? (
        <div className="row">
          <span className="muted">正在等待 AI 解析，长简历可能要一两分钟…</span>
          <button type="button" onClick={() => cancel(stage.requestId)}>
            取消
          </button>
        </div>
      ) : null}
      {stage.kind === "saving" ? <p className="muted">正在保存模板…</p> : null}
      {stage.kind === "save-failed" ? (
        <div className="row">
          <button type="button" className="primary" onClick={() => void trySave(stage.fileName, stage.groups)}>
            重新保存
          </button>
        </div>
      ) : null}
      {notice ? <p role="status" className={`note ${notice.tone}`}>{notice.text}</p> : null}
    </div>
  );
}

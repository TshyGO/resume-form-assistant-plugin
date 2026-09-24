import { useRef, useState } from "react";
import type { AiProviderView, AiSettingsView, ImportResultView } from "../api.ts";
import { useInvoke } from "../react/invoke.tsx";
import { extractText } from "./extract-text.ts";
import { buildRequest, fieldsToGroups, parseModelReply, templateNameFor } from "./parse-resume.ts";
import type { Notice } from "./resume-text.ts";

type Stage =
  | { kind: "idle" }
  | { kind: "reading" }
  | { kind: "confirm"; fileName: string; text: string; provider: AiProviderView | null }
  | { kind: "sending"; requestId: string }
  | { kind: "done" };

function errorText(error: unknown): string {
  if (error instanceof Error) return error.message;
  return (error as { message?: string } | null)?.message ?? "解析失败，请重试。";
}

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

  if (!invoke) return null;

  const pick = async (file: File | undefined) => {
    if (input.current) input.current.value = "";
    if (!file) return;
    setNotice(null);
    setStage({ kind: "reading" });
    try {
      const [text, settings] = await Promise.all([extract(file), invoke<AiSettingsView>("get_ai_settings_cmd")]);
      const provider = settings.providers.find((p) => p.id === settings.activeProviderId && p.keyConfigured) ?? null;
      setStage({ kind: "confirm", fileName: file.name, text, provider });
    } catch (error) {
      setStage({ kind: "idle" });
      setNotice({ tone: "error", text: errorText(error) });
    }
  };

  const send = async (fileName: string, text: string) => {
    const requestId = `resume-parse-${Date.now()}-${++counter.current}`;
    setStage({ kind: "sending", requestId });
    try {
      const { system, user } = buildRequest(text);
      const reply = await invoke<string>("ai_complete_cmd", { system, user, requestId });
      const groups = fieldsToGroups(parseModelReply(reply));
      const result = await invoke<ImportResultView>("create_resume_template_cmd", { name: templateNameFor(fileName), groups });
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
      setStage({ kind: "idle" });
      setNotice({ tone: "error", text: errorText(error) });
    }
  };

  return (
    <div className="stack">
      <div className="row">
        <label className="button-like">
          上传简历，AI 解析
          <input
            ref={input}
            aria-label="选择简历文件"
            type="file"
            accept=".pdf,.docx,.txt"
            className="sr-only"
            disabled={stage.kind === "reading" || stage.kind === "sending"}
            onChange={(event) => void pick(event.target.files?.[0])}
          />
        </label>
        <span className="muted">支持 PDF、Word（.docx）、TXT。扫描版 PDF 抽不出文字。</span>
      </div>
      {stage.kind === "reading" ? <p className="muted">正在读取文件…</p> : null}
      {stage.kind === "confirm" ? (
        stage.provider ? (
          <div className="note warn stack" role="group" aria-label="确认外发">
            <p>
              将把简历全文（{stage.text.length} 字）发给「{stage.provider.name}」解析：{stage.provider.host} · {stage.provider.model}。对方可能留存这些内容。
            </p>
            <div className="row">
              <button type="button" className="primary" onClick={() => void send(stage.fileName, stage.text)}>
                发送并解析
              </button>
              <button type="button" onClick={() => setStage({ kind: "idle" })}>
                不发送
              </button>
            </div>
          </div>
        ) : (
          <p className="note warn">还没有可用的 AI 服务商（或它还没有 Key）。先在「设置 → AI」添加服务商并填好 Key。</p>
        )
      ) : null}
      {stage.kind === "sending" ? (
        <div className="row">
          <span className="muted">正在等待 AI 解析，长简历可能要一两分钟…</span>
          <button type="button" onClick={() => void invoke("cancel_analysis_cmd", { requestId: stage.requestId })}>
            取消
          </button>
        </div>
      ) : null}
      {notice ? <p role="status" className={`note ${notice.tone}`}>{notice.text}</p> : null}
    </div>
  );
}

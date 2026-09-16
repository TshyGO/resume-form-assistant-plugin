import { useCallback, useEffect, useRef, useState } from "react";
import type {
  AiSuggestion,
  ApplicationSummary,
  ConfirmResult,
  EvidencePreview,
  OutboundPreview,
  Page,
} from "../api.ts";
import { useInvoke } from "../react/invoke.tsx";
import { AnalyzeDialog } from "./AnalyzeDialog.tsx";
import { ReviewPanel } from "./ReviewPanel.tsx";
import { confirmArgs, describeFailure, initialDraft } from "./review.ts";
import type { Draft, Failure, Phase } from "./review.ts";

function newRequestId(): string {
  const uuid = globalThis.crypto?.randomUUID?.();
  return uuid ?? `req-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

/**
 * 收件箱里一条证据的「AI 整理」。
 *
 * 这一块归 React 管：旧视图只给一个挂载点和证据 id，不读这里的状态，也不改这里的 DOM。
 */
export function AiReview({ evidenceId, onConfirmed }: { evidenceId: string; onConfirmed?: () => void }) {
  const invoke = useInvoke();
  const [phase, setPhase] = useState<Phase>("idle");
  const [preview, setPreview] = useState<OutboundPreview | null>(null);
  const [applications, setApplications] = useState<ApplicationSummary[]>([]);
  const [selectedIds, setSelectedIds] = useState<string[] | null>(null);
  const [suggestion, setSuggestion] = useState<AiSuggestion | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [body, setBody] = useState("");
  const [failure, setFailure] = useState<Failure | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [elapsed, setElapsed] = useState(0);
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState<AiSuggestion[]>([]);
  const requestId = useRef<string | null>(null);

  // 这条证据上以前留下的建议（暂存的、拒绝过的、确认过的都在）。
  useEffect(() => {
    setPhase("idle");
    setPreview(null);
    setSuggestion(null);
    setDraft(null);
    setFailure(null);
    setNotice(null);
    setSelectedIds(null);
    if (!invoke) return;
    invoke<AiSuggestion[]>("list_suggestions_cmd", { evidenceId })
      .then(setSaved)
      .catch(() => setSaved([]));
    // 申请清单两处都要用：预览里改候选，审核里模型没指认时自己挑。
    invoke<Page<ApplicationSummary>>("list_applications_cmd", {
      args: { stage: "all", recycle: "active", desc: true, limit: 100, offset: 0 },
    })
      .then((page) => setApplications(page?.items ?? []))
      .catch(() => setApplications([]));
  }, [invoke, evidenceId]);

  // 等待期间的秒表。慢提示和「还在等」都看它。
  useEffect(() => {
    if (phase !== "sending") return;
    const started = Date.now();
    setElapsed(0);
    const timer = setInterval(() => setElapsed((Date.now() - started) / 1000), 1000);
    return () => clearInterval(timer);
  }, [phase]);

  const openReview = useCallback(
    async (next: AiSuggestion) => {
      setSuggestion(next);
      setDraft(initialDraft(next));
      setPhase("review");
      if (!invoke) return;
      try {
        const evidence = await invoke<EvidencePreview>("get_evidence_preview_cmd", { evidenceId });
        setBody(evidence?.bodyExtract ?? "");
      } catch {
        setBody("");
      }
    },
    [invoke, evidenceId],
  );

  const loadPreview = useCallback(
    async (ids: string[] | null) => {
      if (!invoke) return;
      setBusy(true);
      setFailure(null);
      try {
        // 申请清单在挂载时就取过了，这里只算这一次的外发范围。
        setPreview(await invoke<OutboundPreview>("preview_analysis_cmd", {
          evidenceId,
          candidateIds: ids,
        }));
        setPhase("preview");
      } catch (error) {
        setFailure(describeFailure(error));
        setPhase("failed");
      } finally {
        setBusy(false);
      }
    },
    [invoke, evidenceId],
  );

  const send = async () => {
    if (!invoke) return;
    const id = newRequestId();
    requestId.current = id;
    setPhase("sending");
    setFailure(null);
    try {
      const next = await invoke<AiSuggestion>("analyze_evidence_cmd", {
        evidenceId,
        requestId: id,
        candidateIds: selectedIds,
      });
      setSaved((rows) => [...rows, next]);
      await openReview(next);
    } catch (error) {
      setFailure(describeFailure(error));
      setPhase("failed");
    } finally {
      requestId.current = null;
    }
  };

  const cancelRequest = async () => {
    const id = requestId.current;
    if (!invoke || !id) return;
    try {
      await invoke<boolean>("cancel_analysis_cmd", { requestId: id });
    } catch {
      // 取消失败多半是它刚好跑完了，下一条消息会说清楚结果。
    }
  };

  const decide = async (command: string, args: Record<string, unknown>, done: (result: unknown) => void) => {
    if (!invoke) return;
    setBusy(true);
    setFailure(null);
    try {
      done(await invoke(command, args));
    } catch (error) {
      setFailure(describeFailure(error));
    } finally {
      setBusy(false);
    }
  };

  const confirm = () => {
    if (!suggestion || !draft) return;
    void decide("confirm_suggestion_cmd", { args: confirmArgs(draft, suggestion) }, (result) => {
      const outcome = result as ConfirmResult;
      setPhase("idle");
      setSuggestion(null);
      setDraft(null);
      const problems = outcome.reminderProblems ?? [];
      setNotice(
        outcome.alreadyConfirmed
          ? "这条建议已经确认过了，这次没有重复写入。"
          : problems.length
            ? `已确认。待办建好了，但提醒没登记上：${problems.join("；")}`
            : "已确认。分类、时间线和待办都写好了。",
      );
      onConfirmed?.();
    });
  };

  const setStatus = (command: string, text: string) => {
    if (!suggestion) return;
    void decide(command, { suggestionId: suggestion.id }, (result) => {
      setSaved((rows) => rows.map((row) => (row.id === suggestion.id ? (result as AiSuggestion) : row)));
      setPhase("idle");
      setSuggestion(null);
      setDraft(null);
      setNotice(text);
    });
  };

  const pending = saved.filter((row) => row.status === "pending" || row.status === "deferred");

  return (
    <section className="stack ai-panel">
      {phase === "idle" ? (
        <div className="stack">
          <div className="row">
            <button type="button" onClick={() => void loadPreview(selectedIds)} disabled={!invoke || busy}>
              AI 整理
            </button>
            {pending.map((row) => (
              <button key={row.id} type="button" onClick={() => void openReview(row)} disabled={busy}>
                {row.status === "deferred" ? "打开暂存的建议" : "打开待确认的建议"}
              </button>
            ))}
          </div>
          <p className="muted">
            会把这封通知的正文和几条候选申请发给你配的服务商。发送前会先让你看一遍。
          </p>
        </div>
      ) : null}

      {(phase === "preview" || phase === "sending") && preview ? (
        <AnalyzeDialog
          preview={preview}
          applications={applications}
          selectedIds={selectedIds}
          sending={phase === "sending"}
          elapsedSeconds={elapsed}
          onSelectionChange={(ids) => {
            setSelectedIds(ids);
            void loadPreview(ids);
          }}
          onSend={() => void send()}
          onCancelRequest={() => void cancelRequest()}
          onClose={() => setPhase("idle")}
        />
      ) : null}

      {phase === "review" && suggestion && draft ? (
        <ReviewPanel
          suggestion={suggestion}
          applications={applications}
          body={body}
          draft={draft}
          busy={busy}
          onDraftChange={setDraft}
          onConfirm={confirm}
          onReject={() => setStatus("reject_suggestion_cmd", "已拒绝。正式记录一个字都没动。")}
          onDefer={() => setStatus("defer_suggestion_cmd", "已暂存。下次打开这条证据还能接着看。")}
        />
      ) : null}

      {failure ? (
        <div className="stack">
          <p className="note error">{failure.text}</p>
          <p className="muted">{failure.next}</p>
          {failure.retryable ? (
            <button type="button" onClick={() => void loadPreview(selectedIds)} disabled={busy}>
              再试一次
            </button>
          ) : null}
          <button type="button" onClick={() => { setFailure(null); setPhase("idle"); }}>
            关掉
          </button>
        </div>
      ) : null}

      {notice ? <p className="note ok">{notice}</p> : null}
    </section>
  );
}

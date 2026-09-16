import { useCallback, useEffect, useRef, useState } from "react";
import type {
  AiSuggestion,
  ApplicationSummary,
  ConfirmResult,
  EvidencePreview,
  Invoke,
  OutboundPreview,
  Page,
} from "../api.ts";
import { useInvoke } from "../react/invoke.tsx";
import { AnalyzeDialog } from "./AnalyzeDialog.tsx";
import { ReviewPanel } from "./ReviewPanel.tsx";
import { confirmArgs, describeFailure, initialDraft } from "./review.ts";
import type { Draft, Failure, Phase } from "./review.ts";

/** 每页取多少条申请，以及最多翻几页。存储层把 limit 卡在 1000 以内。 */
const PAGE_SIZE = 200;
const MAX_PAGES = 5;

/**
 * 把在办申请都取回来。零候选、模型指错、候选被删这几种情况都得靠这份清单收场，
 * 只取前一页会让第 201 条之后的申请没法选。取满上限还没取完就如实说一声。
 */
async function loadApplications(
  invoke: Invoke,
): Promise<{ items: ApplicationSummary[]; truncated: boolean }> {
  const items: ApplicationSummary[] = [];
  for (let page = 0; page < MAX_PAGES; page += 1) {
    const result = await invoke<Page<ApplicationSummary>>("list_applications_cmd", {
      args: {
        stage: "all",
        recycle: "active",
        desc: true,
        limit: PAGE_SIZE,
        offset: page * PAGE_SIZE,
      },
    });
    items.push(...(result?.items ?? []));
    if (items.length >= (result?.total ?? items.length)) {
      return { items, truncated: false };
    }
    if (!result?.items?.length) break;
  }
  return { items, truncated: true };
}

function newRequestId(): string {
  const uuid = globalThis.crypto?.randomUUID?.();
  return uuid ?? `req-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

/**
 * 收件箱里一条证据的「AI 整理」。
 *
 * 这一块归 React 管：旧视图只给一个挂载点和证据 id，不读这里的状态，也不改这里的 DOM。
 */
export function AiReview({
  evidenceId,
  onConfirmed,
}: {
  evidenceId: string;
  /** 确认完了告诉宿主一声：它负责刷新那条证据，并把这句话显示在面板之外。 */
  onConfirmed?: (message: string) => void;
}) {
  const invoke = useInvoke();
  const [phase, setPhase] = useState<Phase>("idle");
  const [preview, setPreview] = useState<OutboundPreview | null>(null);
  const [applications, setApplications] = useState<ApplicationSummary[]>([]);
  const [truncated, setTruncated] = useState(false);
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
  const invokeRef = useRef(invoke);
  invokeRef.current = invoke;
  /** 预览的请求序号：连点候选时只认最后一次的结果。 */
  const previewToken = useRef(0);

  // 这条证据上以前留下的建议（暂存的、拒绝过的、确认过的都在）。
  useEffect(() => {
    setPhase("idle");
    setPreview(null);
    setSuggestion(null);
    setDraft(null);
    setFailure(null);
    setNotice(null);
    setSelectedIds(null);
    setSaved([]);
    setBody("");
    if (!invoke) return;
    invoke<AiSuggestion[]>("list_suggestions_cmd", { evidenceId })
      // 归并而不是覆盖：这个请求慢的时候，用户可能已经发完一次分析了，
      // 后到的旧列表不该把新建议冲掉。
      .then((rows) =>
        setSaved((current) => {
          const merged = new Map((rows ?? []).map((row) => [row.id, row]));
          for (const row of current) merged.set(row.id, row);
          return [...merged.values()];
        }),
      )
      .catch((error: unknown) => setFailure({ ...describeFailure(error), retry: "none" }));
    // 申请清单两处都要用：预览里改候选，审核里模型没指认时自己挑。
    loadApplications(invoke)
      .then(({ items, truncated: more }) => {
        setApplications(items);
        setTruncated(more);
      })
      .catch((error: unknown) => setFailure({ ...describeFailure(error), retry: "none" }));
  }, [invoke, evidenceId]);

  // 面板被卸掉时（旧视图切到另一条证据）请求还在跑，就替用户取消掉：
  // 不然它继续算、继续计费，而界面上再也没有取消它的入口。
  useEffect(
    () => () => {
      const id = requestId.current;
      if (id) {
        // 取消本身失败也无所谓：面板已经没了，这里只是尽力而为。
        invokeRef.current?.<boolean>("cancel_analysis_cmd", { requestId: id }).catch(() => {});
      }
    },
    [],
  );

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
      setNotice(null);
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
      const token = ++previewToken.current;
      setBusy(true);
      setFailure(null);
      setNotice(null);
      try {
        // 申请清单在挂载时就取过了，这里只算这一次的外发范围。
        const outbound = await invoke<OutboundPreview>("preview_analysis_cmd", {
          evidenceId,
          candidateIds: ids,
        });
        // 连点候选时旧的响应可能后到。晚到的一律丢掉，否则界面上写的候选
        // 和真正会发出去的那几条对不上——这块预览的意义就没了。
        if (token !== previewToken.current) return;
        setPreview(outbound);
        setPhase("preview");
      } catch (error) {
        if (token !== previewToken.current) return;
        setFailure({ ...describeFailure(error), retry: "analyze" });
        setPhase("failed");
      } finally {
        if (token === previewToken.current) setBusy(false);
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
    setNotice(null);
    try {
      const next = await invoke<AiSuggestion>("analyze_evidence_cmd", {
        evidenceId,
        requestId: id,
        candidateIds: selectedIds,
      });
      setSaved((rows) => [...rows, next]);
      await openReview(next);
    } catch (error) {
      setFailure({ ...describeFailure(error), retry: "analyze" });
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
      // 确认/拒绝失败时**不退出审核**：草稿还在，改完再按一次就行。
      // 这里也不给「再试一次」，那个按钮回到的是外发预览，再发一次要重新计费。
      setFailure({ ...describeFailure(error), retry: "none" });
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
      // 确认过的那条不再是「待确认」，按钮得跟着消失。
      setSaved((rows) => rows.map((row) => (row.id === outcome.suggestion.id ? outcome.suggestion : row)));
      const problems = outcome.reminderProblems ?? [];
      const todos = outcome.todos ?? [];
      const message = outcome.alreadyConfirmed
        ? "这条建议已经确认过了，这次没有重复写入。"
        : problems.length
          ? `已确认。待办建好了，但提醒没登记上：${problems.join("；")}`
          : todos.length
            ? `已确认。分类、时间线和 ${todos.length} 条待办都写好了。`
            : "已确认。分类和时间线都写好了，这次没有建待办。";
      setNotice(message);
      // 宿主接着会重画这条证据，把这块面板连同 notice 一起卸掉——所以这句话
      // 得交给面板外面的状态栏去说，不能只 setNotice 就完事。
      onConfirmed?.(message);
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

  // 拒绝过的也留个入口：点错了不该只能重新分析一次（那要再付一次钱）。
  const reopenable = saved.filter((row) =>
    ["pending", "deferred", "rejected"].includes(row.status),
  );

  return (
    <section className="stack ai-panel">
      {phase === "idle" ? (
        <div className="stack">
          <div className="row">
            <button type="button" onClick={() => void loadPreview(selectedIds)} disabled={!invoke || busy}>
              AI 整理
            </button>
            {reopenable.map((row) => (
              <button key={row.id} type="button" onClick={() => void openReview(row)} disabled={busy}>
                {row.status === "deferred"
                  ? "打开暂存的建议"
                  : row.status === "rejected"
                    ? "打开拒绝过的建议"
                    : "打开待确认的建议"}
                {reopenable.length > 1
                  ? `（${row.modelLabel ?? "模型未知"} · ${row.createdAt.slice(0, 16).replace("T", " ")} UTC）`
                  : ""}
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
          truncated={truncated}
          elapsedSeconds={elapsed}
          busy={busy}
          onSelectionChange={(ids) => {
            setSelectedIds(ids);
            void loadPreview(ids);
          }}
          onSend={() => void send()}
          onCancelRequest={() => void cancelRequest()}
          onClose={() => {
            // 正在重算的那次预览作废：不然它回来又把界面拉回预览页。
            // 等待中点「不等了」也走这里：顺手把请求取消掉。
            previewToken.current += 1;
            const id = requestId.current;
            if (id) {
              void invoke?.<boolean>("cancel_analysis_cmd", { requestId: id }).catch(() => {});
              requestId.current = null;
            }
            setBusy(false);
            setPhase("idle");
          }}
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
          {failure.retryable && failure.retry === "analyze" ? (
            <button type="button" onClick={() => void loadPreview(selectedIds)} disabled={busy}>
              再试一次
            </button>
          ) : null}
          <button
            type="button"
            onClick={() => {
              setFailure(null);
              // 审核阶段只关掉这条错误：草稿改了一半，不能顺手丢掉。
              if (phase !== "review") setPhase("idle");
            }}
          >
            关掉
          </button>
        </div>
      ) : null}

      {truncated && phase === "review" ? (
        <p className="muted">申请太多，只列出了最近 {PAGE_SIZE * MAX_PAGES} 条。</p>
      ) : null}
      {notice ? <p className="note ok">{notice}</p> : null}
    </section>
  );
}

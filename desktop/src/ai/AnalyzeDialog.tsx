import type { ApplicationSummary, OutboundPreview } from "../api.ts";
import { MAX_CANDIDATES, waitingText } from "./review.ts";

/**
 * 发送前的那一屏：**这一次要把什么发出去**，看清楚了再点发送。
 *
 * 候选可以自己改——用户比模型更清楚哪几条不相干。改完会重新算一次预览，
 * 所以上面写的永远是「按现在这个选法真会发出去的东西」。
 */
export function AnalyzeDialog({
  preview,
  applications,
  selectedIds,
  sending,
  busy,
  elapsedSeconds,
  onSelectionChange,
  onSend,
  onCancelRequest,
  onClose,
}: {
  preview: OutboundPreview;
  applications: ApplicationSummary[];
  /** 用户手选的候选。`null` 表示交给桌面按公司名去认。 */
  selectedIds: string[] | null;
  sending: boolean;
  /** 预览正在重算。这期间不让改候选也不让发，免得发的和看到的不是一回事。 */
  busy: boolean;
  elapsedSeconds: number;
  onSelectionChange: (ids: string[] | null) => void;
  onSend: () => void;
  onCancelRequest: () => void;
  onClose: () => void;
}) {
  const chosen = selectedIds ?? [];
  const tooMany = chosen.length > MAX_CANDIDATES;
  const toggle = (id: string) => {
    const next = chosen.includes(id) ? chosen.filter((item) => item !== id) : [...chosen, id];
    onSelectionChange(next.length ? next : null);
  };

  return (
    <div className="stack ai-outbound">
      <h4>这次要发出去的东西</h4>
      <ul>
        <li>
          发往 <strong>{preview.host}</strong>，模型 <strong>{preview.model}</strong>
        </li>
        <li>
          正文 {preview.bodyChars} 字{preview.truncated ? "（超出的部分会截掉）" : ""}
          {preview.hasSubject ? "，含邮件主题" : ""}
          {preview.hasFrom ? "，含发件人" : ""}
        </li>
        <li>候选 {preview.candidates.length} 条，只发公司名、岗位名和当前阶段，不发任何本机 id</li>
      </ul>
      <p className="note warn">发出去的内容，你配的这家服务商可能会留存。</p>

      <h5>候选</h5>
      <ul className="ai-candidates">
        {preview.candidates.map((candidate, index) => (
          <li key={index}>
            {candidate.company} · {candidate.title}
          </li>
        ))}
      </ul>
      {busy ? <p className="muted">正在按新的选法重算这次要发什么…</p> : null}
      {chosen.length >= MAX_CANDIDATES ? (
        <p className="note warn">一次最多送 {MAX_CANDIDATES} 条候选，已经选满了。</p>
      ) : null}

      <details>
        <summary>自己选候选</summary>
        <p className="muted">不选就由桌面拿公司名去认。选了就只发选中的这几条。</p>
        <ul className="ai-candidates">
          {applications.map((application) => (
            <li key={application.id}>
              <label>
                <input
                  type="checkbox"
                  checked={chosen.includes(application.id)}
                  // 勾满上限之后剩下的就按不动了：让用户走进一个必定失败的预览，
                  // 再把他锁在没有勾选框的错误页上，是最糟的做法。
                  disabled={
                    sending ||
                    busy ||
                    (chosen.length >= MAX_CANDIDATES && !chosen.includes(application.id))
                  }
                  onChange={() => toggle(application.id)}
                />
                {application.company} · {application.title}
              </label>
            </li>
          ))}
        </ul>
      </details>

      <h5>正文开头</h5>
      <pre className="evidence-body">{preview.bodyPreview}</pre>

      {sending ? (
        <div className="stack">
          <p className="note">{waitingText(elapsedSeconds, preview.slowHintSeconds)}</p>
          <button type="button" onClick={onCancelRequest}>
            取消
          </button>
          <p className="muted">取消不保证对方停止计算或停止计费。</p>
        </div>
      ) : (
        <div className="row">
          <button type="button" onClick={onSend} disabled={busy || tooMany}>
            发送
          </button>
          <button type="button" onClick={onClose}>
            先不发
          </button>
        </div>
      )}
    </div>
  );
}

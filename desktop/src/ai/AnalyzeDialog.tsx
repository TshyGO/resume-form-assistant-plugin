import type { ReactNode } from "react";
import type { ApplicationSummary, OutboundPreview } from "../api.ts";
import { stageLabel } from "../applications.ts";
import { ResumeDialog } from "../resume/ResumeDialog.tsx";
import { waitingText } from "./review.ts";

/**
 * 发送前的那一屏：**这一次要把什么发出去**，看清楚了再点发送。#262 起放在弹窗里。
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
  truncated,
  elapsedSeconds,
  onSelectionChange,
  onSend,
  onCancelRequest,
  onClose,
  extra,
}: {
  preview: OutboundPreview;
  applications: ApplicationSummary[];
  /** 用户手选的候选。`null` 表示交给桌面按公司名去认。 */
  selectedIds: string[] | null;
  sending: boolean;
  /** 预览正在重算。这期间不让改候选也不让发，免得发的和看到的不是一回事。 */
  busy: boolean;
  /** 申请太多没列全，手选清单是不全的，得说一声。 */
  truncated: boolean;
  elapsedSeconds: number;
  onSelectionChange: (ids: string[] | null) => void;
  onSend: () => void;
  onCancelRequest: () => void;
  onClose: () => void;
  /** 弹窗开着时出的错（比如候选申请读不出来），由宿主给，就近显示在弹窗里。 */
  extra?: ReactNode;
}) {
  const chosen = selectedIds ?? [];
  // 上限由命令层带回来，界面不另抄一份常量。
  const cap = preview.maxCandidates;
  const tooMany = chosen.length > cap;
  const toggle = (id: string) => {
    const next = chosen.includes(id) ? chosen.filter((item) => item !== id) : [...chosen, id];
    onSelectionChange(next.length ? next : null);
  };
  const parts = [
    `正文 ${preview.bodyChars} 字${preview.truncated ? "（超出的部分会截掉）" : ""}`,
    preview.hasSubject ? "邮件主题" : "",
    preview.hasFrom ? "发件人" : "",
  ].filter(Boolean);

  return (
    <ResumeDialog
      open
      wide
      className="ai-dialog"
      title={sending ? "正在等待 AI 整理结果" : "发送前确认"}
      // 等待中按 Esc 不关：要停就用下面明确的「取消」或「不等了，关掉」。
      onCancel={onClose}
      cancelDisabled={sending}
      focusKey={sending ? "sending" : "preview"}
      footer={
        sending ? (
          <>
            {/* 取消命令本身也可能失败或者迟迟不返回。留一条纯界面的退路，
                不然这块弹窗会一直停在等待页。 */}
            <button type="button" onClick={onClose} data-autofocus>
              不等了，关掉
            </button>
            {/* 「发送」按下去之后同一位置变成「取消」。连点两下会把刚发出去的
                请求立刻取消掉，而取消不保证对方停止计费——所以头半秒先不接受点击。 */}
            <button type="button" className="danger" onClick={onCancelRequest} disabled={elapsedSeconds < 0.5}>
              取消
            </button>
          </>
        ) : (
          <>
            <button type="button" onClick={onClose} data-autofocus>
              先不发
            </button>
            <button type="button" className="primary" onClick={onSend} disabled={busy || tooMany}>
              发送
            </button>
          </>
        )
      }
    >
      <div className="ai-outbound">
        <p className="dialog-intro">
          {sending
            ? "请求已经发出。结果回来后会打开审核，确认之前不会改动任何申请或待办。"
            : "下面是这一次要发给你所配置服务商的全部内容。确认无误再发送。"}
        </p>
        <dl className="ai-outbound-facts">
          <div>
            <dt>发往</dt>
            <dd>{preview.host}</dd>
          </div>
          <div>
            <dt>模型</dt>
            <dd>{preview.model}</dd>
          </div>
          <div>
            <dt>内容</dt>
            <dd>{parts.join("，")}</dd>
          </div>
          <div>
            <dt>候选申请</dt>
            <dd>{preview.candidates.length} 条，只发公司名、岗位名和当前阶段，不发任何本机 id</dd>
          </div>
        </dl>
        <p className="note warn">发出去的内容，你配的这家服务商可能会留存。</p>

        {sending ? (
          <div className="ai-waiting" role="status">
            <span className="ai-spinner" aria-hidden="true" />
            <div>
              <p>{waitingText(elapsedSeconds, preview.slowHintSeconds)}</p>
              <p className="muted">取消不保证对方停止计算或停止计费。</p>
            </div>
          </div>
        ) : null}

        <h3>候选申请</h3>
        {preview.candidates.length ? (
          <ul className="ai-candidates">
            {preview.candidates.map((candidate) => (
              <li key={candidate.label}>
                {candidate.company} · {candidate.title}
                {candidate.stage ? `（当前阶段：${stageLabel(candidate.stage)}）` : ""}
              </li>
            ))}
          </ul>
        ) : (
          <p className="muted">这次没有带候选申请。</p>
        )}
        {busy ? <p className="muted">正在按新的选法重算这次要发什么…</p> : null}
        {chosen.length >= cap ? (
          <p className="note warn">一次最多送 {cap} 条候选，已经选满了。</p>
        ) : null}

        <details className="ai-pick">
          <summary>自己选候选</summary>
          <p className="muted">不选就由桌面拿公司名去认。选了就只发选中的这几条。</p>
          {truncated ? <p className="muted">申请太多，这里只列出了最近的一部分。</p> : null}
          <ul className="ai-candidates is-choices">
            {applications.map((application) => (
              <li key={application.id}>
                <label>
                  <input
                    type="checkbox"
                    checked={chosen.includes(application.id)}
                    // 勾满上限之后剩下的就按不动了：让用户走进一个必定失败的预览，
                    // 再把他锁在没有勾选框的错误页上，是最糟的做法。
                    disabled={
                      sending || busy || (chosen.length >= cap && !chosen.includes(application.id))
                    }
                    onChange={() => toggle(application.id)}
                  />
                  {application.company} · {application.title}
                </label>
              </li>
            ))}
          </ul>
        </details>

        <h3>正文开头</h3>
        <p className="muted">
          下面是前 {preview.bodyPreview.length} 字；这次会发出去的是 {preview.bodyChars} 字
          {preview.truncated ? "（已按上限截断）" : ""}。
        </p>
        <pre className="evidence-body">{preview.bodyPreview}</pre>
        {extra}
      </div>
    </ResumeDialog>
  );
}

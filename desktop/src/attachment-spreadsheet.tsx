import { useEffect, useState } from "react";
import type { SpreadsheetPreview } from "./attachment-types.ts";
import { useInvoke } from "./react/invoke.tsx";
const columnLabel = (index: number) => {
  let label = "";
  for (let n = index + 1; n > 0; n = Math.floor((n - 1) / 26)) label = String.fromCharCode(65 + (n - 1) % 26) + label;
  return label;
};
export function AttachmentSpreadsheet({ evidenceId, index, sourceSha256 }: { evidenceId: string; index: number; sourceSha256: string }) {
  const invoke = useInvoke();
  const [sheet, setSheet] = useState(0);
  const [view, setView] = useState<SpreadsheetPreview | null>(null);
  const [names, setNames] = useState<string[]>([]);
  const [error, setError] = useState("");
  const [retry, setRetry] = useState(0);
  useEffect(() => {
    let active = true; setView(null); setError("");
    if (!invoke) { setError("请在桌面程序里预览表格。"); return; }
    void invoke<SpreadsheetPreview>("preview_evidence_spreadsheet_cmd", { evidenceId, index, sourceSha256, sheetIndex: sheet }).then(data => {
      if (active) { setView(data); setNames(data.sheetNames); }
    }, err => { if (active) setError(typeof err === "string" ? err : err?.message || "表格读不出来，可另存为或用系统程序打开。"); });
    return () => { active = false; };
  }, [invoke, evidenceId, index, sourceSha256, sheet, retry]);
  const rows = Math.min(view?.rowCount ?? 0, 500);
  const cols = Math.min(view?.columnCount ?? 0, 50);
  const cells = new Map(view?.cells.map(([r, c, value]) => [`${r}:${c}`, value]));
  return <div className="attachment-document attachment-spreadsheet">
    <div className="attachment-tools"><label>工作表 <select aria-label="工作表" value={sheet} onChange={e => setSheet(Number(e.target.value))}>
      {(names.length ? names : ["正在读取…"]).map((name, i) => <option key={i} value={i}>{name}</option>)}
    </select></label><span className="muted">只读预览{view ? ` · ${view.rowCount} 行 × ${view.columnCount} 列` : ""}</span></div>
    {error ? <div className="attachment-state" role="alert"><p>{error}</p><button type="button" onClick={() => setRetry(n => n + 1)}>重新读取表格</button></div>
      : !view ? <p className="attachment-state" role="status">正在读取表格…</p>
        : rows === 0 || cols === 0 ? <p className="attachment-state">这个工作表没有单元格内容。</p>
          : <div className="attachment-grid-scroll" key={sheet} tabIndex={0} aria-label={`${view.sheetNames[view.sheetIndex]}，表格内容`}>
            <table className="attachment-grid"><thead><tr><th aria-label="行号" />{Array.from({ length: cols }, (_, c) => <th key={c} scope="col">{columnLabel(c)}</th>)}</tr></thead>
              <tbody>{Array.from({ length: rows }, (_, r) => <tr key={r}><th scope="row">{r + 1}</th>{Array.from({ length: cols }, (_, c) => <td key={c}>{cells.get(`${r}:${c}`) ?? ""}</td>)}</tr>)}</tbody>
            </table>
          </div>}
    {view?.truncated && <p className="attachment-sheet-note" role="status">仅显示前 500 行、50 列，部分长内容已省略。查看完整内容请用系统程序打开。</p>}
    <p className="attachment-sheet-note">显示已保存的单元格值；完整格式、图表及公式计算请用系统程序打开。</p>
  </div>;
}

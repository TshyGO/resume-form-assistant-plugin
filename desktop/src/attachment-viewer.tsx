import { useEffect, useRef, useState } from "react";
import type { PDFDocumentProxy, RenderTask } from "pdfjs-dist/types/src/display/api";
import type { Invoke } from "./api.ts";
import { useInvoke } from "./react/invoke.tsx";
import { mountReact } from "./react/mount.tsx";
import { SettingsDialog } from "./react/SettingsDialog.tsx";
import { ensureReadableStreamAsyncIterator } from "./resume/readable-stream-iterator.ts";
import "./attachments.css";

import type { MailAttachment, MailAttachments } from "./attachment-types.ts";
interface Preview { bytesBase64: string; mime: string }
const errorText = (err: unknown) => typeof err === "string" ? err : (err as { message?: string })?.message || "读取失败，请重试。";
export const attachmentSize = (n: number) => n < 1024 ? `${n} B` : n < 1048576 ? `${(n / 1024).toFixed(1)} KiB` : `${(n / 1048576).toFixed(1)} MiB`;
const kindName = (a: MailAttachment) => a.previewKind === "pdf" ? "PDF" : a.previewKind === "image" ? "图片" : a.name.includes(".") ? a.name.split(".").pop()!.toUpperCase() : "文件";
function FileIcon({ kind }: { kind: string }) {
  return <span className={`attachment-file-icon is-${kind}`} aria-hidden="true"><svg className="icon" viewBox="0 0 24 24"><path d="M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9zM14 3v6h6M8 14h8M8 17h5" /></svg></span>;
}

function DocumentPreview({ preview, kind, name }: { preview: Preview; kind: string; name: string }) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const surface = useRef<HTMLDivElement>(null);
  const [pdf, setPdf] = useState<PDFDocumentProxy | null>(null);
  const [page, setPage] = useState(1);
  const [zoom, setZoom] = useState<number | null>(null);
  const [error, setError] = useState("");
  const [rendering, setRendering] = useState(kind === "pdf");
  const [fitWidth, setFitWidth] = useState(600);
  const [imageWidth, setImageWidth] = useState(0);
  useEffect(() => {
    const el = surface.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => setFitWidth(el.clientWidth));
    observer.observe(el);
    return () => observer.disconnect();
  }, []);
  useEffect(() => {
    if (kind !== "pdf") return;
    let disposed = false;
    let task: ReturnType<typeof import("pdfjs-dist/legacy/build/pdf.mjs")["getDocument"]> | undefined;
    void (async () => {
      try {
        ensureReadableStreamAsyncIterator();
        const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
        pdfjs.GlobalWorkerOptions.workerSrc = (await import("pdfjs-dist/legacy/build/pdf.worker.min.mjs?url")).default;
        if (disposed) return;
        const bytes = Uint8Array.from(atob(preview.bytesBase64), c => c.charCodeAt(0));
        task = pdfjs.getDocument({ data: bytes, cMapPacked: true, cMapUrl: `${import.meta.env.BASE_URL}pdfjs/cmaps/`,
          disableFontFace: true, useSystemFonts: false, useWasm: false });
        const doc = await task.promise;
        if (disposed) { return; }
        setPdf(doc);
      } catch { if (!disposed) { setError("这份 PDF 暂时无法预览，可以另存为或用系统程序打开。"); setRendering(false); } }
    })();
    return () => { disposed = true; if (task) void task.destroy(); };
  }, [kind, preview]);
  useEffect(() => {
    if (!pdf || !canvas.current) return;
    let disposed = false; let render: RenderTask | undefined;
    setRendering(true); setError("");
    void (async () => {
      try {
        const p = await pdf.getPage(page);
        if (disposed || !canvas.current) return;
        const width = Math.max(260, (surface.current?.clientWidth || fitWidth) - 48);
        const fit = Math.min(2, width / p.getViewport({ scale: 1 }).width);
        const viewport = p.getViewport({ scale: zoom ?? fit });
        const ratio = Math.min(window.devicePixelRatio || 1, 2, Math.sqrt(12_000_000 / (viewport.width * viewport.height)));
        const el = canvas.current;
        el.width = Math.ceil(viewport.width * ratio); el.height = Math.ceil(viewport.height * ratio);
        el.style.width = `${viewport.width}px`; el.style.height = `${viewport.height}px`;
        render = p.render({ canvas: el, viewport, transform: [ratio, 0, 0, ratio, 0, 0], annotationMode: 0 });
        await render.promise;
        if (!disposed) setRendering(false);
      } catch { if (!disposed) { setRendering(false); setError("这一页读不出来，请重试或用系统程序打开。"); } }
    })();
    return () => { disposed = true; render?.cancel(); };
  }, [pdf, page, zoom, fitWidth]);
  return <div className="attachment-document">
    <div className="attachment-tools" aria-label="预览工具栏">
      {kind === "pdf" && <div className="attachment-tool-group"><button type="button" aria-label="上一页" disabled={!pdf || page <= 1} onClick={() => setPage(p => p - 1)}>‹</button><span aria-live="polite">{pdf ? `${page} / ${pdf.numPages} 页` : "正在读取页数"}</span><button type="button" aria-label="下一页" disabled={!pdf || page >= pdf.numPages} onClick={() => setPage(p => p + 1)}>›</button></div>}
      <div className="attachment-tool-group"><button type="button" aria-label="缩小" disabled={zoom !== null && zoom <= .5} onClick={() => setZoom(z => Math.max(.5, (z ?? 1) - .25))}>−</button><span>{zoom === null ? "适合宽度" : `${Math.round(zoom * 100)}%`}</span><button type="button" aria-label="放大" disabled={zoom !== null && zoom >= 2} onClick={() => setZoom(z => Math.min(2, (z ?? 1) + .25))}>＋</button><button type="button" onClick={() => setZoom(null)}>适合宽度</button></div>
    </div>
    <div className="attachment-canvas-wrap" ref={surface}>
      {error ? <p className="attachment-state" role="alert">{error}</p> : <>
        {kind === "pdf" ? <><canvas ref={canvas} aria-label={`${name}，第 ${page} 页`} />{rendering && <p className="attachment-rendering" role="status">正在显示页面…</p>}</>
          : <img alt={name} src={`data:${preview.mime};base64,${preview.bytesBase64}`} style={zoom === null ? { maxWidth: "100%" } : { maxWidth: "none", width: imageWidth ? `${zoom * imageWidth}px` : `${zoom * 100}%` }} onLoad={event => setImageWidth(event.currentTarget.naturalWidth)} onError={() => setError("这张图片读不出来，可以另存为或用系统程序打开。")} />}
      </>}
    </div>
  </div>;
}

export function AttachmentViewer({ evidenceId, title, attachments, initialIndex, onClose }: {
  evidenceId: string; title: string; attachments: MailAttachments; initialIndex: number; onClose(): void;
}) {
  const invoke = useInvoke();
  const [index, setIndex] = useState(initialIndex);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState("");
  const [notice, setNotice] = useState("");
  const [retry, setRetry] = useState(0);
  const item = attachments.items.find(a => a.index === index) ?? attachments.items[0];
  useEffect(() => {
    let active = true; setPreview(null); setError(""); setNotice("");
    if (!item || item.previewKind === "file" || !item.readable) return;
    if (!invoke) { setError("请在桌面程序里查看附件。"); return; }
    void invoke<Preview>("preview_evidence_attachment_cmd", { evidenceId, index: item.index, sourceSha256: attachments.sourceSha256 })
      .then(data => { if (active) setPreview(data); }, err => { if (active) setError(errorText(err)); });
    return () => { active = false; };
  }, [invoke, evidenceId, item, attachments.sourceSha256, retry]);
  if (!item) return null;
  const action = async (kind: "open" | "save") => {
    if (busy || !invoke) return;
    setBusy(kind); setNotice("");
    try {
      const result = await invoke(kind === "open" ? "open_evidence_attachment_cmd" : "save_evidence_attachment_cmd", {
        evidenceId, index: item.index, sourceSha256: attachments.sourceSha256,
      });
      setNotice(kind === "open" ? "已交给系统默认程序打开。" : result ? "附件已另存为。" : "已取消另存为。");
    } catch (err) { setNotice(errorText(err)); }
    finally { setBusy(""); }
  };
  return <SettingsDialog open title="查看邮件附件" intro={title} onCancel={onClose} cancelDisabled={Boolean(busy)} size="lg" className="attachment-dialog"
    footer={<><span className="attachment-footer-note">附件来自本机已保存的邮件</span><button type="button" onClick={onClose} disabled={Boolean(busy)}>关闭</button></>}>
    <div className="attachment-viewer-layout">
      <nav className="attachment-sidebar" aria-label="邮件附件"><p className="attachment-sidebar-title">附件 <span>{attachments.items.length}</span></p>
        {attachments.items.map(a => <button type="button" key={a.index} className={a.index === item.index ? "is-selected" : ""} aria-current={a.index === item.index ? "true" : undefined} disabled={Boolean(busy)} onClick={() => { setPreview(null); setError(""); setIndex(a.index); }}>
          <FileIcon kind={a.previewKind} /><span><strong>{a.name}</strong><small>{kindName(a)} · {attachmentSize(a.sizeBytes)}</small></span>
        </button>)}
      </nav>
      <section className="attachment-main" aria-label="附件内容">
        <header className="attachment-active-head"><div><h3>{item.name}</h3><p>{kindName(item)} · {attachmentSize(item.sizeBytes)}</p></div><div className="attachment-file-actions">
          <button type="button" onClick={() => void action("save")} disabled={Boolean(busy) || !invoke || !item.readable}>{busy === "save" ? "正在保存…" : "另存为"}</button>
          <button type="button" className="primary" onClick={() => void action("open")} disabled={Boolean(busy) || !invoke || !item.readable || !item.canOpen}>{busy === "open" ? "正在打开…" : "用系统程序打开"}</button>
        </div></header>
        {notice && <p className="attachment-notice" role="status">{notice}</p>}
        {!item.readable ? <div className="attachment-state" role="alert"><FileIcon kind="file" /><p>这份附件的编码已损坏，暂时无法读取。</p></div>
          : item.previewKind === "file" ? <div className="attachment-state"><FileIcon kind="file" /><h3>{item.name}</h3><p>{item.canOpen ? "这种文件可另存为，或用电脑上的对应软件打开。" : "这种文件请先另存为后处理。"}</p></div>
            : error ? <div className="attachment-state" role="alert"><p>{error}</p><button type="button" onClick={() => setRetry(n => n + 1)}>重新读取</button></div>
              : preview ? <DocumentPreview key={`${item.index}-${retry}`} preview={preview} kind={item.previewKind} name={item.name} />
                : <p className="attachment-state" role="status">正在读取附件…</p>}
      </section>
    </div>
  </SettingsDialog>;
}

let currentClose: (() => void) | null = null;
export function openAttachmentViewer(invoke: Invoke, evidenceId: string, title: string, attachments: MailAttachments, index: number) {
  currentClose?.();
  const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  const host = document.createElement("div"); document.body.append(host);
  const close = () => { currentClose = null; mounted.unmount(); host.remove(); if (previous?.isConnected) previous.focus(); };
  const mounted = mountReact(host, invoke, <AttachmentViewer evidenceId={evidenceId} title={title} attachments={attachments} initialIndex={index} onClose={close} />);
  currentClose = close;
}

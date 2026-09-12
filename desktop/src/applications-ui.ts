import type {
  ApplicationSummary,
  ApplicationView,
  CreateApplicationResult,
  EvidencePreview,
  Invoke,
  Page,
  SnapshotView,
  StoredEvent,
} from "./api.ts";
import { dialog as dialogEl, input, maybe, must, select as selectEl, valueOf } from "./dom.ts";
import {
  createApplicationsController,
  evidenceLabel,
  evidenceLine,
  evidenceNote,
  eventLabel,
  fillSummary,
  stageLabel,
  occurredLabel,
  snapshotStateLabel,
  SNAPSHOT_DISCLAIMER,
} from "./applications.ts";

function escapeHtml(value: unknown) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function formatTime(value: string | null | undefined) {
  if (!value) return "—";
  return String(value).replace("T", " ").replace("Z", " UTC");
}

function invokeError(err: unknown) {
  const detail = err as { code?: string; message?: string } | null;
  if (detail && typeof detail === "object" && detail.message) {
    return `${detail.code || "ERROR"}: ${detail.message}`;
  }
  return String(err);
}

export function mountApplications(invoke: Invoke) {
  const ctl = createApplicationsController();
  const msg = must("apps-msg");
  const empty = must("apps-empty");
  const layout = must("apps-layout");
  const tbody = must("apps-tbody");
  const detail = must("app-detail");
  const dialog = dialogEl("app-form-dialog");
  const form = must<HTMLFormElement>("app-form");
  const formMsg = must("app-form-msg");
  const pageEl = must("apps-page");
  const progressDialog = dialogEl("progress-dialog");
  const progressForm = must<HTMLFormElement>("progress-form");
  let progressContext: { act: string; id: string } | null = null;
  let progressSaving = false;
  let actionBusy = false;
  let detailToken = 0;
  const progressKinds: Record<string, string> = { interview: "面试", assessment: "测评", offer: "Offer", rejected: "未通过", withdrawn: "撤回", closed: "结束申请" };

  function setFormBusy(busy: boolean) {
    form
      .querySelectorAll<HTMLInputElement | HTMLTextAreaElement | HTMLButtonElement>("input,textarea,button")
      .forEach((field) => { field.disabled = busy; });
  }
  function cancelForm(event?: Event) {
    event?.preventDefault();
    if (ctl.saving) return;
    if (ctl.formDirty && !window.confirm("有未保存的修改，确定关闭？")) return;
    dialog.close();
    ctl.clearFormDirty();
  }
  function cancelProgress(event?: Event) {
    event?.preventDefault();
    if (progressSaving) return;
    progressContext = null;
    progressDialog.close();
  }
  must("progress-cancel").addEventListener("click", cancelProgress);
  progressDialog.addEventListener("cancel", cancelProgress);
  dialog.addEventListener("cancel", cancelForm);

  progressForm.addEventListener("submit", async event => {
    event.preventDefault();
    if (!progressContext || progressSaving) return;
    const { act, id } = progressContext;
    const description = input("progress-description").value.trim();
    const date = input("progress-date").value;
    const round = input("progress-round").value;
    const args = { id, updateProgress: input("progress-update").checked,
      occurred: date ? { precision: "date", value: { date, time_zone: null } } : { precision: "unknown" },
      label: description || progressKinds[act], name: description || progressKinds[act], note: description || null, reason: description || null,
      round: act === "interview" && round ? Number(round) : null };
    progressSaving = true;
    progressForm.querySelectorAll<HTMLInputElement | HTMLButtonElement>("input,button").forEach((field) => { field.disabled = true; });
    const status = must("progress-msg");
    status.textContent = "保存中…";
    try {
      await invoke(`record_${act}_cmd`, { args });
      progressDialog.close();
      progressContext = null;
      await refreshList();
      if (ctl.selectedId === id) await loadDetail(id);
      msg.textContent = "已保存记录。";
    } catch (error) { status.textContent = invokeError(error); }
    finally { progressSaving = false; progressForm.querySelectorAll<HTMLInputElement | HTMLButtonElement>("input,button").forEach((field) => { field.disabled = false; }); }
  });

  function filterArgs() {
    return {
      query: input("app-search").value.trim() || null,
      stage: selectEl("app-stage").value,
      recycle: selectEl("app-recycle").value,
      sort: selectEl("app-sort").value,
      desc: true,
      limit: ctl.limit,
      offset: ctl.offset,
    };
  }

  function openForm(title: string, values: Partial<ApplicationSummary>) {
    if (ctl.saving || actionBusy || progressSaving) return;
    must("app-form-title").textContent = title;
    input("f-company").value = values.company || "";
    input("f-title").value = values.title || "";
    input("f-url").value = values.sourceUrl || values.source_url || "";
    input("f-location").value = values.location || "";
    input("f-notes").value = values.notes || "";
    formMsg.textContent = "";
    ctl.clearFormDirty();
    dialog.showModal();
    input("f-company").focus();
  }

  async function refreshList() {
    if (!invoke) {
      msg.textContent = "未连接到桌面宿主，请用 Tauri 启动。";
      return;
    }
    const token = ctl.beginList();
    const args = filterArgs();
    ctl.setFilter(args);
    try {
      const page = await invoke<Page<ApplicationSummary>>("list_applications_cmd", { args });
      if (!ctl.isCurrent(token)) return;
      const lastOffset = page.total ? Math.floor((page.total - 1) / ctl.limit) * ctl.limit : 0;
      if (ctl.offset > lastOffset) { ctl.setOffset(lastOffset); return refreshList(); }
      msg.textContent = page.total ? `共 ${page.total} 条` : "";
      const showEmpty = page.total === 0 && !args.query && args.stage === "all" && args.recycle === "active";
      empty.classList.toggle("hidden", !showEmpty);
      layout.classList.toggle("hidden", showEmpty);
      tbody.innerHTML = page.items
        .map((row) => {
          const active = row.id === ctl.selectedId ? " class=\"active\"" : "";
          return `<tr data-id="${escapeHtml(row.id)}"${active}>
            <td title="${escapeHtml(row.company)}">${escapeHtml(row.company)}</td>
            <td title="${escapeHtml(row.title)}">${escapeHtml(row.title)}</td>
            <td>${escapeHtml(row.location || "—")}</td>
            <td>${escapeHtml(stageLabel(row.currentStage || row.current_stage))}</td>
            <td>${escapeHtml(formatTime(row.updatedAt || row.updated_at))}</td>
          </tr>`;
        })
        .join("");
      const maxOffset = lastOffset;
      pageEl.textContent = `${Math.floor(ctl.offset / ctl.limit) + 1} / ${Math.max(1, Math.ceil(page.total / ctl.limit))}`;
      input("btn-prev-page").disabled = ctl.offset <= 0;
      input("btn-next-page").disabled = ctl.offset >= maxOffset || page.total === 0;
      if (ctl.selectedId && !page.items.some((row) => row.id === ctl.selectedId)) {
        detailToken += 1;
        ctl.setSelected(null);
        detail.innerHTML = `<p class="muted">当前申请不在此列表过滤中。</p>`;
      }
    } catch (err) {
      if (!ctl.isCurrent(token)) return;
      msg.textContent = invokeError(err);
    }
  }

  async function loadDetail(id: string) {
    const token = ++detailToken;
    ctl.setSelected(id);
    detail.innerHTML = '<p class="muted">加载中…</p>';
    tbody.querySelectorAll("tr").forEach((tr) => {
      tr.classList.toggle("active", tr.dataset.id === id);
    });
    try {
      const view = await invoke<ApplicationView>("get_application_cmd", { id });
      if (token !== detailToken || ctl.selectedId !== id) return;
      const app = view.application.summary || view.application;
      const notes = view.application.notes;
      const events = view.events || [];
      const snapshotStates = view.snapshotStates || {};
      const snapshots = view.snapshots || [];
      const evidence = view.evidence || [];
      detail.innerHTML = `
        <div class="detail-head">
          <h2 title="${escapeHtml(app.company)} · ${escapeHtml(app.title)}">${escapeHtml(app.company)} · ${escapeHtml(app.title)}</h2>
          <p class="muted">${escapeHtml(stageLabel(app.currentStage || app.current_stage))} · ${escapeHtml(evidenceLabel(app.replyEvidenceState || app.reply_evidence_state))}</p>
        </div>
        <dl class="facts compact">
          <dt>地点</dt><dd>${escapeHtml(app.location || "—")}</dd>
          <dt>链接</dt><dd class="break">${escapeHtml(app.sourceUrl || app.source_url || "—")}</dd>
          <dt>备注</dt><dd class="break">${escapeHtml(notes || "—")}</dd>
          <dt>更新</dt><dd>${escapeHtml(formatTime(app.updatedAt || app.updated_at))}</dd>
        </dl>
        <div class="row wrap">
          <button type="button" data-act="edit">编辑资料</button>
          <button type="button" data-act="submit">确认已投递</button>
          <button type="button" data-act="interview">记录面试</button>
          <button type="button" data-act="assessment">记录测评</button>
          <button type="button" data-act="offer">记录 Offer</button>
          <button type="button" data-act="rejected">记录未通过</button>
          <button type="button" data-act="withdrawn">记录撤回</button>
          <button type="button" data-act="closed">结束申请</button>
          <button type="button" data-act="correct">纠正阶段</button>
          <button type="button" data-act="note">新增备注</button>
          <button type="button" data-act="recycle">${(app.recycleState || app.recycle_state) === "recycled" ? "恢复" : "回收"}</button>
        </div>
        <p class="muted">待办尚未接入，这里不展示假数据。填写事件不等于投递成功。</p>
        <h3>回复证据（${evidence.length}）</h3>
        ${evidenceNote(app.replyEvidenceState || app.reply_evidence_state)
          ? `<p class="muted">${escapeHtml(evidenceNote(app.replyEvidenceState || app.reply_evidence_state))}</p>`
          : ""}
        ${evidence.length ? `
        <ul class="snapshot-list">
          ${evidence.map((item) => `<li>
            <span>${escapeHtml(item.subject || item.originalFilename || "导入的证据")} — ${escapeHtml(evidenceLine(item))}</span>
            <button type="button" data-act="evidence" data-evidence="${escapeHtml(item.id)}">查看</button>
            <button type="button" data-act="unassociate" data-evidence="${escapeHtml(item.id)}">取消关联</button>
          </li>`).join("")}
        </ul>` : `<p class="muted">收件箱里导入的证据关联到这条申请之后会出现在这里。</p>`}
        ${snapshots.length ? `
        <h3>简历快照（${snapshots.length}）</h3>
        <ul class="snapshot-list">
          ${snapshots.map((snap) => `<li>
            <span>${escapeHtml(snap.template_name)} · ${escapeHtml(formatTime(snap.created_at))}</span>
            <button type="button" data-act="snapshot" data-snapshot="${escapeHtml(snap.snapshot_id)}">查看</button>
          </li>`).join("")}
        </ul>` : ""}
        <h3>时间线</h3>
        <ol class="timeline">
          ${events
            .map((ev) => {
              const payload = ev.payload || {};
              const extra = payload.text || payload.note || payload.reason || payload.label || payload.name || "";
              const mode = payload.stage_update_mode || payload.stageUpdateMode;
              const modeText = mode === "update_progress" ? "更新当前进度" : mode === "history_only" ? "仅历史补录" : "";
              const fill = fillSummary(payload);
              const snapshotId = payload.snapshot_id;
              const snapshotNote = typeof snapshotId === "string" ? snapshotStateLabel(snapshotStates[snapshotId]) : null;
              return `<li>
                <strong>#${escapeHtml(ev.event_sequence)} ${escapeHtml(eventLabel(ev.event_type))}</strong>
                <span class="muted">发生：${escapeHtml(occurredLabel(ev.occurred))} · 记录于：${escapeHtml(formatTime(ev.recorded_at))}</span>
                ${payload.round ? `<div>第 ${escapeHtml(payload.round)} 轮面试</div>` : ""}
                ${extra ? `<div class="break">${escapeHtml(extra)}</div>` : ""}
                ${fill ? `<div>${escapeHtml(fill)}</div>` : ""}
                ${snapshotId && !snapshotNote ? `<div><button type="button" data-act="snapshot" data-snapshot="${escapeHtml(snapshotId)}">查看简历快照</button></div>` : ""}
                ${snapshotNote ? `<div class="muted">${escapeHtml(snapshotNote)}</div>` : ""}
                ${modeText && !fill ? `<div class="muted">${escapeHtml(modeText)}</div>` : ""}
              </li>`;
            })
            .join("")}
        </ol>
      `;
      detail.querySelectorAll<HTMLElement>("button[data-act]").forEach((btn) => {
        btn.addEventListener("click", () => {
          const act = btn.dataset.act ?? "";
          const evidenceId = btn.dataset.evidence;
          const snapshotId = btn.dataset.snapshot;
          if (act === "snapshot" && snapshotId) return void openSnapshot(snapshotId);
          if (act === "evidence" && evidenceId) return void openEvidence(evidenceId);
          if (act === "unassociate" && evidenceId) return void unassociateEvidence(evidenceId, id);
          return void handleAction(act, view);
        });
      });
    } catch (err) {
      if (token !== detailToken || ctl.selectedId !== id) return;
      detail.innerHTML = `<p class="banner">${escapeHtml(invokeError(err))}</p>`;
    }
  }

  // Read-only. The disclaimer is always shown first, and a snapshot that fails its digest
  // check is reported as unreadable rather than shown in part.
  let snapshotToken = 0;
  async function openSnapshot(snapshotId: string) {
    // Only the snapshot opened last may fill the dialog; an earlier one answering late is dropped.
    const token = ++snapshotToken;
    const snapshotDialog = dialogEl("snapshot-dialog");
    const body = must("snapshot-body");
    body.innerHTML = `<p class="banner">${escapeHtml(SNAPSHOT_DISCLAIMER)}</p><p class="muted">加载中…</p>`;
    if (!snapshotDialog.open) snapshotDialog.showModal();
    try {
      const snap = await invoke<SnapshotView>("get_snapshot_cmd", { snapshotId });
      if (token !== snapshotToken) return;
      const omitted = snap.omittedFieldCount
        ? `<p class="muted">${escapeHtml(snap.omittedFieldCount)} 个疑似密码、验证码类的字段没有保存。</p>`
        : "";
      body.innerHTML = `
        <p class="banner">${escapeHtml(SNAPSHOT_DISCLAIMER)}</p>
        <p class="muted">模板：${escapeHtml(snap.templateName)}${snap.templateVersion ? `（${escapeHtml(snap.templateVersion)}）` : ""} · 拷贝于 ${escapeHtml(formatTime(snap.capturedAt || snap.createdAt))}</p>
        ${omitted}
        ${(snap.groups || []).map((group) => `
          <h4>${escapeHtml(group.name)}</h4>
          <dl class="facts compact">
            ${(group.fields || []).map((field) => `<dt>${escapeHtml(field.key)}</dt><dd class="break">${escapeHtml(field.value)}</dd>`).join("")}
          </dl>`).join("")}
      `;
    } catch (err) {
      if (token !== snapshotToken) return;
      body.innerHTML = `<p class="banner">${escapeHtml(SNAPSHOT_DISCLAIMER)}</p><p class="banner">无法读取这份快照（${escapeHtml(invokeError(err))}）。桌面不会展示部分内容。</p>`;
    }
  }

  maybe("snapshot-close")?.addEventListener("click", () => {
    dialogEl("snapshot-dialog").close();
  });

  // 只读预览，和收件箱看到的是同一份已经清洗过的数据（正文转义、图片 data: URL、
  // PDF 不内嵌）。这里不做分类，分类在收件箱里做。
  let evidenceToken = 0;
  async function openEvidence(evidenceId: string) {
    const token = ++evidenceToken;
    const evidenceDialog = dialogEl("evidence-dialog");
    const body = must("evidence-body");
    body.innerHTML = '<p class="muted">加载中…</p>';
    if (!evidenceDialog.open) evidenceDialog.showModal();
    try {
      const item = await invoke<EvidencePreview>("get_evidence_preview_cmd", { evidenceId });
      if (token !== evidenceToken) return;
      body.innerHTML = `
        <p class="muted">${escapeHtml(evidenceLine(item))}</p>
        ${item.note ? `<p class="banner">${escapeHtml(item.note)}</p>` : ""}
        ${item.imageDataUrl ? `<img class="evidence-image" alt="导入的截图" src="${escapeHtml(item.imageDataUrl)}">` : ""}
        ${item.bodyExtract ? `<pre class="evidence-body">${escapeHtml(item.bodyExtract)}</pre>` : ""}
      `;
    } catch (err) {
      if (token !== evidenceToken) return;
      body.innerHTML = `<p class="banner">${escapeHtml(`读不出这条证据（${invokeError(err)}）。`)}</p>`;
    }
  }

  maybe("evidence-close")?.addEventListener("click", () => {
    dialogEl("evidence-dialog").close();
  });

  async function unassociateEvidence(evidenceId: string, applicationId: string) {
    try {
      await invoke("unassociate_evidence_cmd", { evidenceId });
      msg.textContent = "已取出到收件箱。这条申请的证据状态按剩下的证据重算。";
      if (ctl.selectedId === applicationId) await loadDetail(applicationId);
    } catch (err) {
      msg.textContent = invokeError(err);
    }
  }

  async function handleAction(act: string, view: ApplicationView) {
    const app = view.application.summary || view.application;
    const id = app.id;
    if (ctl.selectedId !== id || ctl.saving || actionBusy || progressSaving) return;
    if (progressKinds[act]) {
      progressContext = { act, id };
      must("progress-title").textContent = `记录${progressKinds[act]} · ${app.company} / ${app.title}`;
      input("progress-description").value = "";
      input("progress-date").value = "";
      input("progress-round").value = "";
      must("progress-round-label").hidden = act !== "interview";
      input("progress-update").checked = false;
      must("progress-msg").textContent = "取消或 Escape 不会保存任何记录。";
      progressDialog.showModal();
      return;
    }
    actionBusy = true;
    try {
      if (act === "edit") {
        actionBusy = false;
        ctl.setEditing(id);
        openForm("编辑申请", {
          company: app.company,
          title: app.title,
          sourceUrl: app.sourceUrl || app.source_url,
          location: app.location,
          notes: view.application.notes,
        });
        return;
      }
      if (act === "submit") {
        if (!window.confirm("确认这条申请已经投递？填写完成不会自动变成已投递。")) return;
        await invoke("confirm_submit_cmd", { args: { id } });
      } else if (act === "correct") {
        const to = window.prompt("纠正到哪个阶段？(saved/filling/submitted/assessment/interview/offer/rejected/withdrawn/closed)", app.currentStage || app.current_stage);
        if (!to) return;
        const reason = window.prompt("纠正原因（必填）", "");
        if (!reason || !reason.trim()) {
          msg.textContent = "纠正阶段必须填写原因。";
          return;
        }
        await invoke("correct_stage_cmd", {
          args: { id, from: app.currentStage || app.current_stage, to: to.trim(), reason: reason.trim() },
        });
      } else if (act === "note") {
        const text = window.prompt("备注", "");
        if (!text || !text.trim()) return;
        await invoke("add_note_cmd", { args: { id, text } });
      } else if (act === "recycle") {
        const recycled = (app.recycleState || app.recycle_state) !== "recycled";
        const ok = window.confirm(
          recycled
            ? "回收后申请离开进行中列表，历史事件仍保留，可以恢复。本次不提供永久删除。"
            : "恢复后申请重新出现在进行中列表，历史事件仍可查看。",
        );
        if (!ok) return;
        await invoke("set_recycle_cmd", { id, recycled });
      }
      await refreshList();
      if (ctl.selectedId === id) await loadDetail(id);
      msg.textContent = "已保存。";
    } catch (err) {
      msg.textContent = invokeError(err);
    } finally { actionBusy = false; }
  }

  form.addEventListener("input", () => ctl.markFormDirty());
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    if (ctl.saving) return;
    const payload = {
      company: input("f-company").value,
      title: input("f-title").value,
      sourceUrl: input("f-url").value || null,
      location: input("f-location").value || null,
      notes: input("f-notes").value || null,
    };
    ctl.setSaving(true);
    setFormBusy(true);
    const editingId = ctl.editingId;
    input("btn-save-app").disabled = true;
    formMsg.textContent = "保存中…";
    try {
      if (editingId) {
        await invoke("update_application_cmd", {
          args: {
            id: editingId,
            company: payload.company,
            title: payload.title,
            sourceUrl: payload.sourceUrl ?? "",
            location: payload.location ?? "",
            notes: payload.notes ?? "",
          },
        });
        formMsg.textContent = "已保存。";
        ctl.clearFormDirty();
        dialog.close();
        await refreshList();
        if (ctl.selectedId === editingId) await loadDetail(editingId);
      } else {
        const result = await invoke<CreateApplicationResult>("create_application_cmd", {
          args: { ...payload, confirmDuplicate: false },
        });
        if (!result.created && result.candidates) {
          const names = [...(result.candidates.exact || []), ...(result.candidates.sameCompany || result.candidates.same_company || [])]
            .map((c) => `${c.company} / ${c.title}`)
            .join("；");
          const ok = window.confirm(`可能已有相似申请：${names || "同公司记录"}。确定仍要新建吗？系统不会自动合并。`);
          if (!ok) {
            formMsg.textContent = "已取消。输入仍保留。";
            input("f-company").value = payload.company;
            input("f-title").value = payload.title;
            input("f-url").value = payload.sourceUrl || "";
            input("f-location").value = payload.location || "";
            input("f-notes").value = payload.notes || "";
            return;
          }
          const forced = await invoke<CreateApplicationResult>("create_application_cmd", {
            args: { ...payload, confirmDuplicate: true },
          });
          dialog.close();
          ctl.clearFormDirty();
          await refreshList();
          if (forced.application) await loadDetail(forced.application.id);
        } else {
          dialog.close();
          ctl.clearFormDirty();
          await refreshList();
          if (result.application) await loadDetail(result.application.id);
        }
      }
    } catch (err) {
      formMsg.textContent = invokeError(err);
      input("f-company").value = payload.company;
      input("f-title").value = payload.title;
      input("f-url").value = payload.sourceUrl || "";
      input("f-location").value = payload.location || "";
      input("f-notes").value = payload.notes || "";
    } finally {
      ctl.setSaving(false);
      setFormBusy(false);
      input("btn-save-app").disabled = false;
    }
  });

  must("btn-cancel-app").addEventListener("click", cancelForm);
  must("btn-new-app").addEventListener("click", () => {
    if (ctl.saving) return;
    ctl.setEditing(null);
    openForm("新增申请", {});
  });
  must("btn-empty-new").addEventListener("click", () => {
    if (ctl.saving) return;
    ctl.setEditing(null);
    openForm("新增申请", {});
  });
  tbody.addEventListener("click", (event) => {
    const tr = (event.target as HTMLElement | null)?.closest<HTMLElement>("tr[data-id]");
    const id = tr?.dataset.id;
    if (id) void loadDetail(id);
  });
  must("btn-prev-page").addEventListener("click", async () => {
    ctl.setOffset(Math.max(0, ctl.offset - ctl.limit));
    await refreshList();
  });
  must("btn-next-page").addEventListener("click", async () => {
    ctl.setOffset(ctl.offset + ctl.limit);
    await refreshList();
  });
  ["app-search", "app-stage", "app-recycle", "app-sort"].forEach((id) => {
    must(id).addEventListener("change", async () => {
      ctl.setOffset(0);
      await refreshList();
    });
  });
  must("app-search").addEventListener("keydown", async (event: KeyboardEvent) => {
    if (event.key === "Enter") {
      event.preventDefault();
      ctl.setOffset(0);
      await refreshList();
    }
  });
  document.addEventListener("keydown", (event) => {
    if (event.key === "n" && event.target === document.body && !ctl.saving && !progressDialog.open) {
      ctl.setEditing(null);
      openForm("新增申请", {});
    }
  });

  return { refreshList, ctl };
}

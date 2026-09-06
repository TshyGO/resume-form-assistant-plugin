import {
  createApplicationsController,
  evidenceLabel,
  eventLabel,
  stageLabel,
  occurredLabel,
} from "./applications.js";

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function formatTime(value) {
  if (!value) return "—";
  return String(value).replace("T", " ").replace("Z", " UTC");
}

function invokeError(err) {
  if (err && typeof err === "object" && err.message) {
    return `${err.code || "ERROR"}: ${err.message}`;
  }
  return String(err);
}

export function mountApplications(invoke) {
  const ctl = createApplicationsController();
  const msg = document.getElementById("apps-msg");
  const empty = document.getElementById("apps-empty");
  const layout = document.getElementById("apps-layout");
  const tbody = document.getElementById("apps-tbody");
  const detail = document.getElementById("app-detail");
  const dialog = document.getElementById("app-form-dialog");
  const form = document.getElementById("app-form");
  const formMsg = document.getElementById("app-form-msg");
  const pageEl = document.getElementById("apps-page");
  const progressDialog = document.getElementById("progress-dialog");
  const progressForm = document.getElementById("progress-form");
  let progressContext = null;
  let progressSaving = false;
  let actionBusy = false;
  let detailToken = 0;
  const progressKinds = { interview: "面试", assessment: "测评", offer: "Offer", rejected: "未通过", withdrawn: "撤回", closed: "结束申请" };

  function setFormBusy(busy) {
    form.querySelectorAll("input,textarea,button").forEach(el => { el.disabled = busy; });
  }
  function cancelForm(event) {
    event?.preventDefault();
    if (ctl.saving) return;
    if (ctl.formDirty && !window.confirm("有未保存的修改，确定关闭？")) return;
    dialog.close();
    ctl.clearFormDirty();
  }
  function cancelProgress(event) {
    event?.preventDefault();
    if (progressSaving) return;
    progressContext = null;
    progressDialog.close();
  }
  document.getElementById("progress-cancel").addEventListener("click", cancelProgress);
  progressDialog.addEventListener("cancel", cancelProgress);
  dialog.addEventListener("cancel", cancelForm);

  progressForm.addEventListener("submit", async event => {
    event.preventDefault();
    if (!progressContext || progressSaving) return;
    const { act, id } = progressContext;
    const description = document.getElementById("progress-description").value.trim();
    const date = document.getElementById("progress-date").value;
    const round = document.getElementById("progress-round").value;
    const args = { id, updateProgress: document.getElementById("progress-update").checked,
      occurred: date ? { precision: "date", value: { date, time_zone: null } } : { precision: "unknown" },
      label: description || progressKinds[act], name: description || progressKinds[act], note: description || null, reason: description || null,
      round: act === "interview" && round ? Number(round) : null };
    progressSaving = true;
    progressForm.querySelectorAll("input,button").forEach(el => { el.disabled = true; });
    const status = document.getElementById("progress-msg");
    status.textContent = "保存中…";
    try {
      await invoke(`record_${act}_cmd`, { args });
      progressDialog.close();
      progressContext = null;
      await refreshList();
      if (ctl.selectedId === id) await loadDetail(id);
      msg.textContent = "已保存记录。";
    } catch (error) { status.textContent = invokeError(error); }
    finally { progressSaving = false; progressForm.querySelectorAll("input,button").forEach(el => { el.disabled = false; }); }
  });

  function filterArgs() {
    return {
      query: document.getElementById("app-search").value.trim() || null,
      stage: document.getElementById("app-stage").value,
      recycle: document.getElementById("app-recycle").value,
      sort: document.getElementById("app-sort").value,
      desc: true,
      limit: ctl.limit,
      offset: ctl.offset,
    };
  }

  function openForm(title, values) {
    if (ctl.saving || actionBusy || progressSaving) return;
    document.getElementById("app-form-title").textContent = title;
    document.getElementById("f-company").value = values.company || "";
    document.getElementById("f-title").value = values.title || "";
    document.getElementById("f-url").value = values.sourceUrl || values.source_url || "";
    document.getElementById("f-location").value = values.location || "";
    document.getElementById("f-notes").value = values.notes || "";
    formMsg.textContent = "";
    ctl.clearFormDirty();
    dialog.showModal();
    document.getElementById("f-company").focus();
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
      const page = await invoke("list_applications_cmd", { args });
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
      document.getElementById("btn-prev-page").disabled = ctl.offset <= 0;
      document.getElementById("btn-next-page").disabled = ctl.offset >= maxOffset || page.total === 0;
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

  async function loadDetail(id) {
    const token = ++detailToken;
    ctl.setSelected(id);
    detail.innerHTML = '<p class="muted">加载中…</p>';
    tbody.querySelectorAll("tr").forEach((tr) => {
      tr.classList.toggle("active", tr.dataset.id === id);
    });
    try {
      const view = await invoke("get_application_cmd", { id });
      if (token !== detailToken || ctl.selectedId !== id) return;
      const app = view.application.summary || view.application;
      const notes = view.application.notes;
      const events = view.events || [];
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
        <p class="muted">附件、简历快照和待办尚未接入，这里不展示假数据。填写事件不等于投递成功。</p>
        <h3>时间线</h3>
        <ol class="timeline">
          ${events
            .map((ev) => {
              const payload = ev.payload || {};
              const extra = payload.text || payload.note || payload.reason || payload.label || payload.name || "";
              const mode = payload.stage_update_mode || payload.stageUpdateMode;
              const modeText = mode === "update_progress" ? "更新当前进度" : mode === "history_only" ? "仅历史补录" : "";
              return `<li>
                <strong>#${escapeHtml(ev.eventSequence || ev.event_sequence)} ${escapeHtml(eventLabel(ev.eventType || ev.event_type))}</strong>
                <span class="muted">发生：${escapeHtml(occurredLabel(ev.occurred))} · 记录于：${escapeHtml(formatTime(ev.recordedAt || ev.recorded_at))}</span>
                ${payload.round ? `<div>第 ${escapeHtml(payload.round)} 轮面试</div>` : ""}
                ${extra ? `<div class="break">${escapeHtml(extra)}</div>` : ""}
                ${modeText ? `<div class="muted">${escapeHtml(modeText)}</div>` : ""}
              </li>`;
            })
            .join("")}
        </ol>
      `;
      detail.querySelectorAll("button[data-act]").forEach((btn) => {
        btn.addEventListener("click", () => handleAction(btn.dataset.act, view));
      });
    } catch (err) {
      if (token !== detailToken || ctl.selectedId !== id) return;
      detail.innerHTML = `<p class="banner">${escapeHtml(invokeError(err))}</p>`;
    }
  }

  async function handleAction(act, view) {
    const app = view.application.summary || view.application;
    const id = app.id;
    if (ctl.selectedId !== id || ctl.saving || actionBusy || progressSaving) return;
    if (progressKinds[act]) {
      progressContext = { act, id };
      document.getElementById("progress-title").textContent = `记录${progressKinds[act]} · ${app.company} / ${app.title}`;
      document.getElementById("progress-description").value = "";
      document.getElementById("progress-date").value = "";
      document.getElementById("progress-round").value = "";
      document.getElementById("progress-round-label").hidden = act !== "interview";
      document.getElementById("progress-update").checked = false;
      document.getElementById("progress-msg").textContent = "取消或 Escape 不会保存任何记录。";
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
      company: document.getElementById("f-company").value,
      title: document.getElementById("f-title").value,
      sourceUrl: document.getElementById("f-url").value || null,
      location: document.getElementById("f-location").value || null,
      notes: document.getElementById("f-notes").value || null,
    };
    ctl.setSaving(true);
    setFormBusy(true);
    const editingId = ctl.editingId;
    document.getElementById("btn-save-app").disabled = true;
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
        const result = await invoke("create_application_cmd", {
          args: { ...payload, confirmDuplicate: false },
        });
        if (!result.created && result.candidates) {
          const names = [...(result.candidates.exact || []), ...(result.candidates.sameCompany || result.candidates.same_company || [])]
            .map((c) => `${c.company} / ${c.title}`)
            .join("；");
          const ok = window.confirm(`可能已有相似申请：${names || "同公司记录"}。确定仍要新建吗？系统不会自动合并。`);
          if (!ok) {
            formMsg.textContent = "已取消。输入仍保留。";
            document.getElementById("f-company").value = payload.company;
            document.getElementById("f-title").value = payload.title;
            document.getElementById("f-url").value = payload.sourceUrl || "";
            document.getElementById("f-location").value = payload.location || "";
            document.getElementById("f-notes").value = payload.notes || "";
            return;
          }
          const forced = await invoke("create_application_cmd", {
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
      document.getElementById("f-company").value = payload.company;
      document.getElementById("f-title").value = payload.title;
      document.getElementById("f-url").value = payload.sourceUrl || "";
      document.getElementById("f-location").value = payload.location || "";
      document.getElementById("f-notes").value = payload.notes || "";
    } finally {
      ctl.setSaving(false);
      setFormBusy(false);
      document.getElementById("btn-save-app").disabled = false;
    }
  });

  document.getElementById("btn-cancel-app").addEventListener("click", cancelForm);
  document.getElementById("btn-new-app").addEventListener("click", () => {
    if (ctl.saving) return;
    ctl.setEditing(null);
    openForm("新增申请", {});
  });
  document.getElementById("btn-empty-new").addEventListener("click", () => {
    if (ctl.saving) return;
    ctl.setEditing(null);
    openForm("新增申请", {});
  });
  tbody.addEventListener("click", (event) => {
    const tr = event.target.closest("tr[data-id]");
    if (tr) loadDetail(tr.dataset.id);
  });
  document.getElementById("btn-prev-page").addEventListener("click", async () => {
    ctl.setOffset(Math.max(0, ctl.offset - ctl.limit));
    await refreshList();
  });
  document.getElementById("btn-next-page").addEventListener("click", async () => {
    ctl.setOffset(ctl.offset + ctl.limit);
    await refreshList();
  });
  ["app-search", "app-stage", "app-recycle", "app-sort"].forEach((id) => {
    document.getElementById(id).addEventListener("change", async () => {
      ctl.setOffset(0);
      await refreshList();
    });
  });
  document.getElementById("app-search").addEventListener("keydown", async (event) => {
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

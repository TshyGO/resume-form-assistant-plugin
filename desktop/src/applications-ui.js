import {
  createApplicationsController,
  evidenceLabel,
  eventLabel,
  stageLabel,
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
      const maxOffset = Math.max(0, page.total - ctl.limit);
      pageEl.textContent = `${Math.floor(ctl.offset / ctl.limit) + 1} / ${Math.max(1, Math.ceil(page.total / ctl.limit))}`;
      document.getElementById("btn-prev-page").disabled = ctl.offset <= 0;
      document.getElementById("btn-next-page").disabled = ctl.offset >= maxOffset || page.total === 0;
      if (ctl.selectedId && !page.items.some((row) => row.id === ctl.selectedId) && args.recycle === "active") {
        detail.innerHTML = `<p class="muted">当前申请不在此列表过滤中。</p>`;
      }
    } catch (err) {
      if (!ctl.isCurrent(token)) return;
      msg.textContent = invokeError(err);
    }
  }

  async function loadDetail(id) {
    ctl.setSelected(id);
    tbody.querySelectorAll("tr").forEach((tr) => {
      tr.classList.toggle("active", tr.dataset.id === id);
    });
    try {
      const view = await invoke("get_application_cmd", { id });
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
                <span class="muted">${escapeHtml(formatTime((ev.occurred && (ev.occurred.value && ev.occurred.value.rfc3339)) || ev.recordedAt || ev.recorded_at))}</span>
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
      detail.innerHTML = `<p class="banner">${escapeHtml(invokeError(err))}</p>`;
    }
  }

  async function handleAction(act, view) {
    const app = view.application.summary || view.application;
    const id = app.id;
    try {
      if (act === "edit") {
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
      } else if (act === "interview") {
        const update = window.confirm("确定后写入面试记录。\n确定：同时更新当前进度。\n取消：仅作为历史补录，不改变当前阶段。");
        await invoke("record_interview_cmd", { args: { id, updateProgress: update, label: "面试" } });
      } else if (act === "assessment") {
        const update = window.confirm("确定后写入测评记录。\n确定：同时更新当前进度。\n取消：仅历史补录（Offer 后补录默认不倒退）。");
        await invoke("record_assessment_cmd", { args: { id, updateProgress: update, name: "测评" } });
      } else if (act === "offer") {
        const update = window.confirm("记录 Offer？确定将更新当前进度；取消则只记历史。");
        await invoke("record_offer_cmd", { args: { id, updateProgress: update } });
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
      await loadDetail(id);
      msg.textContent = "已保存。";
    } catch (err) {
      msg.textContent = invokeError(err);
    }
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
    document.getElementById("btn-save-app").disabled = true;
    formMsg.textContent = "保存中…";
    try {
      if (ctl.editingId) {
        await invoke("update_application_cmd", {
          args: {
            id: ctl.editingId,
            company: payload.company,
            title: payload.title,
            sourceUrl: payload.sourceUrl,
            location: payload.location,
            notes: payload.notes,
          },
        });
        formMsg.textContent = "已保存。";
        ctl.clearFormDirty();
        dialog.close();
        await refreshList();
        await loadDetail(ctl.editingId);
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
      document.getElementById("btn-save-app").disabled = false;
    }
  });

  document.getElementById("btn-cancel-app").addEventListener("click", () => {
    if (ctl.formDirty && !window.confirm("有未保存的修改，确定关闭？")) return;
    dialog.close();
    ctl.clearFormDirty();
  });
  document.getElementById("btn-new-app").addEventListener("click", () => {
    ctl.setEditing(null);
    openForm("新增申请", {});
  });
  document.getElementById("btn-empty-new").addEventListener("click", () => {
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
    if (event.key === "n" && event.target === document.body) {
      ctl.setEditing(null);
      openForm("新增申请", {});
    }
  });

  return { refreshList, ctl };
}

// Classic script shared by content scripts/pages/worker and imported for side effects.
// Do not add ESM exports: content scripts and importScripts require classic syntax.
// Automatic reports never carry arbitrary exception messages or object serialization.
(function (root) {
  const TYPES = new Set(["Error", "TypeError", "ReferenceError", "SyntaxError", "RangeError", "URIError", "EvalError", "AggregateError"]);
  const FILES = /^(?:[a-z][a-z0-9-]*\.js|link\/(?:[a-z][a-z0-9-]*\/)*[a-z][a-z0-9-]*\.mjs)$/;
  const LABELS = new Set(["姓名", "性别", "出生年月", "手机", "手机号", "邮箱", "学历", "学位", "学校", "专业", "毕业时间", "参加工作时间", "现居住地", "当前城市", "求职状态", "工作经历", "教育经历"]);
  function redact(value, limit = 5000) {
    return String(value ?? "").slice(0, 40000).normalize("NFKC")
      .replace(/(?:[A-Za-z]:[\\/]Users[\\/]|\/(?:Users|home)\/)[^\s\\/]+/gi, "[用户目录]")
      .replace(/(?:(?:Bearer|Basic)\s+\S+|(?:sk|oc_sk|key|token)[-_][A-Za-z0-9_-]{8,})/gi, "[凭据]")
      .replace(/(?:^|\n)\s*(?:cookie|set-cookie|authorization)\s*:\s*[^\n]*/gi, "\n[敏感请求头]")
      .replace(/(?:eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}|gh[pousr]_[A-Za-z0-9]{16,}|github_pat_[A-Za-z0-9_]{16,}|xox[baprs]-[A-Za-z0-9-]{10,})/g, "[凭据]")
      .replace(/["']?(?:api[-_ ]?key|authorization|cookie|password|secret|(?:auth|access|refresh|id)[-_ ]?token|token|密码|姓名|联系人)["']?\s*[:=：]\s*(?:"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|[^\n;；,}]+)/gi, "[敏感信息]")
      .replace(/https?:\/\/[^\s<>"'）)]+/gi, "[网址]")
      .replace(/[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}/g, "[邮箱]")
      .replace(/\d(?:[\s().+_-]*\d){4,}[xX]?/g, "[数字]")
      .slice(0, limit);
  }
  function hostname(value) {
    try { const u = new URL(value); return /^https?:$/.test(u.protocol) ? u.hostname : ""; } catch { return ""; }
  }
  function os(ua = "") {
    const system = /Windows/.test(ua) ? "Windows" : /Android/.test(ua) ? "Android" : /Mac/.test(ua) ? "macOS" : /Linux/.test(ua) ? "Linux" : "未知系统";
    const browser = /Edg\/(\d{1,3})/.exec(ua) || /Chrome\/(\d{1,3})/.exec(ua);
    return `${system}${browser ? ` / ${browser[0].startsWith("Edg") ? "Edge" : "Chrome"} ${browser[1]}` : ""}`;
  }
  function frames(stack, origin) {
    const found = [];
    for (const line of String(stack ?? "").slice(0, 40000).split("\n")) {
      const frame = /^\s*at (?:[^()\n]+ \()?([^\s()]+)\)?\s*$/.exec(line);
      if (!frame || !frame[1].startsWith(origin)) continue;
      const match = /^([^\s?#():]+):(\d{1,6}):(\d{1,6})$/.exec(frame[1].slice(origin.length));
      if (match && FILES.test(match[1])) found.push(`${match[1]}:${match[2]}:${match[3]}`);
      if (found.length === 20) break;
    }
    return found.join("\n");
  }
  function exception(error, origin, source = "error", filename = "", line = 0, column = 0) {
    const name = TYPES.has(error?.name) ? error.name : "Error";
    let raw = typeof error?.stack === "string" ? error.stack : "";
    const header = typeof error?.message === "string" ? `${error.name || "Error"}: ${error.message}` : "";
    if (header && raw.startsWith(header)) raw = raw.slice(header.length);
    const stack = frames(raw || (filename ? `at ${filename}:${Number(line) || 0}:${Number(column) || 0}` : ""), origin);
    return { kind: "exception", name, source: source === "unhandledrejection" ? source : "error", stack };
  }
  // --- fill_failed diagnostics v1 ----------------------------------------------------------
  // The content script builds the block with fillReport(); the worker re-parses it with
  // diagnostics() before sending. Every key has a closed value pattern, so field values,
  // page text, titles, full URLs and provider messages never cross the network boundary.
  // The worker writes the [来源] section (version, OS, host) itself; a page cannot supply it.
  const SECTIONS = new Set(["页面", "字段漏斗", "页面结构", "错误", "匹配", "性能", "未填字段"]);
  const CATEGORIES = ["no_fields_found", "page_not_supported", "iframe_blocked", "match_failed", "fill_rejected",
    "timeout", "service_error", "unknown", "none"];
  const ERROR_CODES = ["none", "cancelled", "network", "format", "input_too_large", "no_context", "bad_response",
    "not_configured", "credential_unavailable", "auth", "rate_limited", "timeout", "http", "response_too_large",
    "secret_in_prompt", "not_installed", "not_paired", "never_paired", "incompatible", "unavailable",
    "secret_only", "no_resume_fields"];
  // A failure of the AI service or the desktop link, not of matching this page.
  const SERVICE_CODES = new Set(["network", "format", "bad_response", "not_configured", "credential_unavailable", "auth",
    "rate_limited", "http", "response_too_large", "not_installed", "not_paired", "never_paired", "incompatible", "unavailable"]);
  const DROPS = ["type_hidden", "non_fillable", "disabled", "invisible", "grouped", "out_of_scope", "secret",
    "no_resume_mapping", "ai_unmatched", "no_result", "not_sent", "not_written", "unconfirmed", "unsynced"];
  // URL path segments are kept only when every word in them is a common route word, so
  // user names and slugs (/u/zhangsan, /people/john-doe) never leave as written.
  const ROUTE_WORDS = new Set(("apply applies application applications applicant resume resumes cv jianli toudi delivery deliver "
    + "job jobs position positions post posts campus social career careers recruit recruitment recruiting hire hiring zhaopin "
    + "xiaozhao shezhao intern interns internship graduate school candidate candidates talent talents portal user users account "
    + "accounts profile profiles personal info information basic base detail details education experience work project projects "
    + "skill skills family contact attachment attachments upload step steps form forms edit editor preview submit confirm success "
    + "result view list index home main center centre my me mine new create add update manage management page pages wizard "
    + "interview interviews assessment exam test online register signup sign up in login logout auth oauth sso enroll enrollment "
    + "baoming onboard onboarding entry m h5 mobile pc web wap app wx wechat mp en zh cn us api s p c u hr ats cms open public "
    + "static html htm shtml php jsp aspx asp do action").split(" "));
  const LIBRARY_NAMES = ["antd", "element", "arco", "iview", "semi", "vant", "layui", "mui", "other"];
  const FILL_REASONS = ["value_not_committed", "value_reverted", "element_disconnected", "validation_not_cleared", "framework_state_unsynced", "value_changed", "verification_timeout", "unsupported_control", "no_option_match", "selection_not_committed", "control_disabled", "invalid_date", "operation_failed", "cancelled"];
  const MAX_UNFILLED = 10;
  const INT = /^(?:\d{1,9}|-)$/;
  const tally = names => new RegExp(`^(?:-|(?:${names.join("|")})=\\d{1,6}(?:,(?:${names.join("|")})=\\d{1,6})*)$`);
  const oneOf = (names, extra = "") => new RegExp(`^(?:${names.join("|")}${extra})$`);
  const VALUES = {
    url_path: /^\/(?:(?:[A-Za-z][A-Za-z0-9._-]{0,19}|:id)(?:\/(?:[A-Za-z][A-Za-z0-9._-]{0,19}|:id)){0,7}(?:\/:more)?)?$/,  // + safePath()
    page_type: /^(?:application_form|unknown|-)$/, page_type_reason: /^(?:url|title|edit_button|structure|none|-)$/,
    dom_ready_at_scan: /^(?:true|false|-)$/, scan_duration_ms: INT,
    dom_inputs: INT, visible_fields: INT, candidates: INT, matched: INT, filled: INT, drop_reasons: tally(DROPS),
    dom_elements: INT, iframes_total: INT, iframes_cross_origin: INT, same_origin_iframe_inputs: INT,
    shadow_roots_with_inputs: INT, custom_controls: INT, custom_libraries: tally(LIBRARY_NAMES),
    readonly_or_disabled: INT, edit_buttons: INT,
    error_category: oneOf(CATEGORIES), first_failing_stage: /^(?:scan|match|fill|none)$/,
    error_code: oneOf(ERROR_CODES, "|http_\\d{3}|-"),
    local_matches: INT, ai_fields: INT, ai_called: /^(?:true|false|-)$/, ai_matches: INT, ai_latency_ms: INT,
    resume_fields: INT, resume_candidates: INT, prompt_bytes: INT,
    timings_ms: /^scan=(?:\d{1,9}|-),match=(?:\d{1,9}|-),fill=(?:\d{1,9}|-),total=(?:\d{1,9}|-)$/,
    unlisted: INT
  };
  const CONTROL_TOKEN = new RegExp("^(?:(?:input|textarea|select|button|div|span)(?:\\[(?:text|date|month|number|radio|checkbox|email|tel|search)\\])?"
    + "|role=(?:textbox|combobox|listbox|button|radio|checkbox)|popup=(?:listbox|dialog|true)|readonly"
    + `|(?:picker|lib)=(?:antd|element|arco|iview|semi|vant|layui|generic|mui)|reason=(?:${FILL_REASONS.join("|")}))$`);

  function routeSegment(text) {
    if (!/^[A-Za-z][A-Za-z0-9._-]{0,19}$/.test(text)) return false;
    return text.replace(/([a-z])([A-Z])/g, "$1 $2").split(/[\s._-]+/).filter(Boolean)
      .every(word => ROUTE_WORDS.has(word.toLowerCase()) || /^v\d{1,2}$/i.test(word));
  }

  // Common route words survive; every other segment (names, ids, tokens, non-ASCII) becomes :id.
  function pathTemplate(pathname) {
    const segments = String(pathname ?? "").split("/").filter(Boolean);
    const kept = segments.slice(0, 8).map(segment => {
      let text;
      try { text = decodeURIComponent(segment); } catch { return ":id"; }
      return routeSegment(text) ? text : ":id";
    });
    return `/${kept.join("/")}${segments.length > 8 ? "/:more" : ""}`;
  }

  // The worker re-checks the vocabulary, not just the shape, of a path it is handed.
  function safePath(value) {
    return VALUES.url_path.test(value) && value.split("/").filter(Boolean).every(part => part === ":id" || part === ":more" || routeSegment(part));
  }

  // Why the fill failed and the first stage that failed. `none` means nothing failed.
  function fillCategory({ scanned, fieldCount, pageType, frames, failedStage, responded, errorCode, matched, filledCount, unfilledCount, unconfirmedCount }) {
    if (!scanned) return { category: "unknown", stage: "scan" };
    if (fieldCount === 0) {
      // A form may sit in a frame even when nothing else on the page looks like one.
      if (frames?.crossOrigin > 0 || frames?.frameInputs > 0) return { category: "iframe_blocked", stage: "scan" };
      // A page that is not an application form has nothing to fix. When the probe is
      // missing we cannot tell, so the page is treated as a form that yielded no fields.
      return { category: pageType === "unknown" ? "page_not_supported" : "no_fields_found", stage: "scan" };
    }
    if (failedStage === "match") {
      if (!responded) return { category: "unknown", stage: "match" };
      if (errorCode === "timeout") return { category: "timeout", stage: "match" };
      if (SERVICE_CODES.has(errorCode) || /^http_\d{3}$/.test(errorCode ?? "")) return { category: "service_error", stage: "match" };
      return { category: "match_failed", stage: "match" };
    }
    if (failedStage) return { category: "unknown", stage: failedStage };
    if (!matched) return { category: "match_failed", stage: "match" };
    if (filledCount === 0 || unfilledCount > 0 || unconfirmedCount > 0) return { category: "fill_rejected", stage: "fill" };
    return { category: "none", stage: "none" };
  }

  const positive = value => Number.isInteger(value) && value > 0 ? value : 0;
  // The worker's diagnostics when the AI request got an answer; content.js keeps {} otherwise.
  const answer = input => (input.diagnostics && Object.keys(input.diagnostics).length ? input.diagnostics : null);

  // Fields lost at each step of scan → match → fill, in funnel order; only non-zero reasons.
  function fillDrops(input) {
    const s = input.stats || null;
    const d = answer(input);
    const n = positive;
    const secret = n(d?.secretFormFields);
    const noMapping = n(d?.skippedNoContext);
    // Fields neither matched nor skipped. Those handed to the AI (at most aiFields, less the
    // ones skipped for lack of resume data) are AI misses, or got no result when the AI service
    // or desktop link failed; with an empty template the rest had no resume data at all;
    // otherwise they were never sent (e.g. too large). A request with no answer at all leaves
    // every field without a result.
    const failed = Boolean(d) && (d.errorCode === "timeout" || SERVICE_CODES.has(d.errorCode) || /^http_\d{3}$/.test(d.errorCode ?? ""));
    const rest = d ? Math.max(0, n(input.fieldCount) - secret - n(d.ruleMatches) - noMapping - n(d.aiMatches))
      : input.requested ? n(input.fieldCount) : 0;
    const sent = d && aiCalled(input) ? Math.min(rest, Math.max(0, n(d.aiFields) - noMapping - n(d.aiMatches))) : 0;
    const counts = {
      type_hidden: n(s?.typeHidden), non_fillable: n(s?.nonFillable), disabled: n(s?.disabled), invisible: n(s?.invisible),
      grouped: n(s?.grouped), out_of_scope: n(s?.outOfScope), secret, no_resume_mapping: noMapping,
      ai_unmatched: failed ? 0 : sent, no_result: d ? (failed ? sent : 0) : rest, not_sent: 0,
      not_written: n(input.unfilledCount), unconfirmed: n(input.unconfirmedCount), unsynced: n(input.unsyncedCount)
    };
    if (d) counts[d.errorCode === "no_resume_fields" ? "no_resume_mapping" : "not_sent"] += rest - sent;
    return DROPS.filter(key => counts[key] > 0).map(key => [key, counts[key]]);
  }

  // Whether the AI was actually called: true / false, or null when the request got no answer.
  function aiCalled(input) {
    const d = answer(input);
    if (d) return positive(d.promptBytes) > 0;
    return input.requested ? null : false;
  }

  function fillReport(input) {
    const count = value => Number.isInteger(value) && value >= 0 ? String(value) : "-";
    const ms = value => typeof value === "number" && Number.isFinite(value) && value >= 0 ? String(Math.round(value)) : "-";
    const flag = value => typeof value === "boolean" ? String(value) : "-";
    const s = input.stats || null;
    const p = input.probe || null;
    const d = answer(input);
    const n = positive;
    const libraries = {};
    for (const [name, value] of Object.entries(p?.custom?.byLibrary || {})) {
      const key = LIBRARY_NAMES.includes(name) ? name : "other";
      libraries[key] = (libraries[key] || 0) + n(value);
    }
    const listed = (entries, order) => order.filter(key => entries[key] > 0).map(key => `${key}=${entries[key]}`).join(",") || "-";
    const called = aiCalled(input);
    const lines = [
      "[页面]",
      `url_path: ${pathTemplate(input.path)}`,
      `page_type: ${input.pageType?.type || "-"}`,
      `page_type_reason: ${input.pageType?.reason || "-"}`,
      `dom_ready_at_scan: ${flag(input.readyAtScan)}`,
      `scan_duration_ms: ${ms(input.scanMs)}`,
      "",
      "[字段漏斗]",
      `dom_inputs: ${count(s?.domInputs)}`,
      `visible_fields: ${count(s?.visible)}`,
      `candidates: ${count(input.fieldCount)}`,
      `matched: ${count(input.matched)}`,
      `filled: ${count(input.filledCount)}`,
      `drop_reasons: ${fillDrops(input).map(([key, value]) => `${key}=${value}`).join(",") || "-"}`,
      "",
      "[页面结构]",
      `dom_elements: ${count(p?.elements)}`,
      `iframes_total: ${count(p?.frames?.total)}`,
      `iframes_cross_origin: ${count(p?.frames?.crossOrigin)}`,
      `same_origin_iframe_inputs: ${count(p?.frames?.frameInputs)}`,
      `shadow_roots_with_inputs: ${count(p?.shadowHosts)}`,
      `custom_controls: ${count(p?.custom?.total)}`,
      `custom_libraries: ${listed(libraries, LIBRARY_NAMES)}`,
      `readonly_or_disabled: ${count(p?.locked)}`,
      `edit_buttons: ${count(p?.editButtons)}`,
      "",
      "[错误]",
      `error_category: ${input.category || "unknown"}`,
      `first_failing_stage: ${input.stage || "none"}`,
      `error_code: ${typeof d?.errorCode === "string" && VALUES.error_code.test(d.errorCode) ? d.errorCode : "-"}`,
      "",
      "[匹配]",
      `local_matches: ${count(d?.ruleMatches)}`,
      `ai_fields: ${count(d?.aiFields)}`,
      `ai_called: ${flag(called)}`,
      `ai_matches: ${count(d?.aiMatches)}`,
      `ai_latency_ms: ${called ? ms(d.apiMs) : "-"}`,
      `resume_fields: ${count(d?.resumeFields)}`,
      `resume_candidates: ${count(d?.candidateFields)}`,
      `prompt_bytes: ${count(d?.promptBytes)}`,
      "",
      "[性能]",
      `timings_ms: scan=${ms(input.scanMs)},match=${ms(input.roundTripMs)},fill=${ms(input.fillMs)},total=${ms(input.totalMs)}`
    ];
    const unfilled = Array.isArray(input.unfilledControls) ? input.unfilledControls : [];
    if (unfilled.length) {
      lines.push("", "[未填字段]");
      for (const item of unfilled.slice(0, MAX_UNFILLED)) {
        const c = item?.control || {};
        const tokens = [`${c.tag || "?"}${c.type ? `[${c.type}]` : ""}`];
        if (c.role) tokens.push(`role=${c.role}`);
        if (c.popup) tokens.push(`popup=${c.popup}`);
        if (c.readOnly) tokens.push("readonly");
        if (c.picker) tokens.push(`picker=${c.picker}`);
        if (c.library) tokens.push(`lib=${c.library}`);
        if (item?.reasonCode) tokens.push(`reason=${item.reasonCode}`);
        lines.push(`- ${LABELS.has(item?.label) ? item.label : "（字段名已隐藏）"}: ${tokens.join(" ")}`);
      }
      if (unfilled.length > MAX_UNFILLED) lines.push(`unlisted: ${unfilled.length - MAX_UNFILLED}`);
    }
    return diagnostics(lines.join("\n"));
  }

  // Keep only v1 lines whose key and value are both in the closed vocabulary.
  function diagnostics(value) {
    const safe = [];
    for (const line of String(value ?? "").slice(0, 20000).split("\n").slice(0, 120)) {
      const section = /^\[(.{1,8})\]$/.exec(line);
      if (section) {
        if (SECTIONS.has(section[1])) safe.push(...(safe.length ? ["", line] : [line]));
        continue;
      }
      // Every value has its own closed pattern; the length cap only bounds the regex work.
      const entry = /^([a-z_]{1,32}): (.{1,300})$/.exec(line);
      if (entry) {
        const known = Object.prototype.hasOwnProperty.call(VALUES, entry[1]) && VALUES[entry[1]].test(entry[2]);
        if (known && (entry[1] !== "url_path" || safePath(entry[2]))) safe.push(line);
        continue;
      }
      const control = /^- (.{1,40}): (.{1,200})$/.exec(line);
      if (!control) continue;
      const tokens = control[2].split(" ").filter(token => CONTROL_TOKEN.test(token));
      safe.push(`- ${LABELS.has(control[1]) ? control[1] : "（字段名已隐藏）"}: ${tokens.join(" ") || "?"}`);
    }
    return safe.join("\n").slice(0, 3500);
  }

  function fillFailure({ assisted, cancelled, overwriteDeclined, fieldCount, filledCount, unfilledCount, unconfirmedCount, editHint, category }) {
    if (assisted || cancelled || overwriteDeclined) return null;
    // A page that is not an application form has nothing to fix; reporting it is noise.
    if (category === "page_not_supported") return null;
    if (fieldCount === 0 || unfilledCount > 0 || unconfirmedCount > 0 || editHint) return filledCount > 0 ? "fill_partial" : "fill_failed";
    return null;
  }
  function install(send, { origin, requireOwn = false, captureErrors = true } = {}) {
    if (!root.addEventListener) return;
    const forward = data => {
      if (requireOwn && !data.stack) return;
      try { Promise.resolve(send(data)).catch(() => {}); } catch { /* no recursive reporting */ }
    };
    if (captureErrors) root.addEventListener("error", e => {
      if (requireOwn && (e.isTrusted !== true || !(e.error instanceof Error) || typeof e.error.stack !== "string" || !String(e.filename || "").startsWith(origin))) return;
      forward(exception(e.error, origin, "error", requireOwn ? "" : e.filename, e.lineno, e.colno));
    });
    root.addEventListener("unhandledrejection", e => {
      if (requireOwn && (e.isTrusted !== true || !(e.reason instanceof Error) || typeof e.reason.stack !== "string")) return;
      forward(exception(e.reason, origin, "unhandledrejection"));
    });
  }
  const api = { redact, hostname, os, frames, exception, pathTemplate, fillCategory, fillDrops, aiCalled, fillReport, diagnostics, fillFailure, install };
  root.ResumeProFeedback = api;
  if (typeof module !== "undefined") module.exports = api;
})(typeof self !== "undefined" ? self : globalThis);

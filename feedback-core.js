// Shared by isolated content scripts, extension pages and the service worker.
// Automatic reports never carry arbitrary exception messages or object serialization.
(function (root) {
  const TYPES = new Set(["Error", "TypeError", "ReferenceError", "SyntaxError", "RangeError", "URIError", "EvalError", "AggregateError"]);
  const FILES = /^(?:[a-z][a-z0-9-]*\.js|link\/(?:[a-z][a-z0-9-]*\/)*[a-z][a-z0-9-]*\.mjs)$/;
  const LABELS = new Set(["姓名", "性别", "出生年月", "手机", "手机号", "邮箱", "学历", "学位", "学校", "专业", "毕业时间", "参加工作时间", "现居住地", "当前城市", "求职状态", "工作经历", "教育经历"]);
  function redact(value, limit = 5000) {
    return String(value ?? "").slice(0, 40000).normalize("NFKC")
      .replace(/(?:[A-Za-z]:[\\/]Users[\\/]|\/(?:Users|home)\/)[^\s\\/]+/gi, "[用户目录]")
      .replace(/(?:Bearer\s+\S+|(?:sk|oc_sk|key|token)[-_][A-Za-z0-9_-]{8,})/gi, "[凭据]")
      .replace(/(?:api[-_ ]?key|authorization|cookie|密码|姓名|联系人)\s*[:=：]\s*[^\n;；]+/gi, "[敏感信息]")
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
      const start = line.indexOf(origin);
      if (start < 0) continue;
      const match = /^([^\s?#():]+):(\d{1,6}):(\d{1,6})/.exec(line.slice(start + origin.length));
      if (match && FILES.test(match[1])) found.push(`${match[1]}:${match[2]}:${match[3]}`);
      if (found.length === 20) break;
    }
    return found.join("\n");
  }
  function exception(error, origin, source = "error", filename = "", line = 0, column = 0) {
    const name = TYPES.has(error?.name) ? error.name : "Error";
    const stack = frames(error?.stack || (filename ? `${filename}:${Number(line) || 0}:${Number(column) || 0}` : ""), origin);
    return { kind: "exception", name, source: source === "unhandledrejection" ? source : "error", stack };
  }
  // Parse the local #206 text into a closed vocabulary. In particular, unknown labels,
  // DOM attributes and appended page/provider text never cross the network boundary.
  function diagnostics(value) {
    const lines = String(value ?? "").slice(0, 20000).split("\n");
    const safe = [];
    const count = "(?:[0-9]{1,6}|未取得)";
    const patterns = [
      /^网申快填 v[0-9.]{1,20}$/, /^结果：(完成|部分完成|失败|未知)；错误类别：[a-z_]{1,32}(?:\d{3})?$/,
      new RegExp(`^网页字段：${count}；成功填写：${count}；没填上：${count}$`),
      new RegExp(`^本地匹配：${count}；AI 匹配：${count}$`), new RegExp(`^送 AI 字段：${count}$`),
      new RegExp(`^候选 / 简历字段：${count} / ${count}$`),
      new RegExp(`^敏感字段过滤：${count}；超大资料跳过：${count}；无对应资料跳过：${count}$`),
      new RegExp(`^用户 prompt：${count} bytes$`),
      /^(扫描|匹配往返（含后台处理）|API（含响应读取）)：(?:[0-9.]{1,12} s|未执行 \/ 未取得)$/,
      /^填写：(\d{1,9}\.\d{2} s|未执行 \/ 未取得)；总计：(\d{1,9}\.\d{2} s|未执行 \/ 未取得)$/,
      /^页面表单状态未同步：\d{1,6}（提交校验后网页仍标为无效，请手动点击这些字段确认）$/,
      /^页面线索：内嵌框架 \d{1,6}（跨域 \d{1,6}，同源框架内输入框 \d{1,6}）；自定义控件 \d{1,6}(?:（(?:(?:antd|element|arco|iview|semi|vant|layui|mui) \d{1,6}[、]?)+）)?；只读或禁用输入框 \d{1,6}；「编辑」按钮 \d{1,6}；含输入框的 Shadow DOM \d{1,6}$/,
      /^没填上的字段（控件结构）：$/, /^- 还有 \d{1,6} 个未列出$/
    ];
    for (const line of lines.slice(0, 40)) {
      if (patterns.some(p => p.test(line))) { safe.push(line); continue; }
      const control = /^- (.{1,40})：(.{1,300})$/.exec(line);
      if (!control) continue;
      const label = LABELS.has(control[1]) ? control[1] : "（字段名已隐藏）";
      const tokens = control[2].split("｜")[0].split(" ").filter(t => /^(?:input|textarea|select|button|div|span)(?:\[(?:text|date|month|number|radio|checkbox|email|tel|search)\])?$/.test(t)
        || /^(?:role=(?:textbox|combobox|listbox|button|radio|checkbox)|弹出=(?:listbox|dialog|true)|只读|(?:日期控件|组件库)=(?:antd|element|arco|iview|semi|vant|layui|generic|mui))$/.test(t));
      safe.push(`- ${label}：${tokens.join(" ") || "结构未知"}`);
    }
    return safe.join("\n").slice(0, 3500);
  }
  function fillFailure({ assisted, cancelled, overwriteDeclined, fieldCount, filledCount, unfilledCount, editHint }) {
    if (assisted || cancelled || overwriteDeclined) return null;
    if (fieldCount === 0 || unfilledCount > 0 || editHint) return filledCount > 0 ? "fill_partial" : "fill_failed";
    return null;
  }
  function install(send, { origin, requireOwn = false } = {}) {
    if (!root.addEventListener) return;
    const forward = data => {
      if (requireOwn && !data.stack) return;
      try { Promise.resolve(send(data)).catch(() => {}); } catch { /* no recursive reporting */ }
    };
    root.addEventListener("error", e => forward(exception(e.error, origin, "error", e.filename, e.lineno, e.colno)));
    root.addEventListener("unhandledrejection", e => forward(exception(e.reason, origin, "unhandledrejection")));
  }
  const api = { redact, hostname, os, frames, exception, diagnostics, fillFailure, install };
  root.ResumeProFeedback = api;
  if (typeof module !== "undefined") module.exports = api;
})(typeof self !== "undefined" ? self : globalThis);

// #206 填写诊断用的只读页面探测。只看结构：标签名、type、role、组件库 class 前缀和计数；
// 从不输出字段值、页面正文或完整网址（为了认出「编辑」按钮会读文本节点，但只匹配、不保留、不输出）。
// content.js 经 withFillProbe() 调用，这里缺席或出错时诊断退回原样，填写不受影响。
(function (root) {
  const SELECTORS = {
    frames: "iframe, frame",
    inputs: "input:not([type=hidden]), textarea, select",
    custom: "[role=combobox], [role=listbox], [aria-haspopup=listbox], [contenteditable]:not([contenteditable=false]), "
      + ".ant-select, .ant-cascader, .el-select, .el-cascader, .arco-select, .arco-cascader, "
      + ".ivu-select, .ivu-cascader, .semi-select, .layui-form-select",
    labelled: "[aria-label], [title]",
    locked: "input[readonly]:not([type=hidden]), input[disabled]:not([type=hidden]), textarea[readonly], textarea[disabled], select[disabled]",
    all: "*"
  };
  const EDIT_TEXT = /^(?:编辑|修改|完善|去完善|去编辑|立即完善|完善简历|编辑简历|修改简历|编辑信息|修改信息|编辑资料)$/;
  const MAX_WALK = 3000;
  const MAX_TEXT_NODES = 50000;
  const MAX_EDIT_TEXT = 40;
  const SKIP_TEXT_PARENTS = new Set(["SCRIPT", "STYLE", "NOSCRIPT", "TEMPLATE", "TEXTAREA"]);
  const MAX_LISTED = 10;
  const LIBRARIES = [
    ["antd", /^ant-/], ["element", /^el-/], ["arco", /^arco-/], ["iview", /^ivu-/],
    ["semi", /^semi-/], ["vant", /^van-/], ["layui", /^layui-/], ["mui", /^Mui/]
  ];
  const TOKEN = /^[a-z][a-z0-9-]{0,23}$/;
  const MAX_ANCESTORS = 4;
  const MAX_LABEL = 16;

  const token = value => {
    const text = String(value ?? "").trim().toLowerCase();
    return TOKEN.test(text) ? text : "";
  };
  const classTokens = el => (typeof el?.className === "string" ? el.className.split(/\s+/).filter(Boolean) : []);

  // 控件本身和往上几层祖先里，第一个认得出的组件库前缀。只返回库名，不返回原始 class。
  function libraryOf(el) {
    for (let current = el, depth = 0; current && depth <= MAX_ANCESTORS; current = current.parentElement, depth += 1) {
      for (const name of classTokens(current)) {
        const hit = LIBRARIES.find(([, pattern]) => pattern.test(name));
        if (hit) return hit[0];
      }
    }
    return "";
  }

  // entry 与 content.js 的 fieldMap 条目同形：{ kind: "element", element, pickerType } 或 { kind: "radio", elements }。
  function describeControl(entry) {
    const el = entry?.kind === "radio" ? entry.elements?.[0] : entry?.element;
    if (!el) return null;
    const attr = name => el.getAttribute?.(name);
    const tag = token(el.tagName);
    return {
      tag,
      type: tag === "input" ? token(el.type || attr("type")) || "text" : "",
      role: token(attr("role")),
      popup: token(attr("aria-haspopup")),
      readOnly: el.readOnly === true || attr("readonly") != null,
      picker: token(entry.pickerType),
      library: libraryOf(el)
    };
  }

  // 字段名来自网页，但兜底规则可能把旁边的文字当成字段名：长的截断，像联系方式的整体隐藏。
  function safeLabel(label) {
    const text = String(label ?? "").replace(/\s+/g, " ").trim();
    if (!text) return "未命名字段";
    // 邮箱，或去掉空格、连字符、括号后连着 5 位以上数字（含全角数字）的手机号/证件号。
    if (/[@＠]/.test(text) || /[0-9０-９]{5,}/.test(text.replace(/[\s\-－.．()（）]/g, ""))) return "（字段名已隐藏）";
    const chars = Array.from(text);
    return chars.length > MAX_LABEL ? `${chars.slice(0, MAX_LABEL).join("")}…` : text;
  }

  const visible = el => Boolean(el?.getClientRects?.().length);
  const shown = list => Array.from(list || []).filter(visible);
  // 框架只算有实际尺寸的：0×0 的统计/单点登录 iframe 在 Chrome 里也会返回 1 个 client rect。
  const sized = el => {
    const r = el.getBoundingClientRect?.();
    return Boolean(r && r.width >= 100 && r.height >= 50);
  };
  // 去掉空白、标点、符号、iconfont 的私用区字形，以及变体选择符、零宽字符这类不可见字符，只留文字本身。
  const bare = value => String(value ?? "").replace(/[\s\p{P}\p{S}\p{Co}\p{M}\p{Cf}-]/gu, "");

  function hostOf(href) {
    try {
      return new URL(href).hostname;
    } catch {
      return "";
    }
  }

  // 「编辑」按钮写法五花八门（a、span、带图标、悬停才出现），所以按文字找：文字正好是「编辑」一类的文本节点，
  // 数它们所在的元素（同一元素只算一次）；再补上只有 aria-label / title 的图标按钮。不要求可见。
  function countEditControls(doc) {
    const found = new Set();
    const walker = doc.createTreeWalker?.(doc.body || doc, 4 /* NodeFilter.SHOW_TEXT */);
    for (let count = 0; walker && count < MAX_TEXT_NODES; count += 1) {
      const text = walker.nextNode();
      if (!text) break;
      const parent = text.parentElement;
      if (!parent || SKIP_TEXT_PARENTS.has(parent.tagName)) continue;
      // 按钮文字很短：长文本先挡掉，正文既不用跑正则，也不会被读进来。
      if (String(text.data ?? "").trim().length > MAX_EDIT_TEXT) continue;
      if (EDIT_TEXT.test(bare(text.data))) found.add(parent);
    }
    for (const el of Array.from(doc.querySelectorAll(SELECTORS.labelled) || [])) {
      if ([el.getAttribute?.("aria-label"), el.getAttribute?.("title")].some(value => EDIT_TEXT.test(bare(value)))) found.add(el);
    }
    return found.size;
  }

  // 页面层面的线索：只数数，不输出内容。
  function probePage(doc, { href = "" } = {}) {
    const frames = Array.from(doc.querySelectorAll(SELECTORS.frames)).filter(sized);
    let crossOrigin = 0;
    let frameInputs = 0;
    for (const frame of frames) {
      let inner = null;
      try {
        inner = frame.contentDocument;
      } catch {
        inner = null;
      }
      if (inner) frameInputs += Array.from(inner.querySelectorAll(SELECTORS.inputs)).length;
      else crossOrigin += 1;
    }

    const byLibrary = {};
    let customTotal = 0;
    for (const control of shown(doc.querySelectorAll(SELECTORS.custom))) {
      // antd 下拉外壳里还套着 role=combobox 的输入框：只数最外层。
      if (control.parentElement?.closest?.(SELECTORS.custom)) continue;
      customTotal += 1;
      const library = libraryOf(control) || "其他";
      byLibrary[library] = (byLibrary[library] || 0) + 1;
    }

    const all = doc.querySelectorAll(SELECTORS.all);
    const limit = Math.min(all.length || 0, MAX_WALK);
    let shadowHosts = 0;
    for (let index = 0; index < limit; index += 1) {
      if (all[index]?.shadowRoot?.querySelector?.(SELECTORS.inputs)) shadowHosts += 1;
    }

    return {
      host: hostOf(href),
      frames: { total: frames.length, crossOrigin, frameInputs },
      custom: { total: customTotal, byLibrary },
      editButtons: countEditControls(doc),
      // 只读的下拉输入框属于自定义控件，不算；禁用的输入框即使套在自定义控件里也照算。
      locked: shown(doc.querySelectorAll(SELECTORS.locked)).filter(el => el.disabled || !el.closest?.(SELECTORS.custom)).length,
      shadowHosts
    };
  }

  // 扫描到 0 个字段，或扫描到字段但一个都没填上时，按最可能的原因告诉用户下一步怎么做。
  function emptyPageHint(probe) {
    if (!probe) return "";
    if (probe.editButtons > 0) return "这个页面可能还在查看状态：请先点网页上的「编辑」，等输入框出现后再一键填写。";
    if (probe.locked > 0) return "网页上的输入框目前是只读或禁用的：请先点「编辑」或完成网页要求的上一步，再一键填写。";
    if (probe.frames.crossOrigin > 0 || probe.frames.frameInputs > 0) {
      return "表单可能在网页的内嵌框架里，插件暂时读不到。可以把侧栏的「填写诊断」复制给我们。";
    }
    if (probe.custom.total > 0 || probe.shadowHosts > 0) {
      return "这个网页用的输入控件插件暂时识别不了。可以把侧栏的「填写诊断」复制给我们。";
    }
    return "";
  }

  function formatControl(control) {
    if (!control) return "结构未知";
    const parts = [`${control.tag || "?"}${control.type ? `[${control.type}]` : ""}`];
    if (control.role) parts.push(`role=${control.role}`);
    if (control.popup) parts.push(`弹出=${control.popup}`);
    if (control.readOnly) parts.push("只读");
    if (control.picker) parts.push(`日期控件=${control.picker}`);
    if (control.library) parts.push(`组件库=${control.library}`);
    return parts.join(" ");
  }

  // 追加到填写诊断末尾的几行。unfilled 的 reason 只能是 content.js 里固定的失败原因文案。
  function formatReport(probe, unfilled = []) {
    const lines = [];
    if (probe) {
      const libraries = Object.entries(probe.custom.byLibrary).map(([name, count]) => `${name} ${count}`).join("、");
      lines.push(`页面：${probe.host || "未知"}`);
      lines.push(`页面线索：内嵌框架 ${probe.frames.total}（跨域 ${probe.frames.crossOrigin}，同源框架内输入框 ${probe.frames.frameInputs}）；`
        + `自定义控件 ${probe.custom.total}${libraries ? `（${libraries}）` : ""}；只读或禁用输入框 ${probe.locked}；`
        + `「编辑」按钮 ${probe.editButtons}；含输入框的 Shadow DOM ${probe.shadowHosts}`);
    }
    if (unfilled.length) {
      lines.push("没填上的字段（控件结构）：");
      for (const item of unfilled.slice(0, MAX_LISTED)) {
        lines.push(`- ${safeLabel(item.label)}：${formatControl(item.control)}${item.reason ? `｜${item.reason}` : ""}`);
      }
      if (unfilled.length > MAX_LISTED) lines.push(`- 还有 ${unfilled.length - MAX_LISTED} 个未列出`);
    }
    return lines;
  }

  const api = { SELECTORS, describeControl, safeLabel, probePage, emptyPageHint, formatReport };
  root.ResumeProFillProbe = api;
  if (typeof module !== "undefined") module.exports = api;
})(typeof self !== "undefined" ? self : globalThis);

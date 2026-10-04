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
  // 页面元素和各层 Shadow DOM 里的元素合计最多看这么多个：只读属性，很快。
  const MAX_WALK = 20000;
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
  // 判断是不是网申填写页：地址里的强信号可以是子串（applyJob、myResume），form / profile 这类常见词要整词出现
  // （platform、information 不算）。职位详情、招聘首页（job、career、campus）不算填写页。
  const FORM_URL = /apply|applica|resume|jianli|toudi|baoming|signup|register|enroll|onboard/i;
  const FORM_URL_WORDS = new Set(["form", "forms", "profile", "cv"]);
  const FORM_TITLE = /简历|网申|申请|投递|报名|应聘|个人信息|基本信息|登记表|入职|填写|apply|application|resume|register|sign ?up|profile/i;
  const FORM_INPUTS = 3;

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
    // 邮箱、网址，或去掉空白和标点符号后连着 5 位以上数字（含全角数字）的手机号/证件号。
    if (/[@＠]|(?:https?|wss?|ftp):\/\/|www\./i.test(text)
      || /[0-9０-９]{5,}/.test(text.replace(/[\s\p{P}\p{S}]/gu, ""))) return "（字段名已隐藏）";
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
      // 跨域框架读不到文档；同源框架正在跳转时查询也可能失败，都按读不到算，不能丢掉整份线索。
      let inputs = null;
      try {
        const inner = frame.contentDocument;
        inputs = inner ? Array.from(inner.querySelectorAll(SELECTORS.inputs)).length : null;
      } catch {
        inputs = null;
      }
      if (inputs === null) crossOrigin += 1;
      else frameInputs += inputs;
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
    return {
      host: hostOf(href),
      frames: { total: frames.length, crossOrigin, frameInputs },
      custom: { total: customTotal, byLibrary },
      editButtons: countEditControls(doc),
      // 只读的下拉输入框属于自定义控件，不算；禁用的输入框即使套在自定义控件里也照算。
      locked: shown(doc.querySelectorAll(SELECTORS.locked)).filter(el => el.disabled || !el.closest?.(SELECTORS.custom)).length,
      shadowHosts: countShadowHosts(all),
      elements: all.length || 0
    };
  }

  // 含输入框的 Shadow DOM：往下逐层找（Web Components 常常一层套一层），每个含输入框的 shadow root 算一个。
  // 深度优先：遇到 shadow root 先进去找完再往后走，大页面不会在顶层就把额度用完。
  function countShadowHosts(all) {
    let hosts = 0;
    let visited = 0;
    const stack = [{ list: all || [], index: 0 }];
    while (stack.length && visited < MAX_WALK) {
      const top = stack[stack.length - 1];
      if (top.index >= (top.list.length || 0)) {
        stack.pop();
        continue;
      }
      const shadow = top.list[top.index++]?.shadowRoot;
      visited += 1;
      if (!shadow) continue;
      if (shadow.querySelector?.(SELECTORS.inputs)) hosts += 1;
      const inner = shadow.querySelectorAll?.(SELECTORS.all);
      if (inner?.length) stack.push({ list: inner, index: 0 });
    }
    return hosts;
  }

  // 是不是网申填写页，以及依据。地址和标题只在本地比对，不输出。探测失败又看不出来时返回 null（判断不了）。
  // stats 是 content.js 扫描时的计数：页面上可填的输入框有几个（不算 type=hidden 和按钮、文件框；可见与否都算）。
  function pageType({ pathname = "", title = "", probe = null, stats = null } = {}) {
    const path = String(pathname ?? "");
    if (FORM_URL.test(path) || path.split(/[^A-Za-z0-9]+|(?<=[a-z])(?=[A-Z])/).some(word => FORM_URL_WORDS.has(word.toLowerCase()))) {
      return { type: "application_form", reason: "url" };
    }
    if (FORM_TITLE.test(String(title ?? ""))) return { type: "application_form", reason: "title" };
    if (!probe) return null;
    if (probe.editButtons > 0) return { type: "application_form", reason: "edit_button" };
    // 跨域框架不算证据：广告、页脚和客服窗口都是这样嵌进来的。
    const inputs = Number(stats?.domInputs) - Number(stats?.typeHidden || 0) - Number(stats?.nonFillable || 0);
    if (probe.shadowHosts > 0 || probe.frames?.frameInputs > 0 || probe.custom?.total > 0 || inputs >= FORM_INPUTS) {
      return { type: "application_form", reason: "structure" };
    }
    return { type: "unknown", reason: "none" };
  }

  // 扫描到 0 个字段，或扫描到字段但一个都没填上时，按最可能的原因告诉用户下一步怎么做。
  // notForm：pageType() 判断这不是网申填写页。
  function emptyPageHint(probe, { notForm = false } = {}) {
    if (!probe) return "";
    if (probe.editButtons > 0) return "这个页面可能还在查看状态：请先点网页上的「编辑」，等输入框出现后再一键填写。";
    if (probe.locked > 0) return "网页上的输入框目前是只读或禁用的：请先点「编辑」或完成网页要求的上一步，再一键填写。";
    if (notForm) {
      // 跨域框架不算表单的证据，但也可能就是申请表：两种可能都告诉用户。
      return `这个页面看起来不是网申填写页：请打开要填写的申请表页面，再一键填写。${probe.frames?.crossOrigin > 0
        ? "如果申请表就在这个页面的内嵌框架里，插件暂时读不到。" : ""}`;
    }
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

  const api = { SELECTORS, describeControl, safeLabel, probePage, pageType, emptyPageHint, formatReport };
  root.ResumeProFillProbe = api;
  if (typeof module !== "undefined") module.exports = api;
})(typeof self !== "undefined" ? self : globalThis);

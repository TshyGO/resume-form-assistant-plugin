// #224 页面大纲：「深度分析本页」发给强模型的只有这份文字大纲。
// 遍历主文档、开放的 Shadow DOM 和同源 iframe 里看得见的控件、短按钮和题目/分组文字，
// 给每个候选分配临时编号（e1、e2…）。编号和元素的对应只放在返回值的内存里，不写进网页 DOM。
// 从不读取输入框的值；密码框、文件框、验证码一类整体跳过；所有文字都过同一套脱敏。
(function attachResumeProPageOutline(scope) {
  const MAX_SEGMENT = 40;
  const MAX_CHARS = 40000;
  const MAX_PARTS = 3;
  const MAX_BUTTON_TEXT = 12;
  const MAX_OPTIONS = 6;
  const MAX_OPTION_TEXT = 12;
  const MAX_ELEMENTS = 30000;
  const MAX_SCOPE_DEPTH = 6;
  const REDACTED = "〔内容〕";

  const LIBRARIES = [["antd", /^ant-/], ["element", /^el-/], ["arco", /^arco-/], ["iview", /^ivu-/],
    ["semi", /^semi-/], ["vant", /^van-/], ["layui", /^layui-/]];
  const BUTTON_SELECTOR = "button, a[href], [role='button'], [role='link'], input[type='button'], input[type='submit'], input[type='reset']";
  const ARIA_CONTROL_SELECTOR = "[contenteditable]:not([contenteditable='false']), [role='textbox'], [role='listbox'], [role='radiogroup'], [role='switch'], [role='spinbutton'], [role='checkbox']";
  const TEXT_CLUE_SELECTOR = "label, legend, th, dt, [role='heading'], h1, h2, h3, h4, h5, h6, caption";
  const HEADING_SELECTOR = "h1, h2, h3, h4, h5, h6, legend, caption, [role='heading']";
  // 和 profile-fields.js、协议的密钥检查一致：像凭据的文字一律不外发。
  const SECRET_LABEL = /密码|口令|验证码|校验码|授权码|密钥|私钥|令牌|password|passwd|captcha|token|secret/i;
  const SENSITIVE_AUTOCOMPLETE = /one-time-code|cc-|password/i;
  const CREDENTIAL_TEXT = /(?:^|[^a-z0-9])(?:sk-[a-z0-9_-]{8,}|bearer\s|apikey|api[_-]key|authorization|cookie|set-cookie|password|passwd|pwd|otp|token|secret)\b/i;
  const SECRET_VALUE = /(密码|口令|验证码|校验码|授权码|密钥|令牌|password|passwd|pwd|token|secret)\s*[:=：]\s*\S/i;

  const squash = text => String(text ?? "").replace(/\s+/g, " ").trim();
  const normalizeForOverlap = text => String(text ?? "").normalize("NFKC").replace(/\s+/g, "").toLowerCase();
  const chars = text => Array.from(String(text ?? ""));
  const clip = (text, max) => {
    const list = chars(text);
    return list.length > max ? `${list.slice(0, max - 1).join("")}…` : list.join("");
  };

  // 同一套脱敏：大纲里的标签和文字、说明书里的 label/group 都用它。
  // 命中联系方式、证件号、网址、凭据，或者和任意一条简历值重叠，整段换成「〔内容〕」。
  function createRedactor(resumeValues = []) {
    const values = Array.from(new Set((resumeValues || []).map(normalizeForOverlap).filter(value => value.length >= 2)));
    return function redact(text, max = MAX_SEGMENT) {
      const value = squash(text);
      if (!value) return "";
      if (sensitiveShape(value)) return REDACTED;
      const normalized = normalizeForOverlap(value);
      if (values.some(item => normalized.includes(item) || (normalized.length >= 2 && item.includes(normalized) && normalized.length >= item.length / 2))) {
        return REDACTED;
      }
      return clip(value, max);
    };
  }

  function sensitiveShape(value) {
    if (/[@＠]|(?:https?|wss?|ftp):\/\/|www\./i.test(value)) return true;
    // 去掉空白和标点后连着 5 位以上数字（手机号、证件号、学号、银行卡），全角数字也算。
    if (/[0-9０-９]{5,}/.test(value.replace(/[\s\p{P}\p{S}]/gu, ""))) return true;
    // 18 位身份证末位的 X，和 5 位以上数字已经覆盖；再挡一次夹着字母的长串（像令牌或密钥）。
    if (/[A-Za-z0-9_-]{24,}/.test(value) && /\d/.test(value) && /[A-Za-z]/.test(value)) return true;
    return SECRET_VALUE.test(value) || CREDENTIAL_TEXT.test(value);
  }

  function attr(el, name) {
    return String(el?.getAttribute?.(name) ?? "");
  }

  function libraryOf(el) {
    for (let current = el, depth = 0; current && depth <= 4; current = current.parentElement, depth += 1) {
      const tokens = typeof current.className === "string" ? current.className.split(/\s+/) : [];
      for (const token of tokens) {
        const hit = LIBRARIES.find(([, pattern]) => pattern.test(token));
        if (hit) return hit[0];
      }
    }
    return "";
  }

  function defaultVisible(el) {
    if (!el?.getClientRects || !el.getClientRects().length) return false;
    const view = el.ownerDocument?.defaultView;
    const css = view?.getComputedStyle?.(el);
    return !css || (css.display !== "none" && css.visibility !== "hidden");
  }

  function isSecretControl(control) {
    return control.elements.some(el => {
      const type = String(el.getAttribute?.("type") || "").toLowerCase();
      return type === "password" || SENSITIVE_AUTOCOMPLETE.test(attr(el, "autocomplete"));
    }) || SECRET_LABEL.test([control.label, attr(control.element, "name"), attr(control.element, "placeholder"),
      attr(control.element, "aria-label")].join(" "));
  }

  // 只看结构的控件类型。原生控件以 DOM 为准，模型给的说法不能改它。
  function domKindOf(control) {
    const el = control.element;
    if (control.kind === "radio") return "radio";
    const tag = String(el?.tagName || "").toUpperCase();
    if (tag === "SELECT") return "native-select";
    if (tag === "TEXTAREA") return "textarea";
    const type = tag === "INPUT" ? String(el.getAttribute("type") || "text").toLowerCase() : "";
    if (type === "checkbox") return "checkbox";
    if (["date", "month", "datetime-local", "time", "week"].includes(type)) return "date";
    if (control.controlKind === "date-picker") return "date";
    if (control.controlKind === "custom-select" || control.controlKind === "cascader") return control.controlKind;
    if (control.controlKind === "contenteditable") return "contenteditable";
    return tag === "INPUT" ? "text" : "unsupported";
  }

  function describeKind(entry) {
    const el = entry.element;
    switch (entry.domKind) {
      case "radio": return "radio-group";
      case "native-select": return el.multiple ? "select[multiple]" : "select";
      case "textarea": return "textarea";
      case "checkbox": return "checkbox";
      case "date": return entry.pickerType ? "date-picker" : `input[${String(el.getAttribute("type") || "date").toLowerCase()}]`;
      case "custom-select": return "combobox";
      case "cascader": return "cascader";
      case "contenteditable": return "contenteditable";
      case "text": return `input[${String(el.getAttribute("type") || "text").toLowerCase()}]`;
      default: return `role=${attr(el, "role") || el.tagName.toLowerCase()}`;
    }
  }

  function radioOptionText(radio) {
    const label = radio.labels?.[0] || radio.closest?.("label");
    const text = squash(label ? label.textContent : radio.nextSibling?.textContent);
    return text || squash(radio.getAttribute("aria-label"));
  }

  function buttonText(el) {
    if (el.tagName === "INPUT") return squash(el.getAttribute("value") || el.getAttribute("aria-label"));
    return squash(el.textContent) || squash(el.getAttribute("aria-label")) || squash(el.getAttribute("title"));
  }

  // 链接是否会离开当前页面：同页锚点和 javascript: 不算。
  function leavesPage(el) {
    const anchor = el.closest?.("a[href], area[href]");
    if (!anchor) return false;
    const raw = String(anchor.getAttribute("href") || "").trim();
    if (!raw || raw.startsWith("#") || /^javascript:/i.test(raw)) return false;
    try {
      const doc = anchor.ownerDocument;
      const target = new URL(raw, doc.baseURI);
      const here = new URL(doc.URL);
      return target.origin !== here.origin || target.pathname !== here.pathname || target.search !== here.search;
    } catch {
      return true;
    }
  }

  function isSubmitLike(el) {
    if (!["BUTTON", "INPUT"].includes(el.tagName)) return false;
    const type = String(el.getAttribute("type") || (el.tagName === "BUTTON" ? "submit" : "")).toLowerCase();
    // 不写 type 的 <button> 只有在 form 里才会提交。
    if (el.tagName === "BUTTON" && !el.hasAttribute("type")) return Boolean(el.closest("form"));
    return ["submit", "reset", "image"].includes(type);
  }

  // 一个作用域（文档或开放 Shadow root）里的候选，按出现顺序排好。嵌套的作用域在它的宿主位置展开。
  function collectScope(root, ctx, depth) {
    const fieldScan = ctx.fieldScan;
    const items = [];
    const anchor = new Map();
    const add = (el, item) => {
      if (!anchor.has(el)) anchor.set(el, []);
      anchor.get(el).push(item);
    };
    const claimedControls = new Set();
    // 已经归进某个控件的节点（控件本身、组件根）：按祖先链查，避免大页面上两两比较。
    const insideClaimed = el => {
      for (let node = el, depth = 0; node && depth < 12; node = node.parentElement, depth += 1) {
        if (claimedControls.has(node)) return true;
      }
      return false;
    };

    let controls = [];
    try {
      controls = fieldScan?.outlineControls ? fieldScan.outlineControls(root, { isVisible: ctx.isVisible, exclude: ctx.exclude }) : [];
    } catch {
      controls = [];
    }
    for (const control of controls) {
      control.elements.forEach(el => claimedControls.add(el));
      claimedControls.add(control.root);
      if (control.controlKind === "file") { ctx.stats.skippedFile += 1; continue; }
      if (isSecretControl(control)) { ctx.stats.skippedSecret += 1; continue; }
      const entry = { type: "control", control, element: control.element, elements: control.elements, root: control.root,
        pickerType: control.pickerType, domKind: domKindOf(control), frame: ctx.frame };
      add(control.root, entry);
    }

    // 网页自己写的富文本框、ARIA 控件：field-scan 不收它们，这里作为结构线索列出。
    for (const el of Array.from(root.querySelectorAll(ARIA_CONTROL_SELECTOR))) {
      if (insideClaimed(el) || el.querySelector?.("input, select, textarea")) continue;
      if (ctx.exclude(el) || !ctx.isVisible(el)) continue;
      if (el.parentElement?.closest?.(ARIA_CONTROL_SELECTOR)) continue;
      const editable = el.isContentEditable || attr(el, "role") === "textbox";
      const control = { kind: "element", controlKind: editable ? "contenteditable" : "aria", element: el, elements: [el], root: el,
        label: squash(attr(el, "aria-label")), section: "", disabled: attr(el, "aria-disabled") === "true" };
      if (isSecretControl(control)) { ctx.stats.skippedSecret += 1; continue; }
      add(el, { type: "control", control, element: el, elements: [el], root: el, pickerType: "",
        domKind: editable ? "contenteditable" : "unsupported", frame: ctx.frame });
    }

    for (const el of Array.from(root.querySelectorAll(BUTTON_SELECTOR))) {
      if (ctx.exclude(el) || !ctx.isVisible(el)) continue;
      if (insideClaimed(el)) continue;
      const text = buttonText(el);
      if (!text || chars(text).length > MAX_BUTTON_TEXT) continue;
      add(el, { type: "button", element: el, text, submit: isSubmitLike(el), leaves: leavesPage(el),
        link: el.tagName === "A" || attr(el, "role") === "link", frame: ctx.frame });
    }

    for (const el of Array.from(root.querySelectorAll(TEXT_CLUE_SELECTOR))) {
      if (ctx.exclude(el) || !ctx.isVisible(el)) continue;
      // 和控件连着的 label 已经是那个控件的题目，不再单列。
      if (el.querySelector?.("input, select, textarea, [role='combobox']") || (el.tagName === "LABEL" && el.htmlFor)) continue;
      if (insideClaimed(el)) continue;
      const text = squash(el.textContent);
      if (!text || chars(text).length > MAX_SEGMENT * 2) continue;
      add(el, { type: el.matches(HEADING_SELECTOR) ? "heading" : "text", element: el, text });
    }

    // 文档顺序：querySelectorAll("*") 本身就按顺序；宿主元素后面接着展开它的 Shadow root 或框架。
    const all = Array.from(root.querySelectorAll("*"));
    for (const el of all) {
      if (ctx.items >= MAX_ELEMENTS) { ctx.stats.elementCapped = true; break; }
      ctx.items += 1;
      for (const item of anchor.get(el) || []) items.push(item);
      if (depth >= MAX_SCOPE_DEPTH) continue;
      if (el.shadowRoot && !ctx.exclude(el)) {
        ctx.stats.shadowRoots += 1;
        items.push(...collectScope(el.shadowRoot, ctx, depth + 1));
      }
      if ((el.tagName === "IFRAME" || el.tagName === "FRAME") && !ctx.exclude(el)) {
        let inner = null;
        try { inner = el.contentDocument; } catch { inner = null; }
        if (!inner || !inner.documentElement) { ctx.stats.crossOriginFrames += 1; continue; }
        if (!ctx.isVisible(el)) continue;
        ctx.stats.frames += 1;
        const frameNo = ctx.stats.frames;
        const outer = ctx.frame;
        ctx.frame = frameNo;
        items.push({ type: "frame", frame: frameNo });
        items.push(...collectScope(inner, ctx, depth + 1));
        items.push({ type: "frame-end", frame: frameNo });
        ctx.frame = outer;
      }
    }
    return items;
  }

  // 一个候选写成一行。所有来自网页的文字都先脱敏、截断到 40 字。
  function lineFor(item, redact) {
    if (item.type === "button") {
      const kind = item.link ? "link" : item.submit ? "button[submit]" : "button";
      return `${item.ref} ${kind} "${redact(item.text, MAX_BUTTON_TEXT)}"${item.leaves ? " 跨页" : ""}`;
    }
    const control = item.control;
    const el = item.element;
    const parts = [item.ref, describeKind(item)];
    const library = libraryOf(item.root || el);
    if (library) parts.push(`lib=${library}`);
    const placeholder = attr(el, "placeholder");
    if (placeholder) parts.push(`ph="${redact(placeholder, MAX_SEGMENT)}"`);
    if (item.domKind === "radio") {
      const options = control.elements.map(radioOptionText).filter(Boolean).slice(0, MAX_OPTIONS)
        .map(text => redact(text, MAX_OPTION_TEXT));
      if (options.length) parts.push(`选项="${options.join("/")}"`);
    }
    if (item.domKind === "checkbox") {
      const own = radioOptionText(el);
      if (own && own !== control.label) parts.push(`"${redact(own, MAX_SEGMENT)}"`);
    }
    if (control.disabled) parts.push("禁用");
    else if (el.readOnly && !["custom-select", "cascader", "date"].includes(item.domKind)) parts.push("只读");
    if (el.getAttribute?.("aria-required") === "true" || el.required) parts.push("必填");
    if (control.chrome) parts.push("页头");
    if (item.domKind === "unsupported") parts.push("暂不支持");
    const label = control.label || attr(el, "aria-label");
    return `${parts.join(" ")}${label ? ` ← ${redact(label, MAX_SEGMENT)}` : ""}`;
  }

  // 把候选排成区块。区块标题取最近的标题文字，字段自己的区块（field-scan 判断的）优先。
  // 题目一类的文字先暂存，跟着下一个控件进同一个区块；和某个控件题目相同的不再重复列出。
  function toBlocks(items, redact) {
    const blocks = [];
    let current = null;
    let pending = [];
    const labels = new Set(items.filter(item => item.type === "control" && item.control?.label)
      .map(item => normalizeForOverlap(item.control.label)));
    const open = (title, frame = null) => {
      current = { title, frame, lines: [], refs: [] };
      blocks.push(current);
    };
    const flush = () => {
      if (!pending.length) return;
      if (!current) open("", null);
      current.lines.push(...pending);
      pending = [];
    };
    for (const item of items) {
      if (item.type === "frame") { flush(); open(`同源框架 ${item.frame}`, item.frame); continue; }
      if (item.type === "frame-end") { flush(); open("", null); continue; }
      if (item.type === "heading") {
        const title = redact(item.text);
        if (title && title !== current?.title) { flush(); open(title, current?.frame ?? null); }
        continue;
      }
      if (item.type === "text") {
        if (labels.has(normalizeForOverlap(item.text))) continue;
        const text = redact(item.text);
        if (text) pending.push({ text: `文字 "${text}"`, clue: true, shape: "text" });
        continue;
      }
      if (!current) open("", null);
      const section = item.control?.section ? redact(item.control.section) : "";
      if (section && section !== current.title && current.lines.some(line => !line.clue)) open(section, current.frame);
      else if (section && !current.title) current.title = section;
      flush();
      const text = lineFor(item, redact);
      current.lines.push({ text, ref: item.ref, shape: text.replace(/^e\d+\s/, ""), clue: false });
      current.refs.push(item.ref);
    }
    flush();
    return blocks.filter(block => block.lines.length);
  }

  function blockText(block) {
    const header = block.title ? `[区块] ${block.title}` : "[区块]";
    return [header, ...block.lines.map(line => `  ${line.text}`)].join("\n");
  }

  const totalChars = blocks => blocks.reduce((sum, block) => sum + blockText(block).length + 1, 0);

  // 超长时依次：去掉离控件远的文字 → 折叠重复的结构 → 按区块拆成最多 3 份 → 仍放不下就只留前 3 份。
  function fitBlocks(blocks, maxChars, maxParts, stats) {
    let working = blocks.map(block => ({ ...block, lines: [...block.lines], refs: [...block.refs] }));
    if (totalChars(working) > maxChars) {
      for (const block of working) {
        const before = block.lines.length;
        block.lines = block.lines.filter(line => !line.clue);
        stats.droppedText += before - block.lines.length;
      }
      working = working.filter(block => block.lines.length);
    }
    if (totalChars(working) > maxChars) {
      // 同一区块里连续 3 行以上结构相同（表格的每一行、一长串勾选框）：保留前 3 行。
      for (const block of working) {
        const kept = [];
        for (let i = 0; i < block.lines.length;) {
          let j = i + 1;
          while (j < block.lines.length && block.lines[j].shape === block.lines[i].shape) j += 1;
          const run = block.lines.slice(i, j);
          if (run.length > 3) {
            kept.push(...run.slice(0, 3), { text: `…同结构 ${run.length - 3} 行`, clue: true, shape: "collapsed" });
            stats.collapsed += run.length - 3;
          } else kept.push(...run);
          i = j;
        }
        block.lines = kept;
        block.refs = kept.filter(line => line.ref).map(line => line.ref);
      }
    }
    if (totalChars(working) > maxChars) {
      // 标题和行结构都跟前一个区块一样的重复条目区块（教育经历 1、2、3…）：只留第一个。
      const kept = [];
      for (const block of working) {
        const previous = kept[kept.length - 1];
        const key = b => `${String(b.title).replace(/[0-9０-９一二三四五六七八九十]+/g, "#")}\n${b.lines.map(l => l.shape).join("\n")}`;
        if (previous && key(previous) === key(block)) {
          previous.repeats = (previous.repeats || 0) + 1;
          stats.collapsed += block.refs.length;
          continue;
        }
        kept.push(block);
      }
      for (const block of kept) {
        if (block.repeats) block.lines.push({ text: `…同结构 ${block.repeats} 组`, clue: true, shape: "collapsed" });
      }
      working = kept;
    }

    const parts = [];
    let current = [];
    let size = 0;
    for (const block of working) {
      let text = blockText(block);
      if (text.length + 1 > maxChars) {
        // 单个区块就超过上限：按行截断，后面的行算超出范围。
        const lines = [];
        let length = 0;
        for (const line of block.lines) {
          if (length + line.text.length + 3 > maxChars - 200) break;
          lines.push(line);
          length += line.text.length + 3;
        }
        stats.truncated = true;
        block.lines = lines;
        block.refs = lines.filter(line => line.ref).map(line => line.ref);
        text = blockText(block);
      }
      if (size + text.length + 1 > maxChars && current.length) {
        parts.push(current);
        current = [];
        size = 0;
      }
      current.push(block);
      size += text.length + 1;
    }
    if (current.length) parts.push(current);
    if (parts.length > maxParts) {
      stats.truncated = true;
      stats.droppedParts = parts.length - maxParts;
    }
    return parts.slice(0, maxParts).map(list => ({
      text: list.map(blockText).join("\n"),
      refs: list.flatMap(block => block.refs)
    }));
  }

  // 生成大纲。options：isVisible、exclude（跳过插件自己的界面）、resumeValues（脱敏用）、
  // fieldScan（content 里是 self.ResumeProFieldScan）、maxChars、maxParts。
  function build(doc, options = {}) {
    const redact = createRedactor(options.resumeValues || []);
    const stats = { candidates: 0, controls: 0, buttons: 0, frames: 0, crossOriginFrames: 0, shadowRoots: 0,
      skippedSecret: 0, skippedFile: 0, droppedText: 0, collapsed: 0, droppedParts: 0, truncated: false,
      elementCapped: false, chars: 0, parts: 0 };
    const isVisible = el => {
      try { return Boolean((options.isVisible || defaultVisible)(el)); } catch { return false; }
    };
    const exclude = el => {
      try { return Boolean(options.exclude?.(el)); } catch { return false; }
    };
    const ctx = { fieldScan: options.fieldScan || scope.ResumeProFieldScan, isVisible, exclude, stats, items: 0, frame: null };
    const items = collectScope(doc, ctx, 0);
    const nodes = new Map();
    let next = 1;
    for (const item of items) {
      if (item.type !== "control" && item.type !== "button") continue;
      item.ref = `e${next++}`;
      nodes.set(item.ref, item);
      if (item.type === "control") stats.controls += 1;
      else stats.buttons += 1;
    }
    stats.candidates = nodes.size;
    const blocks = toBlocks(items, redact);
    const parts = fitBlocks(blocks, options.maxChars || MAX_CHARS, options.maxParts || MAX_PARTS, stats);
    stats.parts = parts.length;
    stats.chars = parts.reduce((sum, part) => sum + part.text.length, 0);
    return { parts, nodes, stats, redact };
  }

  const api = { MAX_SEGMENT, MAX_CHARS, MAX_PARTS, REDACTED, build, createRedactor, sensitiveShape, domKindOf };
  scope.ResumeProPageOutline = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})(typeof self !== "undefined" ? self : globalThis);

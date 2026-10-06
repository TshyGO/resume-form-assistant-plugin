// #228 网页字段扫描：一键填写和「加到我的信息」共用。
// 只读页面结构，不读也不记字段值。先把控件归并成逻辑控件（自定义下拉连同内部输入算一个），
// 再找每个控件所在的最小表单项，题目只从明确关联或这一项里取，不跨到别的题目借字。
// 占位文字、字数计数器、帮助说明、校验错误都不能当字段名；对不上题目的控件直接跳过。
(function attachResumeProFieldScan(globalScope) {
  const CONTROL_SELECTOR = "input, textarea, select";
  const NON_CONTROL_TYPES = new Set(["hidden", "button", "submit", "reset", "image"]);
  const DATE_TYPES = new Set(["date", "month", "time", "datetime-local", "week"]);
  // 这几类控件的自带文字是选项本身，不能当题目。
  const CHOICE_TYPES = new Set(["radio", "checkbox"]);

  const MAX_LABEL_CHARS = 200;
  // 超过这个长度的整段文字已经不像题目，宁可跳过。
  const MAX_LOOSE_TEXT_CHARS = 400;
  const MAX_SECTION_CHARS = 40;
  const MAX_OFFER_CHARS = 120;

  const LANDMARK_SELECTOR = "nav, [role='navigation'], [role='banner'], [role='search'], [role='menubar'], [role='toolbar'], [role='contentinfo']";
  // header/footer 只有不在这些内容区块里时才是页头页脚。
  const CONTENT_SCOPE_SELECTOR = "form, [role='form'], main, [role='main'], article, section, dialog, [role='dialog']";
  const CHROME_TOKENS = new Set(["header", "navbar", "nav", "navigation", "topbar", "top-bar", "site-header", "site-nav",
    "page-header", "global-header", "app-header", "main-header", "layout-header", "ant-layout-header", "el-header",
    "top-nav", "main-nav", "menu-bar"]);
  const POPUP_SELECTOR = "[role='listbox'], [role='tree'], [role='menu'], [role='option']";
  const POPUP_TOKEN = /[-_](?:dropdown|popper|popover|popup)(?:[-_]?(?:menu|panel|content|wrapper|list|inner))?$|^(?:dropdown-menu|popper|popover)$/i;
  const DATE_PICKER_SELECTOR = ".ant-picker, .el-date-editor, [class*='date-picker'], [class*='datepicker'], [class*='DatePicker'], [class*='date-editor']";
  const SELECT_TOKEN = /(?:^|[-_])(?:select|selector|cascader|combobox|combo|dropdown|autocomplete|treeselect|multiselect|picker)(?:$|[-_])/i;
  const LIBRARY_SELECT_TOKENS = new Set(["ant-select", "ant-cascader", "el-select", "el-cascader", "arco-select", "arco-cascader",
    "ivu-select", "ivu-cascader", "n-select", "n-cascader", "t-select", "t-cascader", "v-select", "select2-container", "chosen-container"]);
  const NOISE_TOKEN = /^(?:error|err|invalid|explain|help|helper|tip|tips|hint|extra|count|counter|wordcount|limit|message|msg|feedback|warning|validate|validation|suffix|prefix|placeholder|unit)$/i;
  const LABEL_TOKEN = /^(?:label|title|question|caption|subject|stem|tit|head|heading)$/i;
  const HEADING_TOKEN = /^(?:title|header|heading|head|caption|subtitle|tit)$/i;
  const SKIPPED_TEXT_TAGS = new Set(["SCRIPT", "STYLE", "NOSCRIPT", "TEMPLATE", "SVG", "BUTTON", "SELECT", "TEXTAREA", "INPUT", "OPTION", "DATALIST"]);
  const SKIPPED_TEXT_ROLES = new Set(["button", "alert", "status", "tooltip", "log", "timer", "progressbar"]);

  const COUNTER_WORDS = /^(?:已输入|已填写?|还可(?:以)?输入|还能输入|剩余|最多(?:输入)?|限)\s*\d*\s*(?:[\/／]\s*\d+)?\s*个?(?:字|字符|词)?$/;
  const GENERIC_PROMPT = /^(?:请)?(?:选择|输入|填写|上传|搜索|选取|点击选择)(?:日期|时间|内容|文件)?$|^(?:请选择日期|请选择时间|全部|暂无数据|无匹配数据|加载中|no data|loading|select|please select|search|choose)$/i;
  const ERROR_TAIL = /(?:不能为空|不可为空|不能为空白|为必填项?|是必填项|必须填写|必填项|格式不正确|格式错误|不合法|超出字数限制|超过最大长度)[!！。.]?$/;
  const MARKER = /^(?:必填|选填|可选|非必填|optional|required)$/i;
  const NO_WORDS = /^[\d\s\/／\\|.,，。、:：;；*＊()（）\[\]【】<>《》+\-_~#%·…!！?？'"“”‘’]+$/;
  const SEARCH_HINT = /搜索|查找|检索|关键词|关键字|search|keyword/i;
  const CJK = /[　-鿿＀-￯]/;

  function classTokens(el) {
    return String(el?.getAttribute?.("class") || "").split(/\s+/).filter(Boolean);
  }

  function attr(el, name) {
    return String(el?.getAttribute?.(name) || "");
  }

  function inputType(el) {
    return el.tagName === "INPUT" ? String(el.getAttribute("type") || "text").toLowerCase() : "";
  }

  function isControlElement(el) {
    if (!el || !["INPUT", "TEXTAREA", "SELECT"].includes(el.tagName)) return false;
    return !NON_CONTROL_TYPES.has(inputType(el));
  }

  function hasComboSignal(el) {
    const role = attr(el, "role").toLowerCase();
    const popup = attr(el, "aria-haspopup").toLowerCase();
    const autocomplete = attr(el, "aria-autocomplete").toLowerCase();
    return role === "combobox" || (popup && popup !== "false") || autocomplete === "list" || autocomplete === "both";
  }

  function looksSearchLike(el) {
    if (inputType(el) === "search" || attr(el, "role").toLowerCase() === "searchbox") return true;
    return SEARCH_HINT.test([attr(el, "placeholder"), attr(el, "aria-label"), attr(el, "name"), el.id || "", attr(el, "title"), attr(el, "class")].join(" "));
  }

  // --- 文字清理 ---------------------------------------------------------------

  function squash(text) {
    return String(text ?? "").replace(/\s+/g, " ").trim();
  }

  function isNoiseText(text, placeholders = []) {
    const value = squash(text);
    if (!value) return true;
    if (NO_WORDS.test(value)) return true;
    if (COUNTER_WORDS.test(value) || GENERIC_PROMPT.test(value) || ERROR_TAIL.test(value) || MARKER.test(value)) return true;
    return placeholders.some((placeholder) => placeholder && squash(placeholder) === value);
  }

  function cleanLabel(text, placeholders = []) {
    let value = squash(text)
      .replace(/[（(]\s*(?:必填|选填|可选|非必填|optional|required)\s*[)）]/gi, "")
      .replace(/^[*＊\s]+|[*＊\s]+$/g, "")
      .replace(/[:：]\s*$/, "")
      .replace(/^[*＊\s]+|[*＊\s]+$/g, "")
      .trim();
    if (isNoiseText(value, placeholders)) return "";
    if (value.length > MAX_LABEL_CHARS) value = `${value.slice(0, MAX_LABEL_CHARS - 1)}…`;
    return value;
  }

  function joinSegments(segments) {
    let out = "";
    for (const segment of segments) {
      const text = segment.text;
      if (!out) {
        out = text;
      } else if (CJK.test(out.slice(-1)) || CJK.test(text[0])) {
        out += text;
      } else {
        out += ` ${text}`;
      }
    }
    return out;
  }

  // --- 页面结构 ---------------------------------------------------------------

  function makeContext(doc, options = {}) {
    const visibility = new Map();
    const isVisible = (el) => {
      if (!el || el.nodeType !== 1) return false;
      if (!visibility.has(el)) {
        let visible = true;
        try {
          visible = options.isVisible ? Boolean(options.isVisible(el)) : true;
        } catch {
          visible = false;
        }
        visibility.set(el, visible);
      }
      return visibility.get(el);
    };
    const excluded = (el) => {
      try {
        return Boolean(options.exclude?.(el));
      } catch {
        return false;
      }
    };
    return { doc, body: doc.body, isVisible, excluded, boundaries: null };
  }

  // 最小表单项的边界：页面上所有可见的真实控件（含禁用、文件、单选、勾选）。
  function boundaryControls(ctx) {
    if (!ctx.boundaries) {
      ctx.boundaries = new Set(Array.from(ctx.doc.querySelectorAll(CONTROL_SELECTOR))
        .filter((el) => isControlElement(el) && !ctx.excluded(el) && ctx.isVisible(el) && !isPopupInternal(el, ctx)));
    }
    return ctx.boundaries;
  }

  function hasForeignControl(container, root, ctx) {
    const boundaries = boundaryControls(ctx);
    for (const el of container.querySelectorAll(CONTROL_SELECTOR)) {
      if (boundaries.has(el) && !root.contains(el)) return true;
    }
    return false;
  }

  function containsBoundary(container, ctx) {
    const boundaries = boundaryControls(ctx);
    if (boundaries.has(container)) return true;
    for (const el of container.querySelectorAll?.(CONTROL_SELECTOR) || []) {
      if (boundaries.has(el)) return true;
    }
    return false;
  }

  function isPageChrome(el) {
    if (el.closest(LANDMARK_SELECTOR)) return true;
    const pageEdge = el.closest("header, footer");
    if (pageEdge && !pageEdge.parentElement?.closest(CONTENT_SCOPE_SELECTOR)) return true;
    for (let node = el.parentElement; node && node.tagName !== "BODY"; node = node.parentElement) {
      const tokens = [...classTokens(node), node.id || ""].map((token) => token.toLowerCase());
      if (tokens.some((token) => CHROME_TOKENS.has(token)) && !node.querySelector("form, [role='form']")) return true;
    }
    return false;
  }

  function popupHosts(ctx) {
    if (!ctx.popupHosts) {
      ctx.popupHosts = new Set();
      ctx.doc.querySelectorAll("[aria-controls], [aria-owns]").forEach((owner) => {
        if (!hasComboSignal(owner)) return;
        `${attr(owner, "aria-controls")} ${attr(owner, "aria-owns")}`.split(/\s+/).filter(Boolean).forEach((id) => {
          const popup = ctx.doc.getElementById(id);
          if (popup && !popup.contains(owner)) ctx.popupHosts.add(popup);
        });
      });
    }
    return ctx.popupHosts;
  }

  // 下拉弹层里的搜索框：属于那个下拉，不是独立题目。触发下拉的那个输入本身不算。
  function isPopupInternal(el, ctx) {
    if (el.tagName !== "INPUT" || hasComboSignal(el) || el.readOnly) return false;
    if (el.closest(POPUP_SELECTOR)) return true;
    const hosts = popupHosts(ctx);
    for (let node = el.parentElement; node && node.tagName !== "BODY"; node = node.parentElement) {
      if (hosts.has(node) || classTokens(node).some((token) => POPUP_TOKEN.test(token))) return true;
    }
    return false;
  }

  // 组件根只能装同一个控件的几个文字输入框，装了别的题目就说明走过头了。
  function componentScopeOk(node, ctx, maxInputs) {
    const boundaries = boundaryControls(ctx);
    let inputs = 0;
    for (const el of node.querySelectorAll(CONTROL_SELECTOR)) {
      if (!boundaries.has(el)) continue;
      if (el.tagName !== "INPUT" || CHOICE_TYPES.has(inputType(el)) || inputType(el) === "file") return false;
      inputs += 1;
    }
    return inputs <= maxInputs;
  }

  // 取 5 层以内最外层的日期组件容器：range picker 的两个输入框共用一个根。
  function datePickerRoot(el, ctx) {
    let best = null;
    let node = el.parentElement;
    for (let depth = 0; node && node !== ctx.body && depth < 5; depth += 1, node = node.parentElement) {
      if (!node.matches(DATE_PICKER_SELECTOR)) continue;
      if (!componentScopeOk(node, ctx, 2)) break;
      best = node;
    }
    return best;
  }

  function pickerTypeOf(root) {
    if (root.closest(".ant-picker") || root.matches(".ant-picker") || root.querySelector?.(".ant-picker")) return "antd";
    if (root.closest(".el-date-editor") || root.matches(".el-date-editor")) return "element";
    return "generic";
  }

  // 自定义下拉、级联、自动完成：取最外层像组件根、又只装着这个控件的祖先。
  function customSelectRoot(el, ctx) {
    const ownSignal = hasComboSignal(el);
    let best = null;
    let node = el.parentElement;
    for (let depth = 0; node && node !== ctx.body && depth < 5; depth += 1, node = node.parentElement) {
      const tokens = classTokens(node);
      const tokenMatch = tokens.some((token) => SELECT_TOKEN.test(token));
      const ariaMatch = hasComboSignal(node);
      if (!tokenMatch && !ariaMatch) continue;
      if (!componentScopeOk(node, ctx, 3)) break;
      const library = tokens.some((token) => LIBRARY_SELECT_TOKENS.has(token.toLowerCase()));
      if (ariaMatch || library || ownSignal || el.readOnly || inputType(el) === "search"
        || node.querySelector("[role='combobox'], [aria-haspopup]:not([aria-haspopup='false']), input[readonly]")) {
        best = node;
      }
    }
    if (!best && ownSignal) best = el;
    return best;
  }

  function primaryInput(inputs) {
    return inputs.find(hasComboSignal) || inputs.find((input) => input.readOnly) || inputs[0];
  }

  function lowestCommonAncestor(elements) {
    if (!elements.length) return null;
    let candidate = elements[0].parentElement;
    while (candidate && !elements.every((el) => candidate.contains(el))) candidate = candidate.parentElement;
    return candidate;
  }

  // 把可见控件归并成逻辑控件。
  function collectLogicalControls(ctx) {
    const boundaries = boundaryControls(ctx);
    const controls = [];
    const customByRoot = new Map();
    const radiosByName = new Map();
    const pickerInputs = new Map();

    for (const el of boundaries) {
      const type = inputType(el);
      if (type === "radio") {
        const scope = el.form || el.closest("[role='radiogroup'], fieldset") || null;
        const key = el.name ? `name:${el.name}` : null;
        const groupKey = key || el.closest("[role='radiogroup'], fieldset") || el;
        if (!radiosByName.has(groupKey)) radiosByName.set(groupKey, []);
        radiosByName.get(groupKey).push({ el, scope });
        continue;
      }
      if (el.tagName === "SELECT") {
        controls.push({ kind: "element", controlKind: "select", element: el, elements: [el], root: el });
        continue;
      }
      if (el.tagName === "TEXTAREA") {
        controls.push({ kind: "element", controlKind: "textarea", element: el, elements: [el], root: el });
        continue;
      }
      if (type === "checkbox" || type === "file") {
        controls.push({ kind: "element", controlKind: type, element: el, elements: [el], root: el });
        continue;
      }
      if (DATE_TYPES.has(type)) {
        controls.push({ kind: "element", controlKind: "date", element: el, elements: [el], root: el });
        continue;
      }
      const picker = datePickerRoot(el, ctx);
      if (picker) {
        if (!pickerInputs.has(picker)) pickerInputs.set(picker, []);
        pickerInputs.get(picker).push(el);
        continue;
      }
      const selectRoot = customSelectRoot(el, ctx);
      if (selectRoot) {
        if (!customByRoot.has(selectRoot)) customByRoot.set(selectRoot, []);
        customByRoot.get(selectRoot).push(el);
        continue;
      }
      controls.push({ kind: "element", controlKind: "text", element: el, elements: [el], root: el });
    }

    customByRoot.forEach((inputs, root) => {
      controls.push({ kind: "element", controlKind: "custom-select", element: primaryInput(inputs), elements: inputs, root, merged: inputs.length - 1 });
    });

    pickerInputs.forEach((inputs, root) => {
      const pickerType = pickerTypeOf(root);
      inputs.forEach((input, index) => {
        controls.push({ kind: "element", controlKind: "date-picker", element: input, elements: [input], root, pickerType,
          rangePart: inputs.length > 1 ? rangePart(input, index) : "" });
      });
    });

    radiosByName.forEach((entries) => {
      splitRadioGroup(entries.map((entry) => entry.el), ctx).forEach((radios) => {
        const group = radios[0].closest("[role='radiogroup']");
        const lca = radios.length > 1 ? lowestCommonAncestor(radios) : radios[0];
        const root = group && group.contains(lca) && !hasForeignControl(group, group, ctx) ? group : lca;
        const members = new Set(radios);
        // 选项和别的控件挤在同一个容器里：题目只能从容器内、第一个选项前面取。
        const mixed = Array.from(root.querySelectorAll(CONTROL_SELECTOR)).some((el) => boundaryControls(ctx).has(el) && !members.has(el));
        controls.push({ kind: "radio", controlKind: "radio", element: radios[0], elements: radios, root, mixed });
      });
    });

    // 页面顺序：后面的一键填写按这个顺序从上往下填。
    controls.sort((a, b) => compareOrder(a.element, b.element));
    return controls;
  }

  function rangePart(input, index) {
    const hint = `${attr(input, "placeholder")} ${attr(input, "aria-label")}`;
    if (/开始|起始|start|from/i.test(hint)) return "开始";
    if (/结束|截止|end|to\b/i.test(hint)) return "结束";
    return index === 0 ? "开始" : "结束";
  }

  // 同名单选框散在不同条目里（重复区块常见）：从装着另一个同组选项的最小祖先开始，
  // 一直扩到再往上就会装进别的控件为止，按这个祖先分组。
  function splitRadioGroup(radios, ctx) {
    if (radios.length < 2) return [radios];
    const boundaries = boundaryControls(ctx);
    const memberSet = new Set(radios);
    const hasForeign = (node) => Array.from(node.querySelectorAll(CONTROL_SELECTOR)).some((el) => boundaries.has(el) && !memberSet.has(el));
    const lca = lowestCommonAncestor(radios);
    if (lca && !hasForeign(lca)) return [radios];
    const groups = new Map();
    radios.forEach((radio) => {
      let top = radio.parentElement;
      while (top && top !== ctx.body && !radios.some((other) => other !== radio && top.contains(other))) top = top.parentElement;
      if (!top || top === ctx.body) top = radio;
      while (top.parentElement && top.parentElement !== ctx.body && !hasForeign(top.parentElement)) top = top.parentElement;
      if (!groups.has(top)) groups.set(top, []);
      groups.get(top).push(radio);
    });
    return [...groups.values()];
  }

  function compareOrder(a, b) {
    if (a === b) return 0;
    // DOCUMENT_POSITION_FOLLOWING = 4
    return a.compareDocumentPosition(b) & 4 ? -1 : 1;
  }

  // 控件所在的最小表单项：从控件（组件根）往上，直到再往上一层就会装进别的控件为止。
  function findItem(root, ctx) {
    let current = root;
    for (;;) {
      const parent = current.parentElement;
      if (!parent || parent === ctx.body || parent.tagName === "HTML") return current;
      if (hasForeignControl(parent, root, ctx)) return current;
      current = parent;
    }
  }

  // --- 文字收集 ---------------------------------------------------------------

  function skipTextElement(el, ctx, skip) {
    if (skip.has(el)) return true;
    if (SKIPPED_TEXT_TAGS.has(el.tagName)) return true;
    const role = attr(el, "role").toLowerCase();
    if (SKIPPED_TEXT_ROLES.has(role)) return true;
    if (attr(el, "aria-hidden") === "true" || el.hasAttribute?.("aria-live")) return true;
    // 富文本编辑区里是用户自己写的内容，不能当题目读出来。
    if (el.isContentEditable || /^(?:true|plaintext-only|)$/i.test(el.getAttribute?.("contenteditable") ?? "x")) return true;
    if (classTokens(el).some((token) => token.split(/[-_]+/).some((part) => NOISE_TOKEN.test(part)))) return true;
    return !ctx.isVisible(el);
  }

  function textSegments(container, ctx, skip) {
    const out = [];
    const walk = (node) => {
      for (let child = node.firstChild; child; child = child.nextSibling) {
        if (child.nodeType === 3) {
          const text = squash(child.data);
          if (text) out.push({ text, el: node, node: child });
        } else if (child.nodeType === 1 && !skipTextElement(child, ctx, skip)) {
          walk(child);
        }
      }
    };
    if (container.nodeType === 1 && !skipTextElement(container, ctx, skip)) walk(container);
    return out;
  }

  function usefulSegments(segments, placeholders) {
    return segments.filter((segment) => !isNoiseText(segment.text, placeholders));
  }

  function isLabelLike(el) {
    if (["LABEL", "LEGEND", "TH", "DT", "CAPTION", "H1", "H2", "H3", "H4", "H5", "H6"].includes(el.tagName)) return true;
    if (attr(el, "role").toLowerCase() === "heading") return true;
    return classTokens(el).some((token) => token.split(/[-_]+/).some((part) => LABEL_TOKEN.test(part)));
  }

  function isHeadingLike(el) {
    if (["H1", "H2", "H3", "H4", "H5", "H6", "LEGEND", "CAPTION"].includes(el.tagName)) return true;
    if (attr(el, "role").toLowerCase() === "heading") return true;
    return classTokens(el).some((token) => token.split(/[-_]+/).some((part) => HEADING_TOKEN.test(part)));
  }

  function labelLikeAncestor(el, item) {
    for (let node = el; node && node !== item; node = node.parentElement) {
      if (isLabelLike(node)) return node;
    }
    return null;
  }

  function isBefore(node, reference) {
    // DOCUMENT_POSITION_FOLLOWING = 4：reference 在 node 之后。
    return Boolean(node.compareDocumentPosition(reference) & 4) && !reference.contains(node);
  }

  function placeholdersOf(control) {
    const values = control.elements.map((el) => attr(el, "placeholder")).filter(Boolean);
    return values;
  }

  function optionLabelElements(control) {
    const set = new Set();
    if (control.kind === "radio") {
      control.elements.forEach((el) => Array.from(el.labels || []).forEach((label) => set.add(label)));
    }
    return set;
  }

  function elementText(el, ctx, control) {
    const skip = new Set([control.root, ...optionLabelElements(control)]);
    // 包着控件的 label：去掉控件本身再取字。
    skip.delete(el);
    const placeholders = placeholdersOf(control);
    return cleanLabel(joinSegments(usefulSegments(textSegments(el, ctx, skip), placeholders)), placeholders);
  }

  function explicitLabel(control, ctx) {
    const placeholders = placeholdersOf(control);
    const primary = control.element;
    const check = (text, source, labelEl = null) => {
      const value = cleanLabel(text, placeholders);
      return value ? { text: value, source, labelEl } : null;
    };

    const dataLabel = check(attr(primary, "data-label"), "explicit");
    if (dataLabel) return dataLabel;

    if (control.kind === "radio") {
      const group = control.root.closest("[role='radiogroup']") || (control.root.matches?.("[role='radiogroup']") ? control.root : null);
      if (group) {
        const byId = labelledByText(group, ctx, control);
        if (byId) return byId;
        const aria = check(attr(group, "aria-label"), "explicit");
        if (aria) return aria;
      }
      const fieldset = control.root.closest("fieldset");
      const legend = fieldset && !hasForeignControl(fieldset, control.root, ctx) ? fieldset.querySelector("legend") : null;
      if (legend) {
        const text = elementText(legend, ctx, control);
        if (text) return { text, source: "explicit", labelEl: legend };
      }
      return null;
    }

    for (const el of control.elements) {
      for (const label of Array.from(el.labels || [])) {
        const text = elementText(label, ctx, control);
        if (text) return { text, source: "explicit", labelEl: label };
      }
    }

    for (const el of [primary, control.root]) {
      const byId = labelledByText(el, ctx, control);
      if (byId) return byId;
    }

    for (const el of [primary, control.root]) {
      const aria = check(attr(el, "aria-label"), "explicit");
      if (aria) return aria;
    }

    const wrapping = primary.closest("label");
    if (wrapping) {
      const text = elementText(wrapping, ctx, control);
      if (text) return { text, source: "explicit", labelEl: wrapping };
    }
    return null;
  }

  function labelledByText(el, ctx, control) {
    const ids = attr(el, "aria-labelledby").split(/\s+/).filter(Boolean);
    if (!ids.length) return null;
    const parts = ids.map((id) => ctx.doc.getElementById(id)).filter(Boolean)
      .map((target) => elementText(target, ctx, control)).filter(Boolean);
    const text = cleanLabel(parts.join(" "), placeholdersOf(control));
    return text ? { text, source: "explicit", labelEl: ctx.doc.getElementById(ids[0]) } : null;
  }

  function itemLabel(control, item, ctx) {
    if (item === control.root) return null;
    const placeholders = placeholdersOf(control);
    const skip = new Set([control.root, ...optionLabelElements(control)]);
    const segments = usefulSegments(textSegments(item, ctx, skip), placeholders);
    const before = segments.filter((segment) => isBefore(segment.node, control.root));
    const pool = before.length ? before
      : (control.controlKind === "checkbox" ? segments : []);
    if (!pool.length) return null;

    for (let index = pool.length - 1; index >= 0; index -= 1) {
      const labelEl = labelLikeAncestor(pool[index].el, item);
      if (!labelEl) continue;
      const text = cleanLabel(joinSegments(pool.filter((segment) => labelEl.contains(segment.node))), placeholders);
      if (text) return { text, source: "item", labelEl };
    }

    const loose = joinSegments(pool);
    if (loose.length > MAX_LOOSE_TEXT_CHARS) return null;
    const text = cleanLabel(loose, placeholders);
    return text ? { text, source: "item-text", labelEl: null } : null;
  }

  function cellColumn(cell) {
    let column = 0;
    for (let prev = cell.previousElementSibling; prev; prev = prev.previousElementSibling) {
      column += Number(prev.colSpan) || 1;
    }
    return column;
  }

  function cellAtColumn(row, column) {
    let position = 0;
    for (const cell of Array.from(row.cells || [])) {
      const span = Number(cell.colSpan) || 1;
      if (column >= position && column < position + span) return cell;
      position += span;
    }
    return null;
  }

  // 表格布局：同一行紧挨着的前一格，或者表头同一列。
  function tableLabel(control, item, ctx) {
    const cell = control.root.closest("td, th");
    if (!cell || !(cell.contains(item) || item.contains(cell))) return null;
    const placeholders = placeholdersOf(control);
    const prev = cell.previousElementSibling;
    if (prev && !containsBoundary(prev, ctx)) {
      const text = cleanLabel(joinSegments(usefulSegments(textSegments(prev, ctx, new Set()), placeholders)), placeholders);
      if (text) return { text, source: "table", labelEl: prev };
    }
    const row = cell.parentElement;
    const table = cell.closest("table");
    if (!row || !table) return null;
    const headerRow = table.tHead?.rows?.[0]
      || Array.from(table.rows || []).find((candidate) => candidate !== row && candidate.cells.length
        && Array.from(candidate.cells).every((c) => c.tagName === "TH"));
    if (!headerRow || headerRow === row) return null;
    const header = cellAtColumn(headerRow, cellColumn(cell));
    if (!header || containsBoundary(header, ctx)) return null;
    const text = cleanLabel(joinSegments(usefulSegments(textSegments(header, ctx, new Set()), placeholders)), placeholders);
    return text ? { text, source: "table-header", labelEl: header, row } : null;
  }

  // 控件和题目是同一层的兄弟：只看紧挨着的前文，碰到别的控件就停。
  function siblingLabel(control, item, ctx) {
    const placeholders = placeholdersOf(control);
    const pick = (node) => {
      if (node.nodeType === 3) return cleanLabel(node.data, placeholders);
      if (node.nodeType !== 1 || skipTextElement(node, ctx, new Set())) return "";
      return cleanLabel(joinSegments(usefulSegments(textSegments(node, ctx, new Set()), placeholders)), placeholders);
    };
    for (let node = item.previousSibling; node; node = node.previousSibling) {
      if (node.nodeType === 1 && containsBoundary(node, ctx)) break;
      const text = pick(node);
      if (text) return { text, source: "sibling", labelEl: node.nodeType === 1 ? node : null };
    }
    if (control.controlKind === "checkbox") {
      for (let node = item.nextSibling; node; node = node.nextSibling) {
        if (node.nodeType === 1 && containsBoundary(node, ctx)) break;
        const text = pick(node);
        if (text) return { text, source: "sibling", labelEl: node.nodeType === 1 ? node : null };
      }
    }
    return null;
  }

  // 占位文字只用来判断能不能填，不当字段名，也不进「加到我的信息」。
  function placeholderHint(control) {
    for (const value of placeholdersOf(control)) {
      const rest = squash(value).replace(/^(?:请(?:输入|选择|填写|上传)|输入|选择|填写)/, "").replace(/[.。…:：]+$/, "").trim();
      if (rest.length >= 2 && !isNoiseText(value)) return { text: "", source: "placeholder", labelEl: null };
    }
    return null;
  }

  function mixedRadioLabel(control, ctx) {
    const first = control.elements[0];
    const boundaries = boundaryControls(ctx);
    const members = new Set(control.elements);
    let fence = null;
    for (const el of control.root.querySelectorAll(CONTROL_SELECTOR)) {
      if (boundaries.has(el) && !members.has(el) && isBefore(el, first)) fence = el;
    }
    const placeholders = placeholdersOf(control);
    const pool = usefulSegments(textSegments(control.root, ctx, optionLabelElements(control)), placeholders)
      .filter((segment) => isBefore(segment.node, first) && (!fence || isBefore(fence, segment.node)));
    if (!pool.length) return null;
    const nearest = labelLikeAncestor(pool[pool.length - 1].el, control.root);
    const text = cleanLabel(joinSegments(nearest ? pool.filter((segment) => nearest.contains(segment.node)) : pool), placeholders);
    return text ? { text, source: nearest ? "item" : "item-text", labelEl: nearest } : null;
  }

  function resolveLabel(control, item, ctx) {
    if (control.mixed) {
      return explicitLabel(control, ctx) || mixedRadioLabel(control, ctx) || { text: "", source: "none", labelEl: null };
    }
    return explicitLabel(control, ctx)
      || itemLabel(control, item, ctx)
      || tableLabel(control, item, ctx)
      || siblingLabel(control, item, ctx)
      || placeholderHint(control)
      || { text: "", source: "none", labelEl: null };
  }

  const STRONG_SOURCES = new Set(["explicit", "item", "table", "table-header"]);
  const OFFERABLE_SOURCES = new Set(["explicit", "item", "item-text", "table", "table-header", "sibling"]);

  // --- 区块与重复条目 ---------------------------------------------------------

  // 所属区块：从字段所在的表单项往外一层层找。
  // 1) 标签或 class 明说是标题的（h1–h6、legend、class 带 title/header 等词）：前面装着控件的兄弟跳过，继续往前找。
  // 2) 标题行只有自动生成的 class（北森的 sc-xxxx）：只在“装着一组字段”的容器前面，
  //    取紧挨着的那几行纯文字里最上面一行——标题在上，说明文字在下。单个字段旁边的纯文字不算区块标题。
  function findSection(control, ctx, claimed) {
    const start = control.item;
    let depth = 0;
    for (let node = start; node && node !== ctx.body && node.tagName !== "HTML" && depth < 14; node = node.parentElement, depth += 1) {
      if (node.tagName === "FIELDSET" && node !== start) {
        const legend = node.querySelector("legend");
        const text = legend && !claimed.has(legend) ? headingText(legend, ctx, control) : "";
        if (text) return { text, root: node };
      }
      for (let prev = node.previousElementSibling; prev; prev = prev.previousElementSibling) {
        if (!ctx.isVisible(prev) || containsBoundary(prev, ctx) || claimed.has(prev)) continue;
        if (Array.from(claimed).some((el) => el && prev.contains(el))) continue;
        const heading = isHeadingLike(prev) ? prev : prev.querySelector("h1, h2, h3, h4, h5, h6, legend, [role='heading']");
        if (!heading) continue;
        const text = headingText(heading, ctx, control);
        if (text) return { text, root: node.parentElement };
      }
      if (!hasForeignControl(node, control.root, ctx)) continue;
      const run = [];
      for (let prev = node.previousElementSibling; prev; prev = prev.previousElementSibling) {
        // 已经当了别的字段题目的（比如表头那一行）不是区块标题。
        if (!ctx.isVisible(prev) || claimed.has(prev) || Array.from(claimed).some((el) => el && prev.contains(el))) continue;
        if (containsBoundary(prev, ctx)) {
          // 前面一条结构相同的重复条目：跳过它，接着找它前面的标题。
          if (sameShape(prev, node)) continue;
          break;
        }
        run.push(prev);
      }
      for (const candidate of run.reverse()) {
        const text = headingText(candidate, ctx, control);
        if (text) return { text, root: node.parentElement };
      }
    }
    return { text: "", root: null };
  }

  function sameShape(a, b) {
    const cls = attr(a, "class");
    return Boolean(cls) && a.tagName === b.tagName && cls === attr(b, "class");
  }

  // 区块里有「添加」「新增」这类按钮：能加多条，是经历类列表。
  const ADD_ENTRY = /^[+＋]?\s*(?:添加|新增|增加|继续添加|再添加)[\u4e00-\u9fa5/／]{0,10}$/;
  function hasAddEntry(root, ctx) {
    if (!root) return false;
    if (!ctx.addEntry) ctx.addEntry = new Map();
    if (!ctx.addEntry.has(root)) {
      const walker = ctx.doc.createTreeWalker(root, 4);
      let found = false;
      for (let node = walker.nextNode(); node && !found; node = walker.nextNode()) {
        if (node.parentElement?.tagName === "OPTION") continue;
        found = ADD_ENTRY.test(squash(node.data)) && ctx.isVisible(node.parentElement);
      }
      ctx.addEntry.set(root, found);
    }
    return ctx.addEntry.get(root);
  }

  function headingText(el, ctx, control) {
    const text = cleanLabel(joinSegments(usefulSegments(textSegments(el, ctx, new Set()), [])), []);
    if (!text || text.length > MAX_SECTION_CHARS || text === control.label) return "";
    return text;
  }

  function normalizeKey(value) {
    return squash(value).toLowerCase().replace(/[\s:：*＊]/g, "");
  }

  function truncate(text, max) {
    return text.length > max ? `${text.slice(0, max - 1)}…` : text;
  }

  function regionRoot(controls) {
    const strong = controls.filter((control) => control.fillable && STRONG_SOURCES.has(control.labelSource) && !control.searchLike);
    if (strong.length < 3) return null;
    return lowestCommonAncestor(strong.map((control) => control.root));
  }

  // --- 对外入口 ---------------------------------------------------------------

  function scanPage(doc, options = {}) {
    const ctx = makeContext(doc, options);
    const skipped = { pageChrome: 0, popup: 0, merged: 0, siteSearch: 0, outsideForm: 0, noLabel: 0, ambiguous: 0 };
    const allControls = Array.from(doc.querySelectorAll(CONTROL_SELECTOR))
      .filter((el) => isControlElement(el) && !ctx.excluded(el) && ctx.isVisible(el));
    skipped.popup = allControls.filter((el) => isPopupInternal(el, ctx)).length;

    const controls = collectLogicalControls(ctx);
    const itemByRoot = new Map();
    for (const control of controls) {
      skipped.merged += control.merged || 0;
      if (!itemByRoot.has(control.root)) itemByRoot.set(control.root, findItem(control.root, ctx));
      control.item = itemByRoot.get(control.root);
      const resolved = resolveLabel(control, control.item, ctx);
      control.label = resolved.text && control.rangePart ? `${resolved.text}（${control.rangePart}）` : resolved.text;
      control.labelSource = resolved.source;
      control.labelEl = resolved.labelEl;
      control.tableRow = resolved.row || null;
      control.searchLike = control.controlKind === "text" && control.elements.some(looksSearchLike);
      control.chrome = isPageChrome(control.root);
      // 禁用的控件和文件框只用来划分表单项边界，不填写。
      const disabled = control.elements.every((el) => el.disabled);
      control.fillable = control.controlKind !== "file" && !disabled && control.labelSource !== "none";
      control.skipReason = control.controlKind === "file" ? "file" : disabled ? "disabled" : control.labelSource === "none" ? "noLabel" : "";
    }

    for (const control of controls) {
      if (!control.fillable) continue;
      if (control.chrome) {
        control.fillable = false;
        control.skipReason = "pageChrome";
      } else if (control.searchLike && !STRONG_SOURCES.has(control.labelSource)) {
        control.fillable = false;
        control.skipReason = "siteSearch";
      }
    }

    const region = regionRoot(controls);
    if (region) {
      for (const control of controls) {
        if (control.fillable && !region.contains(control.root) && (!STRONG_SOURCES.has(control.labelSource) || control.searchLike)) {
          control.fillable = false;
          control.skipReason = "outsideForm";
        }
      }
    }

    controls.forEach((control) => {
      if (control.skipReason && skipped[control.skipReason] !== undefined) skipped[control.skipReason] += 1;
    });

    const kept = controls.filter((control) => control.fillable);
    const claimed = new Set(kept.map((control) => control.labelEl).filter(Boolean));
    kept.forEach((control) => {
      const found = control.label ? findSection(control, ctx, claimed) : { text: "", root: null };
      control.section = found.text;
      control.sectionRoot = found.root;
    });

    // 同一区块里同名的题目（重复条目、表格多行）按页面顺序编号。
    const sameSlot = new Map();
    const sameLabel = new Map();
    kept.forEach((control) => {
      if (!control.label) return;
      const slot = `${normalizeKey(control.section)}\u0000${normalizeKey(control.label)}`;
      if (!sameSlot.has(slot)) sameSlot.set(slot, []);
      sameSlot.get(slot).push(control);
      const key = normalizeKey(control.label);
      sameLabel.set(key, (sameLabel.get(key) || 0) + 1);
    });
    const sectionsWithRepeats = new Set();
    sameSlot.forEach((list) => list.forEach((control, index) => {
      control.repeatIndex = list.length > 1 ? index + 1 : 0;
      if (list.length > 1 && control.section) sectionsWithRepeats.add(normalizeKey(control.section));
    }));
    kept.forEach((control) => {
      control.sectionRepeatable = Boolean(control.section)
        && (sectionsWithRepeats.has(normalizeKey(control.section)) || hasAddEntry(control.sectionRoot, ctx));
    });

    let ambiguousSkipped = 0;
    kept.forEach((control) => {
      control.group = control.section
        ? (control.repeatIndex ? `${control.section} ${control.repeatIndex}` : control.section)
        : "";
      control.offerable = Boolean(control.label) && OFFERABLE_SOURCES.has(control.labelSource);
      if (!control.offerable) {
        control.offerLabel = "";
        return;
      }
      const ambiguous = (sameLabel.get(normalizeKey(control.label)) || 0) > 1;
      let offer = control.label;
      if (ambiguous) {
        // 同名题目只有找到所属区块才能说清是哪一个；光加个序号（「名称2」）用户看不懂，不如不问。
        if (!control.section) {
          control.offerable = false;
          control.offerLabel = "";
          ambiguousSkipped += 1;
          return;
        }
        offer = `${control.section}-${control.label}`;
      }
      control.offerLabel = truncate(offer, MAX_OFFER_CHARS);
    });

    const sources = {};
    kept.forEach((control) => {
      sources[control.labelSource] = (sources[control.labelSource] || 0) + 1;
    });

    skipped.ambiguous = ambiguousSkipped;
    return {
      controls: kept.map(publicControl),
      skipped,
      sources
    };
  }

  function publicControl(control) {
    return {
      kind: control.kind,
      controlKind: control.controlKind,
      element: control.element,
      elements: control.elements,
      root: control.root,
      item: control.item,
      label: control.label,
      labelSource: control.labelSource,
      section: control.section || "",
      group: control.group || "",
      repeatIndex: control.repeatIndex || 0,
      sectionRepeatable: Boolean(control.sectionRepeatable),
      offerable: control.offerable,
      offerLabel: control.offerLabel || "",
      pickerType: control.pickerType || "",
      rangePart: control.rangePart || "",
      mixed: Boolean(control.mixed),
      placeholder: attr(control.element, "placeholder")
    };
  }

  // 用之前再确认一次：控件还在、还在原来的表单项里、表单项没混进别的控件、题目没变。
  function isBindingCurrent(control, doc, options = {}) {
    if (!control?.root || !control.item || !Array.isArray(control.elements)) return false;
    if (!control.item.isConnected || !control.root.isConnected) return false;
    if (!control.elements.every((el) => el.isConnected && control.root.contains(el))) return false;
    if (!control.item.contains(control.root)) return false;
    const ctx = makeContext(doc || control.item.ownerDocument, options);
    if (hasForeignControl(control.item, control.root, ctx)) return false;
    const resolved = resolveLabel(control, control.item, ctx);
    if (control.labelSource === "placeholder") return resolved.source === "placeholder";
    const label = resolved.text && control.rangePart ? `${resolved.text}（${control.rangePart}）` : resolved.text;
    return Boolean(label) && label === control.label;
  }

  // 自定义下拉选好之后，选中的文字通常显示在组件里而不是 input.value。只回答有没有，不返回内容。
  function hasDisplayedValue(control, options = {}) {
    if (!control?.root?.isConnected) return false;
    const ctx = makeContext(control.root.ownerDocument, options);
    const placeholders = placeholdersOf(control);
    const skip = new Set();
    const segments = [];
    const walk = (node) => {
      for (let child = node.firstChild; child; child = child.nextSibling) {
        if (child.nodeType === 3) {
          const text = squash(child.data);
          if (text) segments.push(text);
        } else if (child.nodeType === 1 && !skipTextElement(child, ctx, skip)) {
          walk(child);
        }
      }
    };
    walk(control.root);
    return segments.some((text) => !isNoiseText(text, placeholders));
  }

  // 单个控件的题目：焦点、敏感字段判断用。没有可靠题目就返回空字符串。
  function labelForElement(element, options = {}) {
    if (!element?.ownerDocument || !isControlElement(element)) return "";
    const doc = element.ownerDocument;
    const ctx = makeContext(doc, { ...options, isVisible: options.isVisible || (() => true) });
    ctx.boundaries = new Set(Array.from(doc.querySelectorAll(CONTROL_SELECTOR)).filter((el) => isControlElement(el) && (el === element || !ctx.excluded(el))));
    const type = inputType(element);
    let control;
    if (type === "radio") {
      control = { kind: "radio", controlKind: "radio", element, elements: [element], root: element.closest("[role='radiogroup']") || element };
    } else {
      const picker = element.tagName === "INPUT" && !DATE_TYPES.has(type) && !CHOICE_TYPES.has(type) ? datePickerRoot(element, ctx) : null;
      const selectRoot = !picker && element.tagName === "INPUT" && !DATE_TYPES.has(type) && !CHOICE_TYPES.has(type) ? customSelectRoot(element, ctx) : null;
      const controlKind = element.tagName === "SELECT" ? "select" : element.tagName === "TEXTAREA" ? "textarea"
        : CHOICE_TYPES.has(type) ? type : picker ? "date-picker" : selectRoot ? "custom-select" : "text";
      control = { kind: "element", controlKind, element, elements: [element], root: picker || selectRoot || element };
    }
    const item = findItem(control.root, ctx);
    const resolved = resolveLabel(control, item, ctx);
    return resolved.text;
  }

  const api = {
    MAX_OFFER_CHARS,
    cleanLabel,
    hasDisplayedValue,
    isBindingCurrent,
    isNoiseText,
    labelForElement,
    scanPage
  };

  if (typeof module !== "undefined" && module.exports) {
    module.exports = api;
  }

  globalScope.ResumeProFieldScan = api;
})(typeof self !== "undefined" ? self : globalThis);

// #228 网页字段扫描：一键填写和「加到我的信息」共用。
// 只读页面结构，不读也不记字段值。先把控件归并成逻辑控件（自定义下拉连同内部输入算一个），
// 再找每个控件所在的最小表单项，题目只从明确关联或这一项里取，不跨到别的题目借字。
// 占位文字、字数计数器、帮助说明、校验错误都不能当字段名；对不上题目的控件直接跳过。
(function attachResumeProFieldScan(globalScope) {
  const CONTROL_SELECTOR = "input, textarea, select, [role='combobox'], button[aria-haspopup='listbox']";
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
  // layui 的选项列表 dl 在组件根 .layui-form-select 里面（#301）。
  const POPUP_SELECTOR = "[role='listbox'], [role='tree'], [role='menu'], [role='option'], .layui-form-select > dl";
  const POPUP_TOKEN = /[-_](?:dropdown|popper|popover|popup)(?:[-_]?(?:menu|panel|content|wrapper|list|inner))?$|^(?:dropdown-menu|popper|popover)$/i;
  // #301 简道云表单的日期框：.fx-form-datetime 里的 .x-datetime（类名不带 date-picker）。
  const DATE_PICKER_SELECTOR = ".ant-picker, .el-date-editor, [class*='date-picker'], [class*='datepicker'], [class*='DatePicker'], [class*='date-editor'], .fx-form-datetime .x-datetime";
  const SELECT_TOKEN = /(?:^|[-_])(?:select|selector|cascader|combobox|combo|dropdown|autocomplete|treeselect|multiselect|picker)(?:$|[-_])/i;
  // #269 只有类名、没有别的信号时，只认明确是选择框的词（北森 phoenix-select、Moka sd-Select）；
  // autocomplete、combo 这类可能允许自由输入，picker 可能是日期；Tailwind 的 select-none 之类不是组件。
  const PLAIN_SELECT_TOKEN = /(?:^|[-_])(?:select|selector|dropdown|treeselect|multiselect)(?:$|[-_])/i;
  const NOT_SELECT_TOKEN = /^(?:user-)?select-(?:none|text|all|auto)$/i;
  // #269 自制单选组（北森 phoenix-radio-group）：选项是 div，组里没有 input。容器带 radio-group 类名或 role=radiogroup 才算。
  const RADIO_GROUP_TOKEN = /(?:^|[-_])radio-?group(?:$|[-_])/i;
  const MAX_RADIO_OPTION_CHARS = 40;
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

  // #301 antd 换了类名前缀（飞书招聘 atsx-，见 antd-prefix.js）：选择器里的 .ant- 按节点所在文档的前缀展开；
  // 按类名比对时，换了前缀的类名再补一份 ant- 的写法，原来的类名照样比（app-header 这类网站自己的类名不受前缀影响）。
  function antdCss(node, selector) {
    return globalScope.ResumeProAntdPrefix?.css(node, selector) ?? selector;
  }

  // 扫描开始时按页面现在的样子重看前缀：表单常在一键填写点下去之后才出来。
  function antdRefresh(node) {
    globalScope.ResumeProAntdPrefix?.prefixes(node, { fresh: true });
  }

  function antdTokens(node, tokens) {
    const antd = globalScope.ResumeProAntdPrefix;
    if (!antd) return tokens;
    const renamed = tokens.map((token) => antd.token(node, token)).filter((token, index) => token !== tokens[index]);
    return renamed.length ? [...tokens, ...renamed] : tokens;
  }

  function attr(el, name) {
    return String(el?.getAttribute?.(name) || "");
  }

  function inputType(el) {
    return el.tagName === "INPUT" ? String(el.getAttribute("type") || "text").toLowerCase() : "";
  }

  function isControlElement(el, ctx) {
    if (!el) return false;
    if (!["INPUT", "TEXTAREA", "SELECT"].includes(el.tagName)) {
      return hasComboSignal(el) && !Array.from(el.querySelectorAll(CONTROL_SELECTOR)).some(child => {
        if (ctx && !ctx.isVisible(child)) return false;
        if (["INPUT", "TEXTAREA", "SELECT"].includes(child.tagName)) return !NON_CONTROL_TYPES.has(inputType(child));
        return hasComboSignal(child);
      });
    }
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
    // doc 也可以是开放的 ShadowRoot（#224 页面大纲）：它没有 body，查询都在这个根里做。
    return { doc, body: doc.body || null, isVisible, excluded, boundaries: null };
  }

  // 最小表单项的边界：页面上所有可见的真实控件（含禁用、文件、单选、勾选）。
  function boundaryControls(ctx) {
    if (!ctx.boundaries) {
      ctx.boundaries = new Set(Array.from(ctx.doc.querySelectorAll(CONTROL_SELECTOR))
        .filter((el) => isControlElement(el, ctx) && !ctx.excluded(el) && ctx.isVisible(el) && !isPopupInternal(el, ctx) && !isOverlayInput(el, ctx)));
    }
    return ctx.boundaries;
  }

  // #269 智联「离职时间」：只读的显示框和真正的日期框叠在同一个位置（上面盖着遮罩）。叠在日期组件
  // 输入框正上方的只读框只是显示层，不算单独的字段，也不把题目切开。目前只见过日期这一种，下拉不处理。
  // 没有布局（尺寸为 0）时不判断。
  function isOverlayInput(el, ctx) {
    if (el.tagName !== "INPUT" || !el.readOnly || !["text", "search"].includes(inputType(el))) return false;
    const r = el.getBoundingClientRect?.();
    if (!r || r.width <= 0 || r.height <= 0) return false;
    let container = el.parentElement;
    for (let depth = 0; container && depth < 3; depth += 1) container = container.parentElement;
    if (!container) return false;
    return Array.from(container.querySelectorAll("input")).some((other) => {
      if (other === el || !ctx.isVisible(other) || !other.closest(antdCss(other, DATE_PICKER_SELECTOR))) return false;
      const o = other.getBoundingClientRect();
      return Math.abs(o.left - r.left) <= 4 && Math.abs(o.top - r.top) <= 4 && Math.abs(o.width - r.width) <= 6 && Math.abs(o.height - r.height) <= 6;
    });
  }

  function hasForeignControl(container, root, ctx) {
    const boundaries = boundaryControls(ctx);
    for (const el of container.querySelectorAll(CONTROL_SELECTOR)) {
      if (boundaries.has(el) && !root.contains(el)) return true;
    }
    // 自制单选组没有 input，也要当作一道题的边界，免得别的题目跨过它借字。
    return customRadioGroups(ctx).some(({ group }) => container.contains(group) && !root.contains(group) && !group.contains(root));
  }

  function containsBoundary(container, ctx) {
    const boundaries = boundaryControls(ctx);
    if (boundaries.has(container)) return true;
    for (const el of container.querySelectorAll?.(CONTROL_SELECTOR) || []) {
      if (boundaries.has(el)) return true;
    }
    return customRadioGroups(ctx).some(({ group }) => container.contains(group));
  }

  // 选项：role=radio 的元素；没有的话，每段短文字往上取到「只装着这一段文字」的最高一层。
  function customRadioItems(group, ctx) {
    const hasText = (node) => Boolean(squash(node.textContent));
    const marked = Array.from(group.querySelectorAll("[role='radio']")).filter((node) => ctx.isVisible(node) && hasText(node));
    if (marked.length) return marked;
    const leaves = Array.from(group.querySelectorAll("*")).filter((node) => ctx.isVisible(node) && hasText(node)
      && !Array.from(node.children).some(hasText));
    const items = [];
    for (const leaf of leaves) {
      let item = leaf;
      while (item.parentElement && item.parentElement !== group
        && leaves.filter((other) => item.parentElement.contains(other)).length === 1) item = item.parentElement;
      if (!items.includes(item)) items.push(item);
    }
    return items.every((item) => squash(item.textContent).length <= MAX_RADIO_OPTION_CHARS) ? items : [];
  }

  function customRadioGroups(ctx) {
    if (ctx.customRadios) return ctx.customRadios;
    ctx.customRadios = [];
    for (const group of ctx.doc.querySelectorAll("[class*='radio' i], [role='radiogroup']")) {
      const named = attr(group, "role").toLowerCase() === "radiogroup" || classTokens(group).some((token) => RADIO_GROUP_TOKEN.test(token));
      if (!named || group.querySelector("input, select, textarea")) continue;
      if (ctx.excluded(group) || !ctx.isVisible(group) || group.closest(POPUP_SELECTOR)) continue;
      if (ctx.customRadios.some((found) => found.group.contains(group))) continue;
      const items = customRadioItems(group, ctx);
      if (items.length >= 2 && items.length <= 20) ctx.customRadios.push({ group, items });
    }
    return ctx.customRadios;
  }

  function isPageChrome(el) {
    if (el.closest(LANDMARK_SELECTOR)) return true;
    const pageEdge = el.closest("header, footer");
    if (pageEdge && !pageEdge.parentElement?.closest(CONTENT_SCOPE_SELECTOR)) return true;
    for (let node = el.parentElement; node && node.tagName !== "BODY"; node = node.parentElement) {
      // #408 id 要读属性：表单里有 name 或 id 叫 id 的控件时，form.id 是那个控件（antd 把字段名写进 id）。
      const tokens = [...antdTokens(node, classTokens(node)), attr(node, "id")].map((token) => token.toLowerCase());
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
      if ((el.tagName !== "INPUT" && !hasComboSignal(el)) || CHOICE_TYPES.has(inputType(el)) || inputType(el) === "file") return false;
      inputs += 1;
    }
    return inputs <= maxInputs;
  }

  // 取 5 层以内最外层的日期组件容器：range picker 的两个输入框共用一个根。
  function datePickerRoot(el, ctx) {
    let best = null;
    let node = el.parentElement;
    for (let depth = 0; node && node !== ctx.body && depth < 5; depth += 1, node = node.parentElement) {
      if (!node.matches(antdCss(node, DATE_PICKER_SELECTOR))) continue;
      if (!componentScopeOk(node, ctx, 2)) break;
      best = node;
    }
    return best;
  }

  function pickerTypeOf(root) {
    const antd = antdCss(root, ".ant-picker");
    if (root.closest(antd) || root.matches(antd) || root.querySelector?.(antd)) return "antd";
    if (root.closest(".el-date-editor") || root.matches(".el-date-editor")) return "element";
    if (root.matches(".fx-form-datetime .x-datetime")) return "jiandaoyun";
    return "generic";
  }

  // 自定义下拉、级联、自动完成：取最外层像组件根、又只装着这个控件的祖先。
  function customSelectRoot(el, ctx) {
    const ownSignal = hasComboSignal(el);
    let best = attr(el, 'role') === 'combobox' ? el : null;
    let node = el.parentElement;
    for (let depth = 0; node && node !== ctx.body && depth < 5; depth += 1, node = node.parentElement) {
      const tokens = classTokens(node);
      const tokenMatch = tokens.some((token) => SELECT_TOKEN.test(token) && !NOT_SELECT_TOKEN.test(token));
      const plainMatch = tokens.some((token) => PLAIN_SELECT_TOKEN.test(token) && !NOT_SELECT_TOKEN.test(token));
      const ariaMatch = hasComboSignal(node);
      if (!tokenMatch && !ariaMatch) continue;
      if (!componentScopeOk(node, ctx, 3)) break;
      const library = antdTokens(node, tokens).some((token) => LIBRARY_SELECT_TOKENS.has(token.toLowerCase()));
      if (library || ariaMatch) return node;
      if (best && Array.from(node.querySelectorAll('[role="combobox"]')).some(other => !best.contains(other))) break;
      // #301 Moka 整行（apply-field 带 select_info-*、Select-* 类名）也像下拉，可它装着题目：根不能把题目包进去。
      // 题目是排在装输入框那一支前面、有字的 title / label 类元素；类名里带 select 的（my-select__label）
      // 和排在后面的（value-label）是组件自己显示已选值的地方，不算题目。
      const branch = Array.from(node.children).find((child) => child.contains(el));
      if (best && branch && Array.from(node.children).some((child) => child !== branch && isLabelLike(child)
        && (child.compareDocumentPosition(branch) & 4) && squash(child.textContent)
        && !classTokens(child).some((token) => SELECT_TOKEN.test(token)))) break;
      if (ariaMatch || library || plainMatch || ownSignal || el.readOnly || inputType(el) === "search"
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
        // #301 #418 antd 的 Radio.Group 不传 name 时，input 没有 name，组上也没有 role（ant-design-vue 1.x、antd 3～5 都是）：按组容器分。
        // 换了前缀的 antd（atsx-radio-group）也算。
        const groupKey = key || el.closest(antdCss(el, "[role='radiogroup'], fieldset, .ant-radio-group")) || el;
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
      const cascader = antdCss(root, ".ant-cascader, .el-cascader, .arco-cascader");
      const cascade = root.matches(cascader) || Boolean(root.querySelector(cascader))
        || root.getAttribute('aria-haspopup') === 'tree' || primaryInput(inputs).getAttribute('aria-haspopup') === 'tree';
      controls.push({ kind: "element", controlKind: cascade ? "cascader" : "custom-select", element: primaryInput(inputs), elements: inputs, root, merged: inputs.length - 1 });
    });

    pickerInputs.forEach((inputs, root) => {
      const pickerType = pickerTypeOf(root);
      inputs.forEach((input, index) => {
        controls.push({ kind: "element", controlKind: "date-picker", element: input, elements: [input], root, pickerType,
          rangePart: inputs.length > 1 ? rangePart(input, index) : "" });
      });
    });

    customRadioGroups(ctx).forEach(({ group, items }) => {
      controls.push({ kind: "radio", controlKind: "radio", element: items[0], elements: items, root: group, custom: true });
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
    // 错误、帮助、计数这类提示不会包着控件；装着控件的是题目容器（#269 金发校验后给整行加 first-error-field），照常读。
    if (classTokens(el).some((token) => token.split(/[-_]+/).some((part) => NOISE_TOKEN.test(part))) && !containsBoundary(el, ctx)) return true;
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

    // #301 Moka 下拉的外框（label.sd-Select-container）包着输入框，里面显示的是已选值，不是题目。
    // 外框在组件根里面；label 自己就是组件根时，里面写的是题目。
    const ownFrame = (label, el) => ["custom-select", "cascader"].includes(control.controlKind) && label !== control.root
      && control.root.contains(label) && label.contains(el)
      && classTokens(label).some((token) => SELECT_TOKEN.test(token) && !NOT_SELECT_TOKEN.test(token));
    for (const el of control.elements) {
      for (const label of Array.from(el.labels || [])) {
        if (ownFrame(label, el)) continue;
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
    if (wrapping && !ownFrame(wrapping, primary)) {
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

  // #301 div 画的表格（简道云子表单）：格子按这一行里同类格子的位置，对上表头那一行同一列。
  // 只认类名以 cell 结尾、不在 td / th 里的格子（Element、vxe 这类表格 td 里的 div.cell 归 tableLabel）。
  // 表头那一行在同一个表格容器里（往上最多 4 层）、它或它外层带 head / header 类名（简道云 .subform-head）、
  // 排在这一行前面、和这一行长得不一样（不是另一条明细）、同类格子一样多、里面没有控件。
  // 对不上就不取，免得读错列：题目格和填写格交替的 div 网格、Vant 的 cell 列表都没有表头。
  const CELL_TOKEN = /(?:^|[-_])cell$/i;
  const HEAD_TOKEN = /(?:^|[-_])(?:head|header|thead)(?:$|[-_])/i;
  function gridLabel(control, item, ctx) {
    let cell = null;
    let key = "";
    for (let node = control.root.parentElement, depth = 0; node && node !== ctx.body && depth < 8; node = node.parentElement, depth += 1) {
      key = classTokens(node).find((token) => CELL_TOKEN.test(token)) || "";
      if (key) {
        cell = node;
        break;
      }
    }
    if (!cell || cell.closest("td, th") || !(cell.contains(item) || item.contains(cell))) return null;
    const row = cell.parentElement;
    const cellsOf = (node) => Array.from(node.children).filter((child) => classTokens(child).includes(key));
    const cells = row && attr(row, "class") ? cellsOf(row) : [];
    const column = cells.indexOf(cell);
    if (column < 0) return null;
    for (let scope = row.parentElement, depth = 0; scope && scope !== ctx.body && depth < 4; scope = scope.parentElement, depth += 1) {
      const rows = new Set();
      for (const other of Array.from(scope.getElementsByClassName(key))) {
        const parent = other.parentElement;
        if (parent && parent !== row && !parent.contains(row) && isBefore(parent, row)) rows.add(parent);
      }
      const headed = (candidate) => {
        for (let node = candidate; node && node !== scope; node = node.parentElement) {
          if (classTokens(node).some((token) => HEAD_TOKEN.test(token))) return true;
        }
        return false;
      };
      const header = Array.from(rows).filter((candidate) => !sameShape(candidate, row) && headed(candidate)
        && cellsOf(candidate).length === cells.length && !containsBoundary(candidate, ctx)).pop();
      if (!header) continue;
      const head = cellsOf(header)[column];
      const placeholders = placeholdersOf(control);
      const text = cleanLabel(joinSegments(usefulSegments(textSegments(head, ctx, new Set()), placeholders)), placeholders);
      return text ? { text, source: "table-header", labelEl: head, row } : null;
    }
    return null;
  }

  // #301 一题多框（简道云手机号带短信验证码、分开的省 / 市 / 区）：控件自己的表单项里没有题目时，往上（最多 4 层）
  // 找装着这几个框的题目容器：只装 2–4 个文字框、没有别的控件，题目是排在所有框前面的 label / title 类元素，
  // 框和框之间没有别的题目。每个框按 aria-label 或占位文字取子项，叫「题目 - 子项」。子项重复、或别的框没有子项，就不取。
  // 排第一的框没有子项时，只在别的框都是验证码时把它当成这道题本身（手机号 + 短信验证码）；
  // 区号框（+86）、证件类型旁的号码框这类，第一个框不是题目本身，叫成整道题会把手机号填进区号框。
  const MAX_PART_BOXES = 4;
  const MAX_PART_CHARS = 20;
  const CODE_PART = /验证码|校验码|动态码|captcha|verif|sms|\botp\b/i;
  function isTextBox(el) {
    if (el.tagName === "TEXTAREA") return true;
    const type = inputType(el);
    return el.tagName === "INPUT" && !CHOICE_TYPES.has(type) && !DATE_TYPES.has(type) && type !== "file" && !hasComboSignal(el);
  }

  function partName(el) {
    for (const value of [attr(el, "aria-label"), attr(el, "placeholder")]) {
      const rest = squash(value).replace(/^(?:请(?:输入|选择|填写)|输入|选择|填写)/, "").replace(/[.。…:：]+$/, "").trim();
      if (rest && rest.length <= MAX_PART_CHARS && !isNoiseText(value) && !isNoiseText(rest)) return rest;
    }
    return "";
  }

  function partLabel(control, item, ctx) {
    if (!["text", "textarea"].includes(control.controlKind)) return null;
    const boundaries = boundaryControls(ctx);
    for (let scope = item.parentElement, depth = 0; scope && scope !== ctx.body && depth < 4; scope = scope.parentElement, depth += 1) {
      const boxes = Array.from(scope.querySelectorAll(CONTROL_SELECTOR)).filter((el) => boundaries.has(el));
      if (boxes.length > MAX_PART_BOXES || !boxes.every(isTextBox) || customRadioGroups(ctx).some(({ group }) => scope.contains(group))) return null;
      if (boxes.length < 2) continue;
      const segments = usefulSegments(textSegments(scope, ctx, new Set()), []);
      const before = segments.filter((segment) => isBefore(segment.node, boxes[0]));
      let title = null;
      for (let index = before.length - 1; index >= 0 && !title; index -= 1) {
        const labelEl = labelLikeAncestor(before[index].el, scope);
        if (!labelEl || containsBoundary(labelEl, ctx)) continue;
        const text = cleanLabel(joinSegments(before.filter((segment) => labelEl.contains(segment.node))), []);
        if (text) title = { text, labelEl };
      }
      if (!title) continue;
      // 题目在某个框自己的表单项里：那是这个框单独的题目，别的框是另一道题（只有占位文字的下一行）。
      if (boxes.some((box) => findItem(box, ctx).contains(title.labelEl))) return null;
      // 题目那一块里还有题目以外的字：是「应聘岗位 护士」这类只读的信息行（Vant 的 cell），不是这几个框的题目。
      let block = title.labelEl;
      while (block.parentElement && block.parentElement !== scope) block = block.parentElement;
      if (segments.some((segment) => block.contains(segment.node) && !title.labelEl.contains(segment.node))) return null;
      // 框和框之间又出现题目：是几道题挨在一起，不是一题多框。
      const last = boxes[boxes.length - 1];
      if (segments.some((segment) => isBefore(boxes[0], segment.node) && isBefore(segment.node, last) && labelLikeAncestor(segment.el, scope))) return null;
      const names = boxes.map(partName);
      const named = names.filter(Boolean);
      if (new Set(named).size !== named.length || names.slice(1).some((name) => !name)) return null;
      if (!names[0] && !names.slice(1).every((name) => CODE_PART.test(name))) return null;
      const name = names[boxes.indexOf(control.element)];
      return { text: name ? `${title.text} - ${name}` : title.text, source: "item-part", labelEl: title.labelEl, question: scope };
    }
    return null;
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
      || gridLabel(control, item, ctx)
      || siblingLabel(control, item, ctx)
      || partLabel(control, item, ctx)
      || placeholderHint(control)
      || { text: "", source: "none", labelEl: null };
  }

  const STRONG_SOURCES = new Set(["explicit", "item", "table", "table-header"]);
  const OFFERABLE_SOURCES = new Set(["explicit", "item", "item-text", "table", "table-header", "sibling"]);
  // #408 判断「控件一个都没读出来」时不算数的跳过原因：读出错，以及本来就不填的页头、站内搜索、表单外和文件框。
  const UNREADABLE_REASONS = new Set(["scanError", "pageChrome", "siteSearch", "outsideForm", "file"]);

  // --- 区块与重复条目 ---------------------------------------------------------

  // 所属区块：从字段所在的表单项往外一层层找。
  // 1) 标签或 class 明说是标题的（h1–h6、legend、class 带 title/header 等词）：前面装着控件的兄弟跳过，继续往前找。
  // 2) 标题行只有自动生成的 class（北森的 sc-xxxx）：只在“装着一组字段”的容器前面，
  //    取紧挨着的那几行纯文字里最上面一行——标题在上，说明文字在下。单个字段旁边的纯文字不算区块标题。
  function findSection(control, ctx, claimed) {
    // 一题多框的框按整道题找区块：同一题里的另一个框不算别的字段。
    const start = control.question || control.item;
    const own = control.question || control.root;
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
      if (!hasForeignControl(node, own, ctx)) continue;
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
        // 带字的分割线是这一块的开头，再往前的字属于上一块。只取它的题目（简道云的 .field-name / .sep-label），
        // 不带下面的说明（#301 简道云没写题目的子表单前面是【工作经历】分割线，带一段长说明；
        // 再往前是下面没有题的「规培经历」分割线，原来取最上面一行会归到「规培经历」）。
        if (hasDivider(prev)) {
          const title = [prev, ...prev.querySelectorAll("*")].find((el) => isLabelLike(el) && headingText(el, ctx, control));
          const text = headingText(title || prev, ctx, control);
          if (text) return { text, root: node.parentElement };
        }
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

  // 分割线：<hr>，或类名以 separator / divider 结尾（简道云 .fx-form-separator、Element / antd 的 divider）。
  const DIVIDER_TOKEN = /(?:^|[-_])(?:separator|divider)$/i;
  function hasDivider(el) {
    return [el, ...el.querySelectorAll("*")].some((node) => node.tagName === "HR" || classTokens(node).some((token) => DIVIDER_TOKEN.test(token)));
  }

  // 区块里有「添加」「新增」这类按钮：能加多条，是经历类列表。
  const ADD_ENTRY = /^[+＋]?\s*(?:添加|新增|增加|继续添加|再添加)[\u4e00-\u9fa5/／]{0,10}$/;
  function hasAddEntry(root, ctx) {
    if (!root) return false;
    if (!ctx.addEntry) ctx.addEntry = new Map();
    if (!ctx.addEntry.has(root)) {
      const walker = (ctx.doc.createTreeWalker ? ctx.doc : root.ownerDocument).createTreeWalker(root, 4);
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
    antdRefresh(doc);
    const ctx = makeContext(doc, options);
    const skipped = { pageChrome: 0, popup: 0, merged: 0, siteSearch: 0, outsideForm: 0, noLabel: 0, scanError: 0, ambiguous: 0 };
    const allControls = Array.from(doc.querySelectorAll(CONTROL_SELECTOR))
      .filter((el) => isControlElement(el, ctx) && !ctx.excluded(el) && ctx.isVisible(el));
    skipped.popup = allControls.filter((el) => isPopupInternal(el, ctx)).length;

    const controls = collectLogicalControls(ctx);
    const itemByRoot = new Map();
    // #408 逐项跳过时第一个出错的原因：交给 content.js 按代码异常上报，不进诊断。
    let fault = null;
    for (const control of controls) {
      skipped.merged += control.merged || 0;
      try {
        if (!itemByRoot.has(control.root)) itemByRoot.set(control.root, findItem(control.root, ctx));
        control.item = itemByRoot.get(control.root);
        const resolved = resolveLabel(control, control.item, ctx);
        control.label = resolved.text && control.rangePart ? `${resolved.text}（${control.rangePart}）` : resolved.text;
        control.labelSource = resolved.source;
        control.labelEl = resolved.labelEl;
        control.tableRow = resolved.row || null;
        control.question = resolved.question || null;
        control.searchLike = control.controlKind === "text" && control.elements.some(looksSearchLike);
        control.chrome = isPageChrome(control.root);
        // 禁用的控件和文件框只用来划分表单项边界，不填写。
        const disabled = control.elements.every((el) => el.disabled);
        control.fillable = control.controlKind !== "file" && !disabled && control.labelSource !== "none";
        control.skipReason = control.controlKind === "file" ? "file" : disabled ? "disabled" : control.labelSource === "none" ? "noLabel" : "";
      } catch (error) {
        // #408 读这一项的题目时出错：只跳过它并计数，别的照常扫描。
        if (!fault) fault = error;
        Object.assign(control, { fillable: false, skipReason: "scanError", labelEl: null });
      }
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

    const claimed = new Set(controls.filter((control) => control.fillable).map((control) => control.labelEl).filter(Boolean));
    controls.forEach((control) => {
      if (!control.fillable) return;
      try {
        const found = control.label ? findSection(control, ctx, claimed) : { text: "", root: null };
        control.section = found.text;
        control.sectionRoot = found.root;
      } catch (error) {
        // #408 找这一项所属区块时出错：同样只跳过它。题目已经读出来了，留在 claimed 里，别的项不会拿它当区块标题。
        if (!fault) fault = error;
        control.fillable = false;
        control.skipReason = "scanError";
        skipped.scanError += 1;
      }
    });
    const kept = controls.filter((control) => control.fillable);
    // #408 控件一个都没读出来：出错的之外，只剩页头导航、站内搜索、表单外的控件和文件框（这些本来就不填）。
    // 有读出来、只是禁用或对不上题目的控件时不算，没填的原因在它们身上。
    const unreadable = Boolean(fault) && !kept.length
      && controls.every((control) => UNREADABLE_REASONS.has(control.skipReason));

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
      control.repeatCount = list.length;
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
      sources,
      fault,
      unreadable
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
      repeatCount: control.repeatCount || 0,
      custom: Boolean(control.custom),
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
    // 只靠占位文字的下拉选好值后占位文字会消失（#301 Moka 年 / 月）：没冒出别的题目就还是同一个。文本框不放宽。
    if (control.labelSource === "placeholder") return resolved.source === "placeholder"
      || (["custom-select", "cascader"].includes(control.controlKind) && resolved.source === "none");
    const label = resolved.text && control.rangePart ? `${resolved.text}（${control.rangePart}）` : resolved.text;
    return Boolean(label) && label === control.label;
  }

  // Only the fill's in-memory write guard reads this UI state. It is not included
  // in scan descriptors, diagnostics, AI requests or persisted fill records.
  function displayedStateForGuard(control, options = {}) {
    if (!control?.root?.isConnected) return [];
    const ctx = makeContext(control.root.ownerDocument, options);
    const placeholders = placeholdersOf(control);
    const skip = new Set();
    const segments = [];
    // #301 Moka 下拉不挂到 body 时，弹层画在组件根里、包着输入框的 <label> 外框旁边，自己是 fixed 定位：
    // 外框外面这一块是展开的选项，不是显示的值（真机上槽位宽 0 看不见，这里不靠它）。absolute 的可能是浮着显示的已选值，照旧读。
    const label = control.element?.closest?.("label");
    const frame = label && control.root.contains(label) ? label : null;
    const floatsOutside = (node) => {
      if (!frame || node.contains(frame) || frame.contains(node)) return false;
      return node.ownerDocument?.defaultView?.getComputedStyle?.(node)?.position === "fixed";
    };
    const walk = (node) => {
      for (let child = node.firstChild; child; child = child.nextSibling) {
        if (child.nodeType === 3) {
          const text = squash(child.data);
          if (text) segments.push(text);
        } else if (child.nodeType === 1 && !child.matches(POPUP_SELECTOR) && !floatsOutside(child)
          && !classTokens(child).some(token => POPUP_TOKEN.test(token)) && !skipTextElement(child, ctx, skip)) {
          walk(child);
        }
      }
    };
    walk(control.root);
    return segments.filter((text) => !isNoiseText(text, placeholders));
  }
  function hasDisplayedValue(control, options = {}) {
    return displayedStateForGuard(control, options).length > 0;
  }

  // 单个控件的题目：焦点、敏感字段判断用。没有可靠题目就返回空字符串。
  function labelForElement(element, options = {}) {
    if (!element?.ownerDocument) return "";
    const doc = element.ownerDocument;
    const ctx = makeContext(doc, { ...options, isVisible: options.isVisible || (() => true) });
    if (!isControlElement(element, ctx)) return "";
    ctx.boundaries = new Set(Array.from(doc.querySelectorAll(CONTROL_SELECTOR)).filter((el) => isControlElement(el, ctx) && (el === element || !ctx.excluded(el))));
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

  // #224 页面大纲：同一套逻辑控件归并和题目判断，但不按「能不能一键填写」筛掉控件——
  // 对不上题目、在页头或像站内搜索的也列出来，由大纲自己决定写不写。只读结构，不读值。
  // root 是 Document 或开放的 ShadowRoot。
  function outlineControls(root, options = {}) {
    antdRefresh(root);
    const ctx = makeContext(root, options);
    const itemByRoot = new Map();
    // #408 和 scanPage 一样：哪一项读不出来就不列这一项，大纲照常生成。
    const controls = collectLogicalControls(ctx).filter((control) => {
      try {
        if (!itemByRoot.has(control.root)) itemByRoot.set(control.root, findItem(control.root, ctx));
        control.item = itemByRoot.get(control.root);
        const resolved = resolveLabel(control, control.item, ctx);
        control.label = resolved.text && control.rangePart ? `${resolved.text}（${control.rangePart}）` : resolved.text;
        control.labelSource = resolved.source;
        control.labelEl = resolved.labelEl;
        control.question = resolved.question || null;
        control.disabled = control.elements.every((el) => el.disabled);
        control.chrome = isPageChrome(control.root);
        control.searchLike = control.controlKind === "text" && control.elements.some(looksSearchLike);
        return true;
      } catch {
        return false;
      }
    });
    const claimed = new Set(controls.map((control) => control.labelEl).filter(Boolean));
    return controls.flatMap((control) => {
      let found;
      try {
        found = control.label ? findSection(control, ctx, claimed) : { text: "", root: null };
      } catch {
        return [];
      }
      return [{
        kind: control.kind,
        controlKind: control.controlKind,
        element: control.element,
        elements: control.elements,
        root: control.root,
        item: control.item,
        label: control.label,
        labelSource: control.labelSource,
        section: found.text,
        disabled: control.disabled,
        chrome: control.chrome,
        searchLike: control.searchLike,
        pickerType: control.pickerType || "",
        rangePart: control.rangePart || "",
        mixed: Boolean(control.mixed),
        placeholder: attr(control.element, "placeholder")
      }];
    });
  }

  // --- 同源框架 ---------------------------------------------------------------

  // #400 表单在同源 iframe 里（人事考试网、标签页式后台）：一键填写要进去扫。只进看得见、够大（和 fill-probe.js
  // 一样至少 100×50）、横向在视口里的框架，最多往下两层。标签页式后台没切到的页签是 display:none，或者挪到视口
  // 左右两侧之外；在下面、要往下滚才看到的照样进。跨域的、还没有文档的跳过。只读结构，按文档顺序返回，
  // 外层在前；parent 是装着这个框架的文档。
  const FRAME_SELECTOR = "iframe, frame";
  const MIN_FRAME_WIDTH = 100;
  const MIN_FRAME_HEIGHT = 50;
  const MAX_FRAME_DEPTH = 2;

  function frameInView(frame, rect) {
    const view = frame.ownerDocument?.defaultView;
    const width = Number(view?.innerWidth) || 0;
    if (width > 0 && (rect.right <= 0 || rect.left >= width)) return false;
    // 页面上方之外（top 是很大的负数）也算挪走了；只是往下滚过了头的还在页面里。
    return rect.bottom + (Number(view?.scrollY) || 0) > 0;
  }

  function frameDocuments(doc, options = {}, depth = 1) {
    const ctx = makeContext(doc, options);
    const found = [];
    let frames = [];
    try {
      frames = Array.from(doc.querySelectorAll(FRAME_SELECTOR));
    } catch {
      return found;
    }
    for (const frame of frames) {
      if (ctx.excluded(frame) || !ctx.isVisible(frame)) continue;
      let rect = null;
      let inner = null;
      try {
        rect = frame.getBoundingClientRect();
        inner = frame.contentDocument;
      } catch {
        continue;
      }
      if (!rect || rect.width < MIN_FRAME_WIDTH || rect.height < MIN_FRAME_HEIGHT || !frameInView(frame, rect)) continue;
      if (!inner?.documentElement) continue;
      found.push({ frame, doc: inner, depth, parent: doc });
      if (depth < MAX_FRAME_DEPTH) found.push(...frameDocuments(inner, options, depth + 1));
    }
    return found;
  }

  const api = {
    MAX_OFFER_CHARS,
    cleanLabel,
    displayedStateForGuard,
    frameDocuments,
    hasDisplayedValue,
    isBindingCurrent,
    isNoiseText,
    labelForElement,
    outlineControls,
    scanPage
  };

  globalScope.ResumeProFieldScan = api;

  try {
    if (typeof module === "object" && module && typeof module.exports === "object") {
      module.exports = api;
    }
  } catch {
    // A page element or frame named "module" (#275).
  }
})(typeof self !== "undefined" ? self : globalThis);

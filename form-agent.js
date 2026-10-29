(function (root) {
  const domains = [
    { id: "papers", label: "论文", buttons: "论文", group: /^(论文|论文成果|学术论文)$/, prefix: /^论文(\d+)/ },
    { id: "education", label: "教育经历", buttons: "教育经历|教育背景", group: /^(教育经历|教育背景)$/, prefix: /^(?:教育经历|教育背景|教育)(\d+)/ },
    { id: "work", label: "工作经历", buttons: "工作经历", group: /^工作经历$/, prefix: /^(?:工作经历|工作|实习经历|实习)(\d+)/ },
    { id: "projects", label: "项目经历", buttons: "项目经历", group: /^项目经历$/, prefix: /^(?:项目经历|项目)(\d+)/ }
  ];
  const editable = "input:not([type=hidden]):not([type=button]):not([type=submit]):not([type=file]),textarea,select";
  const visible = el => el.isConnected && el.getClientRects().length > 0;
  const text = el => (el.textContent || "").trim().replace(/\s+/g, " ");
  function targetCounts(fields) {
    const firstRecordKeys = { papers: /^(论文标题|标题)$/, education: /^(学校|院校)$/, work: /^(公司|单位)$/, projects: /^(项目名称|名称)$/ };
    const hasWorkRecords = fields.some(field => field.group === "工作经历" && String(field.value || "").trim());
    return Object.fromEntries(domains.map(domain => {
      const records = new Set();
      for (const field of fields) {
        const internshipFallback = domain.id === "work" && !hasWorkRecords && field.group === "实习经历";
        if ((!domain.group.test(field.group || "") && !internshipFallback) || !String(field.value || "").trim()) continue;
        const key = String(field.key || "");
        const numbered = key.match(domain.prefix) || key.match(/^(?:学校|院校|专业|学历|学位|入学时间|毕业时间|起止时间|公司|单位|岗位|职位|工作时间|项目名称|项目时间|职责|论文标题|标题|期刊|期刊名称|发表年份)([1-9]\d*)$/);
        if (numbered) records.add(`number:${numbered[1]}`);
        else if (key.includes("-")) {
          const duplicate = key.match(/ \((\d+)\)$/);
          records.add(`anchor:${key.slice(0, key.indexOf("-"))}:${duplicate?.[1] || "1"}`);
        }
        else if (firstRecordKeys[domain.id].test(key)) records.add("number:1");
        else records.add("single");
      }
      if (records.size > 1) records.delete("single");
      return [domain.id, records.size];
    }));
  }
  function isSafeButton(button, domain) {
    return button.tagName === "BUTTON" && button.getAttribute("type") === "button" &&
      !button.disabled && button.getAttribute("aria-disabled") !== "true" && visible(button) &&
      new RegExp(`^(?:新增|添加)(?:一条|一篇)?(?:${domain.buttons})$`).test(text(button));
  }
  function rows(scope) {
    return Array.from(scope.querySelectorAll("fieldset")).filter(row =>
      visible(row) && !row.parentElement.closest("fieldset") && row.querySelector(editable));
  }
  function controls(scope) { return Array.from(scope.querySelectorAll(editable)).filter(visible); }
  function collect(document, fields) {
    const targets = targetCounts(fields);
    const refs = new Map();
    const candidates = [];
    for (const button of document.querySelectorAll('button[type="button"]')) {
      if (button.closest("#resume-pro-sidebar, #resume-pro-manager")) continue;
      const domain = domains.find(item => isSafeButton(button, item));
      if (!domain || !targets[domain.id]) continue;
      const scope = button.closest("section,[role=group]");
      const heading = scope?.querySelector("h1,h2,h3,h4,legend");
      if (!scope || !heading || !domain.group.test(text(heading))) continue;
      const peers = Array.from(scope.querySelectorAll('button[type="button"]')).filter(el => isSafeButton(el, domain));
      if (peers.length !== 1) continue;
      const current = rows(scope).length;
      if (current === 0 && controls(scope).length) continue;
      if (current >= targets[domain.id] || targets[domain.id] - current > 5) continue;
      const id = `add-${candidates.length}`;
      candidates.push({ id, domain: domain.id, label: text(button), current, target: targets[domain.id] });
      refs.set(id, { button, scope, domain, current, target: targets[domain.id], heading, headingText: text(heading) });
    }
    // Multiple indistinguishable sections of one type need human disambiguation.
    return { candidates: candidates.filter(c => candidates.filter(x => x.domain === c.domain).length === 1), refs };
  }
  function validatePlan(plan, candidates) {
    if (!Array.isArray(plan) || plan.length > 4) throw new Error("AI 新增计划格式无效。");
    const used = new Set();
    let total = 0;
    return plan.map(action => {
      const candidate = candidates.find(c => c.id === action?.id);
      if (!candidate || !Number.isInteger(candidate.current) || !Number.isInteger(candidate.target) || candidate.current < 0 ||
          used.has(action.id) || Object.keys(action).some(k => !["id", "count"].includes(k)) ||
          !Number.isInteger(action.count) || action.count < 1 || action.count !== candidate.target - candidate.current) {
        throw new Error("AI 计划超出允许的新增范围。");
      }
      used.add(action.id);
      total += action.count;
      if (total > 5) throw new Error("每次最多新增 5 条，请分次操作。");
      return { id: action.id, count: action.count };
    });
  }
  function waitForGrowth(ref, before, stopped) {
    const started = Date.now();
    return new Promise((resolve, reject) => {
      const check = () => {
        if (stopped()) return reject(new Error("已停止辅助新增；已经新增的空条目保留。"));
        if (!ref.scope.isConnected) return reject(new Error("页面分组已被替换，请手动检查。"));
        const now = rows(ref.scope).length;
        if (now === before + 1) return resolve();
        if (now > before + 1) return reject(new Error("页面一次新增了多个条目，已停止。"));
        if (Date.now() - started >= 2500) return reject(new Error("点击后未确认出现新条目，已停止；不会重复点击。"));
        setTimeout(check, 50);
      };
      check();
    });
  }
  // #225/#195：说明书定位的分组（北森这类 div 布局、条目不用 fieldset 的页面）。分组的新增按钮和已有条目
  // 来自深度分析校验过的大纲编号；条目数由这里按网页结构核对（说明书列出的条目数必须和网页对得上），
  // 新增几条仍由 targetCounts 算。数不清、对不上、分组有歧义时不给候选，只报原因，不猜。
  const STATE_CLASS = /(?:^|[-_])(?:active|hover|focus|focused|error|selected|open|opened|expanded|collapsed|disabled|checked|show|hidden|visible|first|last|odd|even|current|invalid|valid|dirty|touched|new|added)(?:$|[-_])|^(?:is|has)-/i;
  // 样式库生成的变体 class（styled-components 的 dyvPlo / ebfZZH、emotion 的 css-1x2y3z）：同一个组件的条目，
  // 最后一条和前面几条的变体可能不同（北森真机：最后一条带「添加」按钮），比结构时不算它们。
  const HASH_CLASS = /^(?:(?=[a-zA-Z]{5,8}$)(?=.*[a-z])(?=.*[A-Z]).*|css-[a-z0-9]+)$/;
  function signature(el) {
    const tokens = typeof el.className === "string"
      ? el.className.split(/\s+/).filter(token => token && !STATE_CLASS.test(token) && !HASH_CLASS.test(token)).sort() : [];
    return `${el.tagName}.${tokens.join(".")}`;
  }
  function commonAncestor(elements) {
    let node = elements[0]?.parentElement || null;
    while (node && !elements.every(el => node.contains(el))) node = node.parentElement;
    return node;
  }
  const bare = value => String(value ?? "").replace(/[\s\p{P}\p{S}]/gu, "");
  const containsAny = (node, list) => list.some(el => el !== node && node.contains(el));
  function specControls(ref) { return Array.from(ref.scope.querySelectorAll(editable)).filter(ref.visible); }
  function shapeOf(el, isVisible) {
    return Array.from(el.querySelectorAll(editable)).filter(isVisible).map(c => `${c.tagName}:${c.getAttribute("type") || ""}`).join(",");
  }
  // 一个元素里面是否像装着不止一条记录：同一层有两个以上结构相同、各含三个以上输入框且输入框排列相同的兄弟
  // （一个下拉、一个日期范围常常自带两个输入框，不能当成两条记录），
  // 或者（有题目时）同一个题目出现了两次。
  function looksRepeated(el, isVisible, labelOf) {
    for (const node of [el, ...el.querySelectorAll("*")]) {
      const children = Array.from(node.children || []);
      if (children.length < 2) continue;
      const seen = new Map();
      for (const child of children) {
        if (child.querySelectorAll(editable).length < 3) continue;
        const key = `${signature(child)}|${shapeOf(child, isVisible)}`;
        if (seen.has(key)) return true;
        seen.set(key, true);
      }
    }
    if (!labelOf) return false;
    const labels = Array.from(el.querySelectorAll(editable)).filter(isVisible).map(c => String(labelOf(c) || "").trim()).filter(Boolean);
    return new Set(labels).size !== labels.length;
  }
  function modelRows(ref) {
    const { parent, sig } = ref.model;
    if (!parent.isConnected) return [];
    return Array.from(parent.children).filter(child => signature(child) === sig && Array.from(child.querySelectorAll(editable)).some(ref.visible));
  }
  // 没有输入框不等于没有条目：查看态的条目只有文字。分组里除了按钮只允许有标题和一句提示（最多两段文字），
  // 出现像年份的数字、两段以上文字或很长的文字，就当作已经有条目，不能当成 0 条。
  function showsEntries(scope, button, isVisible) {
    const doc = scope.ownerDocument;
    const pieces = [];
    const walker = doc.createTreeWalker(scope, 4);
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      if (button.contains(node) || !node.parentElement || !isVisible(node.parentElement)) continue;
      const text = bare(node.data);
      if (text) pieces.push(text);
    }
    const all = pieces.join("");
    return pieces.length > 2 || /\d{4}/.test(all) || all.length > 60;
  }
  // group：{ domain, button, rows（已有条目里各取一个元素，一条一个）, others（别的分组的按钮和条目） }。
  function locateGroup(group, isVisible, labelOf) {
    const { button, rows: anchors = [], others = [] } = group;
    if (!button?.isConnected || !isVisible(button)) return { reason: "target_changed" };
    const top = button.ownerDocument?.body;
    let scope;
    if (!anchors.length) {
      // 还没有条目：从按钮往上找到最大的、不含任何输入框和别的分组的容器。
      scope = button.parentElement;
      for (let depth = 0; scope?.parentElement && scope.parentElement !== top && depth < 6; depth += 1) {
        const parent = scope.parentElement;
        if (Array.from(parent.querySelectorAll(editable)).some(isVisible) || containsAny(parent, others)) break;
        scope = parent;
      }
      if (!scope || scope === top || Array.from(scope.querySelectorAll(editable)).some(isVisible)) return { reason: "uncountable" };
      if (showsEntries(scope, button, isVisible)) return { reason: "uncountable" };
      return { scope, current: 0, model: null, anchor: null, initial: [] };
    }
    if (anchors.some(el => !el?.isConnected) || new Set(anchors).size !== anchors.length) return { reason: "uncountable" };
    scope = commonAncestor([button, ...anchors]);
    if (!scope || scope === top || scope === top?.parentElement || containsAny(scope, others)) return { reason: "ambiguous" };
    const all = Array.from(scope.querySelectorAll(editable)).filter(isVisible);
    // 「添加」按钮可能就在最后一条记录里面（北森真机），按钮和已有条目的公共祖先只是那一条：往上扩到
    // 只装着这一组输入框的最大容器，新记录插在旁边时才看得见。遇到别的输入框或别的分组就停。
    for (let depth = 0; scope.parentElement && scope.parentElement !== top && depth < 6; depth += 1) {
      const parent = scope.parentElement;
      if (containsAny(parent, others) || Array.from(parent.querySelectorAll(editable)).filter(isVisible).length !== all.length) break;
      scope = parent;
    }
    let model = null;
    if (anchors.length >= 2) {
      const parent = commonAncestor(anchors);
      if (!parent || !scope.contains(parent)) return { reason: "uncountable" };
      const rowsOf = anchors.map(el => { let node = el; while (node && node.parentElement !== parent) node = node.parentElement; return node; });
      if (rowsOf.some(row => !row) || new Set(rowsOf).size !== anchors.length) return { reason: "uncountable" };
      const sig = signature(rowsOf[0]);
      if (rowsOf.some(row => signature(row) !== sig)) return { reason: "uncountable" };
      model = { parent, sig };
      const found = modelRows({ model, visible: isVisible });
      // 网页上同结构的条目必须正好是说明书列出的这些；分组里也不能有条目以外的输入框。
      if (found.length !== anchors.length || !rowsOf.every(row => found.includes(row))) return { reason: "uncountable" };
      // 同结构但没有输入框的兄弟（查看态的条目）也是条目：有就数不清。
      // 整个藏起来的同结构兄弟（网页预留的模板行）用户看不到，不算条目。
      if (Array.from(parent.children).some(child => signature(child) === sig && !found.includes(child) && isVisible(child))) return { reason: "uncountable" };
      if (all.some(el => !found.some(row => row.contains(el)))) return { reason: "uncountable" };
      if (found.some(row => looksRepeated(row, isVisible, labelOf))) return { reason: "uncountable" };
    } else {
      let only = anchors[0];
      while (only.parentElement && only.parentElement !== scope && !only.parentElement.contains(button)) only = only.parentElement;
      if (all.some(el => !only.contains(el)) || looksRepeated(only, isVisible, labelOf)) return { reason: "uncountable" };
    }
    return { scope, current: anchors.length, model, anchor: anchors[0], initial: all };
  }
  // 按钮的结构和文字，用来在我们自己点完一次之后，找回同一分组里被网页重画或挪到新条目里的「添加」。
  const buttonKey = button => ({ sig: signature(button), text: bare(button.textContent) });
  // 和 collect() 同形的 { candidates, refs }，交给同一个 validatePlan / execute；另带 problems（没有给候选的分组和原因）。
  // options：isVisible、labelOf（输入框 → 题目，用来认出一个容器里装了两条记录）、allowed（按钮按网页当前样子重新判断）、
  // press（点击方式，默认 el.click()）。同类分组有两个以上时都不给候选（歧义）。
  function collectSpec(groups, fields, options = {}) {
    const isVisible = options.isVisible || visible;
    const targets = targetCounts(fields);
    const candidates = [];
    const refs = new Map();
    const problems = [];
    for (const domain of domains) {
      const mine = groups.filter(group => group.domain === domain.id);
      if (!mine.length || !targets[domain.id]) continue;
      if (mine.length > 1) { problems.push({ domain: domain.id, reason: "ambiguous" }); continue; }
      const located = locateGroup(mine[0], isVisible, options.labelOf);
      if (located.reason) { problems.push({ domain: domain.id, reason: located.reason }); continue; }
      if (located.current >= targets[domain.id]) continue;
      if (targets[domain.id] - located.current > 5) { problems.push({ domain: domain.id, reason: "over_limit", needed: targets[domain.id] - located.current }); continue; }
      const id = `add-${candidates.length}`;
      candidates.push({ id, domain: domain.id, label: domain.label, current: located.current, target: targets[domain.id] });
      refs.set(id, { spec: true, button: mine[0].button, buttonKey: buttonKey(mine[0].button), domain, visible: isVisible, labelOf: options.labelOf,
        allowed: options.allowed, press: options.press, timing: options.timing, target: targets[domain.id], ...located });
    }
    return { candidates, refs, problems };
  }
  function specSafe(ref) {
    const button = ref.button;
    return button.isConnected && ref.scope.isConnected && ref.scope.contains(button) && ref.visible(button) && !button.disabled &&
      button.getAttribute?.("aria-disabled") !== "true" && (!ref.allowed || ref.allowed(button) === true);
  }
  // 本次已经点过「添加」后，原按钮被网页重画或挪进了新的最后一条（北森真机）：在同一分组范围里找结构和文字
  // 都相同、看得见的唯一一个按钮接着用；找不到或不止一个就不点。第一次点击永远只点预览时确认的那个按钮。
  function rebindButton(ref) {
    const matches = Array.from(ref.scope.querySelectorAll("*")).filter(el => el !== ref.button && ref.visible(el)
      && signature(el) === ref.buttonKey.sig && bare(el.textContent) === ref.buttonKey.text);
    const outer = matches.filter(el => !matches.some(other => other !== el && other.contains(el)));
    if (outer.length !== 1) return false;
    ref.button = outer[0];
    return true;
  }
  // 点击后找新出现的输入框，把它们归成新记录：每个新输入框往上取到不含旧输入框的最大容器（「添加」按钮
  // 可能在条目里，不作为边界）；
  // 都归到同一个容器就是一条，归到几个结构相同的容器就是多条。有已有条目时，新记录还必须和已有条目是
  // 结构相同的兄弟。返回 none（还没变化）、one（正好一条）、many（多出多条）、unclear（有变化但归不成一条）。
  function detectSpecRow(ref, oldControls) {
    const fresh = specControls(ref).filter(el => !oldControls.includes(el));
    if (!fresh.length) return { state: "none" };
    const old = oldControls.filter(el => el.isConnected);
    const unclear = { state: "unclear", fresh: fresh.length };
    const climb = (start, avoid) => {
      let node = start;
      while (node.parentElement && node.parentElement !== ref.scope && !containsAny(node.parentElement, avoid)) {
        node = node.parentElement;
      }
      return node;
    };
    const tops = [...new Set(fresh.map(el => climb(el, old)))];
    if (tops.some(top => top === ref.scope || !ref.scope.contains(top))) return unclear;
    if (tops.length > 1) {
      const sig = signature(tops[0]);
      return tops.every(top => signature(top) === sig && top.querySelector(editable)) ? { state: "many", count: tops.length } : unclear;
    }
    const row = tops[0];
    if (looksRepeated(row, ref.visible, ref.labelOf)) return { state: "many", count: 2 };
    // 原来一条都没有：这一条就是第一条，条目的结构等下一次新增时和它对照。
    if (!ref.anchor) return { state: "one", row, model: null, anchor: fresh[0] };
    if (!ref.anchor.isConnected) return unclear;
    const existing = climb(ref.anchor, fresh);
    if (existing.parentElement !== row.parentElement || signature(existing) !== signature(row)) return unclear;
    const model = ref.model || { parent: row.parentElement, sig: signature(row) };
    if (model.parent !== row.parentElement || model.sig !== signature(row)) return unclear;
    const added = modelRows({ model, visible: ref.visible }).filter(item => !old.some(el => item.contains(el)));
    if (added.length > 1) return { state: "many", count: added.length };
    if (added.length !== 1 || added[0] !== row) return unclear;
    return { state: "one", row, model, anchor: ref.anchor };
  }
  function waitForSpecRow(ref, oldControls, stopped) {
    const { maxMs = 2500, settleMs = 300, pollMs = 50 } = ref.timing || {};
    const started = Date.now();
    let seen = null;
    return new Promise((resolve, reject) => {
      const fail = (message, grown) => { const error = new Error(message); error.grown = grown; reject(error); };
      // 停下时如实报告网页已经多出的条目（点击已经发出，网页可能已经加了一条）。
      const grownNow = () => {
        if (!ref.scope.isConnected) return 0;
        const found = detectSpecRow(ref, oldControls);
        return found.state === "many" ? found.count : found.state === "none" ? 0 : 1;
      };
      const check = () => {
        if (stopped()) return fail("已停止辅助新增；已经新增的空条目保留。", grownNow());
        if (!ref.scope.isConnected) return fail("页面分组已被替换，请手动检查。", 0);
        const found = detectSpecRow(ref, oldControls);
        if (found.state === "many") return fail("页面一次新增了多个条目，已停止。", found.count);
        // 认出一条后再看 300 毫秒，确认不是第一条之后还会再冒出一条。
        if (found.state === "one") {
          if (seen?.row !== found.row) seen = { row: found.row, at: Date.now() };
          else if (Date.now() - seen.at >= settleMs) return resolve(found);
        } else seen = null;
        if (Date.now() - started >= maxMs) {
          return found.state === "none"
            ? fail("点击后未确认出现新条目，已停止；不会重复点击。", 0)
            : fail("无法确定新增的条目，已停止填写，请手动核对。", found.state === "one" ? 1 : found.fresh ? 1 : 0);
        }
        setTimeout(check, pollMs);
      };
      check();
    });
  }
  async function addSpecRow(ref, action, i, added, hooks) {
    const { stopped, onProgress, beforeClick } = hooks;
    if (!specSafe(ref) && !(i > 0 && rebindButton(ref) && specSafe(ref))) throw new Error("新增按钮或分组已变化，请手动检查。");
    const oldControls = specControls(ref);
    const before = ref.model ? modelRows(ref).length : ref.current + i;
    // 第一次点之前，分组里的输入框必须还是预览时那些（模型还没定型时靠它确认条目没变）。
    if (!ref.model && i === 0 && (oldControls.length !== ref.initial.length || oldControls.some(el => !ref.initial.includes(el)))) {
      throw new Error("条目数量已变化，已停止。");
    }
    if (before !== ref.current + i || before >= ref.target) throw new Error("条目数量已变化，已停止。");
    const saved = oldControls.map(el => ({ el, value: el.value, checked: el.checked }));
    const step = { id: action.id, domain: ref.domain.id, index: i + 1, count: action.count, added };
    if (beforeClick && beforeClick(step) !== true) throw new Error("网页分组已变化，已停止。");
    if (onProgress) onProgress(step);
    if (ref.press) ref.press(ref.button); else ref.button.click();
    const found = await waitForSpecRow(ref, oldControls, stopped);
    ref.model = found.model;
    ref.anchor = found.anchor;
    if (saved.some(({ el, value, checked }) => !el.isConnected || el.value !== value || el.checked !== checked)) {
      const error = new Error("网页重建或改变了已有字段，已停止，请核对原内容。");
      error.grown = 1;
      throw error;
    }
    return found.row;
  }
  // `onProgress` only reports; it cannot change what is clicked. `beforeClick` can only add a
  // check: returning false stops before that click. A thrown error carries `added`, the rows the
  // page really gained, so a stop after a click is never under-reported.
  async function execute(plan, snapshot, stopped = () => false, onProgress = null, beforeClick = null) {
    const actions = validatePlan(plan, snapshot.candidates);
    let added = 0;
    const scopes = [];
    try {
      for (const action of actions) {
        const ref = snapshot.refs.get(action.id);
        if (ref.spec) {
          for (let i = 0; i < action.count; i++) {
            if (stopped()) throw new Error("已停止辅助新增；已经新增的空条目保留。");
            try {
              scopes.push(await addSpecRow(ref, action, i, added, { stopped, onProgress, beforeClick }));
            } catch (error) {
              if (Number.isInteger(error.grown)) added += error.grown;
              throw error;
            }
            added++;
          }
          continue;
        }
        if (rows(ref.scope).length !== ref.current) throw new Error("页面条目已变化，请重新预览。");
        for (let i = 0; i < action.count; i++) {
          if (stopped()) throw new Error("已停止辅助新增；已经新增的空条目保留。");
          if (!isSafeButton(ref.button, ref.domain) || !ref.scope.contains(ref.button) ||
              !ref.heading.isConnected || text(ref.heading) !== ref.headingText) throw new Error("新增按钮或分组已变化，请手动检查。");
          const beforeRows = rows(ref.scope);
          const before = beforeRows.length;
          if (before !== ref.current + i || before >= ref.target) throw new Error("条目数量已变化，已停止。");
          const saved = controls(ref.scope).map(el => ({ el, value: el.value, checked: el.checked }));
          const step = { id: action.id, domain: ref.domain.id, index: i + 1, count: action.count, added };
          if (beforeClick && beforeClick(step) !== true) throw new Error("网页分组已变化，已停止。");
          if (onProgress) onProgress(step);
          ref.button.click();
          try {
            await waitForGrowth(ref, before, stopped);
          } catch (error) {
            const grown = ref.scope.isConnected ? rows(ref.scope).length - before : 0;
            if (grown > 0) added += grown;
            throw error;
          }
          added++;
          const newRows = rows(ref.scope).filter(row => !beforeRows.includes(row));
          if (newRows.length !== 1) throw new Error("无法确定新增的条目，已停止填写，请手动核对。");
          if (controls(ref.scope).length <= saved.length) throw new Error("新条目没有可见输入框，已停止。");
          if (saved.some(({ el, value, checked }) => !el.isConnected || el.value !== value || el.checked !== checked)) {
            throw new Error("网页重建或改变了已有字段，已停止，请核对原内容。");
          }
          // Filling may touch this new row, never the pre-existing rows in its section.
          scopes.push(newRows[0]);
        }
      }
    } catch (error) {
      error.added = added;
      throw error;
    }
    return { added, scopes };
  }
  const labels = Object.fromEntries(domains.map(domain => [domain.id, domain.label]));
  const api = { targetCounts, collect, collectSpec, validatePlan, execute, labels };
  root.ResumeProFormAgent = api;
  try { if (typeof module === "object" && module && typeof module.exports === "object") module.exports = api; } catch { /* a page element or frame named "module" (#275) */ }
})(typeof self !== "undefined" ? self : globalThis);

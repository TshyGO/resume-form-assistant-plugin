(function (root) {
  const domains = [
    { id: "papers", label: "论文", buttons: "论文", group: /^(论文|论文成果|学术论文)$/, prefix: /^论文(\d+)/ },
    { id: "education", label: "教育经历", buttons: "教育经历|教育背景", group: /^(教育经历|教育背景)$/, prefix: /^(?:教育经历|教育背景|教育)(\d+)/ },
    { id: "work", label: "工作经历", buttons: "工作经历", group: /^工作经历$/, prefix: /^(?:工作经历|工作)(\d+)/ },
    { id: "projects", label: "项目经历", buttons: "项目经历", group: /^项目经历$/, prefix: /^(?:项目经历|项目)(\d+)/ }
  ];
  const editable = "input:not([type=hidden]):not([type=button]):not([type=submit]):not([type=file]),textarea,select";
  const visible = el => el.isConnected && el.getClientRects().length > 0;
  const text = el => (el.textContent || "").trim().replace(/\s+/g, " ");
  function targetCounts(fields) {
    return Object.fromEntries(domains.map(domain => {
      const records = new Set();
      for (const field of fields) {
        if (!domain.group.test(field.group || "") || !String(field.value || "").trim()) continue;
        const key = String(field.key || "");
        const numbered = key.match(domain.prefix);
        if (numbered) records.add(`number:${numbered[1]}`);
        else if (key.includes("-")) records.add(`anchor:${key.slice(0, key.indexOf("-"))}`);
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
          !Number.isInteger(action.count) || action.count < 1 || action.count > candidate.target - candidate.current) {
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
  async function execute(plan, snapshot, stopped = () => false) {
    const actions = validatePlan(plan, snapshot.candidates);
    let added = 0;
    const scopes = [];
    for (const action of actions) {
      const ref = snapshot.refs.get(action.id);
      if (rows(ref.scope).length !== ref.current) throw new Error("页面条目已变化，请重新预览。");
      for (let i = 0; i < action.count; i++) {
        if (stopped()) throw new Error("已停止辅助新增；已经新增的空条目保留。");
        if (!isSafeButton(ref.button, ref.domain) || !ref.scope.contains(ref.button) ||
            !ref.heading.isConnected || text(ref.heading) !== ref.headingText) throw new Error("新增按钮或分组已变化，请手动检查。");
        const before = rows(ref.scope).length;
        if (before !== ref.current + i || before >= ref.target) throw new Error("条目数量已变化，已停止。");
        const saved = controls(ref.scope).map(el => ({ el, value: el.value, checked: el.checked }));
        ref.button.click();
        await waitForGrowth(ref, before, stopped);
        if (controls(ref.scope).length <= saved.length) throw new Error("新条目没有可见输入框，已停止。");
        if (saved.some(({ el, value, checked }) => !el.isConnected || el.value !== value || el.checked !== checked)) {
          throw new Error("网页重建或改变了已有字段，已停止，请核对原内容。");
        }
        added++;
      }
      scopes.push(ref.scope);
    }
    return { added, scopes };
  }
  const api = { targetCounts, collect, validatePlan, execute };
  root.ResumeProFormAgent = api;
  if (typeof module !== "undefined") module.exports = api;
})(typeof self !== "undefined" ? self : globalThis);

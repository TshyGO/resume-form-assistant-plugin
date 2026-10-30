// #301 antd 换了类名前缀：ConfigProvider 的 prefixCls（antd 4、5 都支持）把整套类名里的 ant- 一致地换掉，
// 飞书招聘（*.jobs.feishu.cn、小米 mioffice）是 atsx-select、atsx-picker、atsx-form-item 这样。
// 插件里认 antd 的选择器和类名都按默认的 ant- 写：这里按文档算出页面用的前缀，把 .ant- 换成各个前缀拼出选择器。
// 前缀只按 antd 4、5 才有的结构认：X-select 下面直接是 X-select-selector，或 X-form-item-control-input 下面直接是
// X-form-item-control-input-content。只看一个类名的后缀不行，arco、iView、Semi、Element 也有 X-select、X-picker-input、
// X-form-item-label、X-select-dropdown 这样的类名。只读页面，不加类名、不改样式。
(function attachAntdPrefix(scope) {
  const DEFAULT = "ant";
  const SIGNS = [["select", "select-selector"], ["form-item-control-input", "form-item-control-input-content"]];
  const QUERY = SIGNS.map(([, inner]) => `[class*="-${inner}"]`).join(", ");
  // 拼进选择器的前缀只收字母、数字、横线和下划线。
  const PREFIX = /^[A-Za-z][\w-]*$/;
  // 表单可能后渲染：隔这么久重新看一次文档。认出过的前缀一直算。
  const RECHECK_MS = 1000;
  const MAX_BUILT = 500;
  const known = new WeakMap();
  const built = new Map();

  // 按节点所在的文档算：同源框架（#400）里的元素看框架自己的文档，开放的 ShadowRoot 看它自己。
  function rootOf(node) {
    if (!node || typeof node !== "object") return null;
    if (node.nodeType === 9 || node.nodeType === 11) return node;
    const root = typeof node.getRootNode === "function" ? node.getRootNode() : null;
    return root && (root.nodeType === 9 || root.nodeType === 11) ? root : node.ownerDocument || null;
  }

  function scan(root, found) {
    for (const el of root.querySelectorAll(QUERY)) {
      const parent = el.parentElement;
      if (!parent) continue;
      for (const name of String(el.getAttribute("class") || "").split(/\s+/)) {
        for (const [outer, inner] of SIGNS) {
          if (!name.endsWith(`-${inner}`)) continue;
          const prefix = name.slice(0, -inner.length - 1);
          if (prefix !== DEFAULT && PREFIX.test(prefix) && parent.classList.contains(`${prefix}-${outer}`)) found.add(prefix);
        }
      }
    }
  }

  // 页面用的前缀：默认的 ant 在最前面，后面是认出来的。
  function prefixes(node) {
    const root = rootOf(node);
    if (typeof root?.querySelectorAll !== "function") return [DEFAULT];
    const now = Date.now();
    let entry = known.get(root);
    if (!entry || now - entry.at >= RECHECK_MS) {
      const found = new Set(entry?.found);
      try {
        scan(root, found);
      } catch {
        // 页面改过的 DOM 读出错：按已经认出的算。
      }
      entry = { at: now, found, list: [DEFAULT, ...found] };
      known.set(root, entry);
    }
    return entry.list;
  }

  // 按顶层的逗号拆开选择器列表，括号和引号里的逗号不算。
  function split(selector) {
    const parts = [];
    let depth = 0;
    let quote = "";
    let start = 0;
    for (let i = 0; i < selector.length; i += 1) {
      const c = selector[i];
      if (quote) {
        if (c === quote) quote = "";
      } else if (c === "\"" || c === "'") {
        quote = c;
      } else if (c === "(" || c === "[") {
        depth += 1;
      } else if (c === ")" || c === "]") {
        depth -= 1;
      } else if (c === "," && depth === 0) {
        parts.push(selector.slice(start, i).trim());
        start = i + 1;
      }
    }
    parts.push(selector.slice(start).trim());
    return parts.filter(Boolean);
  }

  // 选择器列表里带 .ant- 的每一项按页面的前缀各拼一份，别的项原样留着。页面只用默认前缀时原样返回。
  function css(node, selector) {
    const list = prefixes(node);
    if (list.length === 1) return selector;
    const key = `${list.join(" ")}|${selector}`;
    let out = built.get(key);
    if (out === undefined) {
      out = split(selector).flatMap((part) => (part.includes(".ant-")
        ? list.map((prefix) => part.replaceAll(".ant-", `.${prefix}-`)) : [part])).join(", ");
      if (built.size >= MAX_BUILT) built.clear();
      built.set(key, out);
    }
    return out;
  }

  // 类名换回默认前缀（atsx-select → ant-select），给按类名比对、按 ant- 认组件库的地方用。
  function token(node, name) {
    const text = String(name ?? "");
    for (const prefix of prefixes(node)) {
      if (prefix !== DEFAULT && text.startsWith(`${prefix}-`)) return `${DEFAULT}-${text.slice(prefix.length + 1)}`;
    }
    return text;
  }

  // 元素带不带某个按默认前缀写的 antd 类名，换了前缀的也算。
  function has(el, name) {
    if (!el?.classList) return false;
    if (el.classList.contains(name)) return true;
    if (!name.startsWith(`${DEFAULT}-`)) return false;
    const rest = name.slice(DEFAULT.length + 1);
    return prefixes(el).some((prefix) => prefix !== DEFAULT && el.classList.contains(`${prefix}-${rest}`));
  }

  const api = { prefixes, css, token, has };
  scope.ResumeProAntdPrefix = api;
  try {
    if (typeof module === "object" && module && typeof module.exports === "object") module.exports = api;
  } catch {
    // A page element or frame named "module" (#275).
  }
})(typeof self !== "undefined" ? self : globalThis);

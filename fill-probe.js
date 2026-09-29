// #206 填写诊断用的只读页面探测。只看结构：标签名、type、role、组件库 class 前缀和计数；
// 从不读取字段值、页面正文或完整网址。content.js 经 withFillProbe() 调用，
// 这里缺席或出错时诊断退回原样，填写不受影响。
(function (root) {
  const LIBRARIES = [
    ["antd", /^ant-/], ["element", /^el-/], ["arco", /^arco-/], ["iview", /^ivu-/],
    ["semi", /^semi-/], ["vant", /^van-/], ["layui", /^layui-/], ["mui", /^Mui/]
  ];
  const TOKEN = /^[a-z][a-z-]{0,23}$/;
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
    if (/[@＠]|\d{5,}/.test(text)) return "（字段名已隐藏）";
    return text.length > MAX_LABEL ? `${text.slice(0, MAX_LABEL)}…` : text;
  }

  const api = { describeControl, safeLabel };
  root.ResumeProFillProbe = api;
  if (typeof module !== "undefined") module.exports = api;
})(typeof self !== "undefined" ? self : globalThis);

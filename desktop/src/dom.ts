// 取 DOM 节点的小工具。
//
// 以前每处都是 `document.getElementById("x")`，类型上是 `HTMLElement | null`，代码里靠
// `?.` 和运气；元素改名或删掉时，界面只是安静地少做一件事。这里把两种意图分开说清楚：
//
// - `must(id)`：这个元素必须存在，不存在就当场报错（少一个 id 是模板的 bug，不是运行时状态）。
// - `maybe(id)`：这个元素可能不在（不同视图共用的代码），拿不到就跳过。

export function must<T extends HTMLElement = HTMLElement>(id: string): T {
  const node = document.getElementById(id);
  if (!node) throw new Error(`页面上缺少元素 #${id}`);
  return node as T;
}

export function maybe<T extends HTMLElement = HTMLElement>(id: string): T | null {
  return document.getElementById(id) as T | null;
}

export function input(id: string): HTMLInputElement {
  return must<HTMLInputElement>(id);
}

export function textarea(id: string): HTMLTextAreaElement {
  return must<HTMLTextAreaElement>(id);
}

export function select(id: string): HTMLSelectElement {
  return must<HTMLSelectElement>(id);
}

export function dialog(id: string): HTMLDialogElement {
  return must<HTMLDialogElement>(id);
}

/** 表单控件的值，元素不在就当空字符串——读值的地方不该因为一个 id 崩掉整个视图。 */
export function valueOf(id: string): string {
  const node = document.getElementById(id) as HTMLInputElement | HTMLSelectElement | null;
  return node?.value ?? "";
}

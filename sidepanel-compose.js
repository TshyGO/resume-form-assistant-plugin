// Field composition for the native side panel (#174): what a resume row looks like and
// which of its three actions may run against the page's current target.
//
// The page controller answers with booleans and chip ids only. This file keeps just that:
// it never sees, and so can never keep or send on, what is typed in the page's text box.
(function (root, factory) {
  const api = factory();
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.ResumeProCompose = api;
})(typeof self !== "undefined" ? self : globalThis, () => {
  const ACTIONS = [
    { id: "add", label: "添加" },
    { id: "replace", label: "替换" },
    { id: "remove", label: "删除" }
  ];

  const escapeHtml = (value) => String(value ?? "")
    .replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;").replaceAll("'", "&#39;");

  function emptyTargetState() {
    return { targetAvailable: false, composable: false, empty: true, selectedChipIds: new Set(), actions: new Map() };
  }

  // Anything the page sends besides the documented fields is dropped here.
  function normalizeTargetState(raw) {
    if (!raw || raw.ok === false || raw.targetAvailable !== true) return emptyTargetState();
    const state = emptyTargetState();
    state.targetAvailable = true;
    if (raw.composable !== true) return state;
    state.composable = true;
    state.empty = raw.empty === true;
    if (Array.isArray(raw.selectedChipIds)) {
      raw.selectedChipIds.forEach((id) => { if (typeof id === "string" && id) state.selectedChipIds.add(id); });
    }
    if (raw.actions && typeof raw.actions === "object") {
      Object.entries(raw.actions).forEach(([chipId, item]) => {
        state.actions.set(chipId, { add: item?.add === true, replace: item?.replace === true, remove: item?.remove === true });
      });
    }
    return state;
  }

  // Composition is possible only on a plain text target; otherwise every action stays disabled.
  function rowState(state, chipId) {
    const none = { selected: false, add: false, replace: false, remove: false };
    if (!state?.composable) return none;
    const actions = state.actions.get(chipId);
    return { selected: state.selectedChipIds.has(chipId), add: Boolean(actions?.add), replace: Boolean(actions?.replace), remove: Boolean(actions?.remove) };
  }

  // Three buttons per row, always rendered in the same order, so nothing moves when state changes.
  function renderRow(field, variant = "group") {
    const id = escapeHtml(field.chipId);
    const key = escapeHtml(field.key);
    const search = variant === "group" ? ` data-search="${escapeHtml(`${field.key} ${field.value}`.toLocaleLowerCase())}"` : "";
    const buttons = ACTIONS.map((action) => `<button type="button" class="field-row__action" data-chip-id="${id}" data-action="${action.id}" aria-label="${action.label} ${key}" disabled>${action.label}</button>`).join("");
    return `<div class="field-row field-row--${variant}" data-chip-id="${id}"${search}><button type="button" class="field-row__fill" data-role="fill" data-chip-id="${id}" aria-pressed="false"><span class="row-key">${key}</span><span class="row-value" title="${escapeHtml(field.value)}">${escapeHtml(field.value)}</span></button><span class="field-row__actions" role="group" aria-label="${key}">${buttons}</span></div>`;
  }

  function applyTargetState(containers, state) {
    for (const container of containers) {
      container.querySelectorAll(".field-row").forEach((row) => {
        const current = rowState(state, row.dataset.chipId);
        row.classList.toggle("is-in-field", current.selected);
        row.querySelector('[data-role="fill"]')?.setAttribute("aria-pressed", String(current.selected));
        row.querySelectorAll("[data-action]").forEach((button) => { button.disabled = !current[button.dataset.action]; });
      });
    }
  }

  return { ACTIONS, emptyTargetState, normalizeTargetState, rowState, renderRow, applyTargetState };
});

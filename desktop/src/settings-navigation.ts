/** Keep every settings panel mounted, so switching categories never drops an unsaved draft. */
export function mountSettingsNavigation(root: HTMLElement, onSelect: (name: string) => void) {
  const tabs = Array.from(root.querySelectorAll<HTMLButtonElement>("[data-settings-tab]"));
  const panels = root.querySelectorAll<HTMLElement>("[data-settings-panel]");
  function select(name: string, focus = false) {
    const selected = tabs.find((tab) => tab.dataset.settingsTab === name);
    if (!selected) return;
    tabs.forEach((tab) => {
      tab.setAttribute("aria-selected", String(tab === selected));
      tab.tabIndex = tab === selected ? 0 : -1;
    });
    panels.forEach((panel) => { panel.hidden = panel.dataset.settingsPanel !== name; });
    if (focus) selected.focus();
    onSelect(name);
  }
  tabs.forEach((tab, index) => {
    tab.addEventListener("click", () => select(tab.dataset.settingsTab!));
    tab.addEventListener("keydown", (event) => {
      let next: number;
      if (event.key === "ArrowDown" || event.key === "ArrowRight") next = (index + 1) % tabs.length;
      else if (event.key === "ArrowUp" || event.key === "ArrowLeft") next = (index + tabs.length - 1) % tabs.length;
      else if (event.key === "Home") next = 0;
      else if (event.key === "End") next = tabs.length - 1;
      else return;
      event.preventDefault();
      select(tabs[next].dataset.settingsTab!, true);
    });
  });
  return { select };
}

/** Presentation-only tabs and disclosure menus; application commands stay in the controller. */
export function bindDetailControls(root: HTMLElement, initialTab: string, onTab: (tab: string) => void) {
  const tabs = Array.from(root.querySelectorAll<HTMLButtonElement>("[data-detail-tab]"));
  const panels = root.querySelectorAll<HTMLElement>("[data-detail-panel]");
  const menus = root.querySelectorAll<HTMLDetailsElement>(".action-menu");
  function select(tab: HTMLButtonElement) {
    const name = tab.dataset.detailTab!;
    tabs.forEach((item) => {
      const selected = item === tab;
      item.setAttribute("aria-selected", String(selected));
      item.tabIndex = selected ? 0 : -1;
    });
    panels.forEach((panel) => { panel.hidden = panel.dataset.detailPanel !== name; });
    onTab(name);
  }
  tabs.forEach((tab, index) => {
    tab.addEventListener("click", () => select(tab));
    tab.addEventListener("keydown", (event) => {
      let next: number;
      if (event.key === "ArrowRight") next = (index + 1) % tabs.length;
      else if (event.key === "ArrowLeft") next = (index + tabs.length - 1) % tabs.length;
      else if (event.key === "Home") next = 0;
      else if (event.key === "End") next = tabs.length - 1;
      else return;
      event.preventDefault();
      select(tabs[next]);
      tabs[next].focus();
    });
  });
  const initial = tabs.find((tab) => tab.dataset.detailTab === initialTab) ?? tabs[0];
  if (initial) select(initial);
  menus.forEach((menu) => {
    menu.addEventListener("toggle", () => {
      if (menu.open) menus.forEach((other) => { if (other !== menu) other.open = false; });
    });
    menu.addEventListener("keydown", (event) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      menu.open = false;
      menu.querySelector("summary")?.focus();
    });
    menu.querySelectorAll("button").forEach((button) => {
      button.addEventListener("click", () => { menu.open = false; });
    });
  });
}

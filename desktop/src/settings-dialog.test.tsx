import { afterEach, expect, test } from "vitest";
import { fireEvent, waitFor, within } from "@testing-library/dom";
import { openSettingsDialog, paragraph } from "./settings-dialog";

afterEach(() => { document.body.innerHTML = ""; });

function current() {
  return document.querySelector<HTMLDialogElement>("dialog.settings-dialog");
}

test("cancel is on the left, the named action on the right; danger dialogs start on cancel", async () => {
  const trigger = document.body.appendChild(document.createElement("button"));
  trigger.focus();
  const result = openSettingsDialog({ title: "退出网申快填？", body: paragraph("说明"), confirmLabel: "退出应用", tone: "danger" });
  const dialog = current()!;
  expect(dialog.getAttribute("aria-labelledby")).toBeTruthy();
  expect(within(dialog).getByRole("heading").textContent).toBe("退出网申快填？");
  expect(Array.from(dialog.querySelectorAll(".settings-dialog-actions button"), (b) => b.textContent)).toEqual(["取消", "退出应用"]);
  expect(document.activeElement?.textContent).toBe("取消");
  fireEvent.click(within(dialog).getByRole("button", { name: "取消" }));
  await expect(result).resolves.toBe(false);
  expect(current()).toBeNull();
  expect(document.activeElement).toBe(trigger);
});

test("while the action runs nothing can close it twice; a failure stays in the dialog and can be retried", async () => {
  let attempt = 0;
  let release: () => void = () => {};
  const result = openSettingsDialog({
    title: "换回这个回滚点？",
    confirmLabel: "换回这一份",
    busyLabel: "正在换回…",
    action: () => new Promise<void>((resolve, reject) => {
      attempt += 1;
      if (attempt === 1) reject(new Error("磁盘满了"));
      else release = resolve;
    }),
  });
  const dialog = current()!;
  const confirm = within(dialog).getByRole("button", { name: "换回这一份" });
  fireEvent.click(confirm);
  await waitFor(() => expect(within(dialog).getByRole("alert").textContent).toBe("磁盘满了"));
  expect(current()).toBe(dialog);
  fireEvent.click(confirm);
  await waitFor(() => expect(confirm.textContent).toBe("正在换回…"));
  expect((confirm as HTMLButtonElement).disabled).toBe(true);
  fireEvent.keyDown(dialog, { key: "Escape" });
  fireEvent(dialog, new Event("cancel", { cancelable: true }));
  expect(current()).toBe(dialog);
  release();
  await expect(result).resolves.toBe(true);
  expect(attempt).toBe(2);
  expect(current()).toBeNull();
});

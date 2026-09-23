import { afterEach, expect, test } from "vitest";
import { act, waitFor, within } from "@testing-library/react";
import type { Invoke, ProfileRecordView, ResumeOverview } from "../api.ts";
import { mountResume } from "./mount.tsx";

const overviewOf = (name: string): ResumeOverview => ({
  templates: [{ id: "t1", name, fieldCount: 1, updatedAt: "2026-09-23T00:00:00Z" }],
  activeTemplateId: "t1",
});

const profileOf = (name: string, revision: number): ProfileRecordView => ({
  profile: { values: { name }, family: [], custom: [] },
  revision,
});

let cleanup: (() => void) | null = null;
afterEach(() => {
  cleanup?.();
  cleanup = null;
});

// 恢复备份会整库换掉档案；简历页只挂载一次的话会留着旧的列表和旧的「我的信息」版本号，
// 接着保存就可能盖掉刚恢复回来的内容。refresh() 要让两块都重新读一遍。
test("refresh 重新挂载简历页，模板列表与「我的信息」都重新读取", async () => {
  let restored = false;
  const invoke = (async (command: string) => {
    if (command === "resume_overview_cmd") return overviewOf(restored ? "恢复后的模板" : "旧模板");
    if (command === "get_profile_cmd") return restored ? profileOf("恢复后", 7) : profileOf("旧名字", 3);
    throw { code: "UNEXPECTED", message: command };
  }) as Invoke;
  const container = document.createElement("div");
  document.body.append(container);
  let handle!: ReturnType<typeof mountResume>;
  act(() => {
    handle = mountResume(container, invoke, null);
  });
  cleanup = () => {
    act(() => handle.unmount());
    container.remove();
  };
  const view = within(container as HTMLElement);
  expect(await view.findByText("旧模板")).toBeTruthy();
  expect(await view.findByDisplayValue("旧名字")).toBeTruthy();

  restored = true;
  act(() => handle.refresh());

  expect(await view.findByText("恢复后的模板")).toBeTruthy();
  await waitFor(() => expect(view.getByDisplayValue("恢复后")).toBeTruthy());
  expect(view.queryByText("旧模板")).toBeNull();
});

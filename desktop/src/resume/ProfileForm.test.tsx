import { expect, test } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { Invoke, ProfileRecordView } from "../api.ts";
import { InvokeProvider } from "../react/invoke.tsx";
import { ProfileForm } from "./ProfileForm.tsx";

const record: ProfileRecordView = {
  profile: {
    values: { name: "张三", gender: "男" },
    family: [{ relation: "父亲", name: "张大", birth: "", political: "", company: "", job: "", phone: "" }],
    custom: [{ key: "户籍派出所", value: "" }],
  },
  revision: 3,
};

function mount(handler: (command: string, args?: Record<string, unknown>) => unknown) {
  const calls: Array<{ command: string; args?: Record<string, unknown> }> = [];
  const invoke = (async (command: string, args?: Record<string, unknown>) => {
    calls.push({ command, args });
    return handler(command, args);
  }) as Invoke;
  render(
    <InvokeProvider invoke={invoke}>
      <ProfileForm />
    </InvokeProvider>,
  );
  return calls;
}

test("按字段定义画出表单并填好已有内容", async () => {
  mount(() => record);
  expect(await screen.findByLabelText("姓名")).toHaveProperty("value", "张三");
  expect(screen.getByLabelText("性别")).toHaveProperty("value", "男");
  expect(screen.getByLabelText("身高（厘米）")).toBeTruthy();
  expect(screen.getByText("基本信息")).toBeTruthy();
});

test("待补充的补充字段要标出来", async () => {
  mount(() => record);
  const row = await screen.findByRole("group", { name: /户籍派出所/ });
  expect(within(row).getByText("待补充")).toBeTruthy();
});

test("保存时带上读到的版本号和规范化后的档案", async () => {
  const user = userEvent.setup();
  const calls = mount((command, args) =>
    command === "save_profile_cmd" ? { profile: args?.profile, revision: 4 } : record,
  );
  const name = await screen.findByLabelText("姓名");
  await user.clear(name);
  await user.type(name, " 李四 ");
  await user.click(screen.getByRole("button", { name: "保存我的信息" }));
  await waitFor(() => expect(screen.getByText("已保存。")).toBeTruthy());
  const saved = calls.find((c) => c.command === "save_profile_cmd")!.args!;
  expect(saved.revision).toBe(3);
  expect((saved.profile as { values: Record<string, string> }).values.name).toBe("李四");
});

test("版本冲突时提示刷新，不覆盖", async () => {
  const user = userEvent.setup();
  mount((command) => {
    if (command === "save_profile_cmd") throw { code: "CONFLICT", message: "「我的信息」已在别处改过，请刷新后再保存。" };
    return record;
  });
  await screen.findByLabelText("姓名");
  await user.click(screen.getByRole("button", { name: "保存我的信息" }));
  expect(await screen.findByText(/已在别处改过/)).toBeTruthy();
  expect(screen.getByRole("button", { name: "重新读取" })).toBeTruthy();
});

test("可以加家庭成员和补充字段", async () => {
  const user = userEvent.setup();
  const calls = mount((command, args) =>
    command === "save_profile_cmd" ? { profile: args?.profile, revision: 4 } : record,
  );
  await screen.findByLabelText("姓名");
  await user.click(screen.getByRole("button", { name: "添加家庭成员" }));
  await user.click(screen.getByRole("button", { name: "添加补充字段" }));
  const keys = screen.getAllByLabelText("字段名");
  await user.type(keys[keys.length - 1], "紧急联系人邮箱");
  await user.click(screen.getByRole("button", { name: "保存我的信息" }));
  await waitFor(() => expect(calls.some((c) => c.command === "save_profile_cmd")).toBe(true));
  const saved = calls.find((c) => c.command === "save_profile_cmd")!.args!.profile as { custom: Array<{ key: string }> };
  expect(saved.custom.map((c) => c.key)).toContain("紧急联系人邮箱");
});

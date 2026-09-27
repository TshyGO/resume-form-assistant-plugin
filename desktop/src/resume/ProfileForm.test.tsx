import { expect, test } from "vitest";
import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { Invoke, ProfileRecordView } from "../api.ts";
import { InvokeProvider } from "../react/invoke.tsx";
import { ProfileForm } from "./ProfileForm.tsx";
import type { Listen } from "./LegacyImport.tsx";

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

// #177：插件在后台把补充字段写进档案后，桌面发 resume-profile-changed（不带内容）。
// 这里假一个 listen，测试里直接调 fire() 模拟事件到达，不用真的起 Tauri。
function mountWithListen(handler: (command: string, args?: Record<string, unknown>) => unknown) {
  const calls: Array<{ command: string; args?: Record<string, unknown> }> = [];
  const invoke = (async (command: string, args?: Record<string, unknown>) => {
    calls.push({ command, args });
    return handler(command, args);
  }) as Invoke;
  let handlerRef: ((event?: { payload?: unknown }) => void) | null = null;
  const listen: Listen = (name, cb) => {
    if (name === "resume-profile-changed") handlerRef = cb;
    return () => {
      handlerRef = null;
    };
  };
  render(
    <InvokeProvider invoke={invoke}>
      <ProfileForm listen={listen} />
    </InvokeProvider>,
  );
  return {
    calls,
    fire: (revision = 4) => handlerRef?.({ payload: { revision, source: "plugin" } }),
  };
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
  // 与插件 popup.js saveProfile 同款措辞：已保存的项数 + 还没填的补充字段数。
  await waitFor(() => expect(screen.getByText("已保存 4 项，还有 1 个字段没填内容。")).toBeTruthy());
  const saved = calls.find((c) => c.command === "save_profile_cmd")!.args!;
  expect(saved.revision).toBe(3);
  expect((saved.profile as { values: Record<string, string> }).values.name).toBe("李四");
});

test("版本冲突时提示刷新，不覆盖", async () => {
  const user = userEvent.setup();
  let reads = 0;
  const fresh: ProfileRecordView = {
    profile: { ...record.profile, values: { ...record.profile.values, name: "服务器新值" } },
    revision: 4,
  };
  mount((command) => {
    if (command === "save_profile_cmd") throw { code: "CONFLICT", message: "「我的信息」已在别处改过，请刷新后再保存。" };
    reads += 1;
    return reads === 1 ? record : fresh;
  });
  const name = await screen.findByLabelText("姓名");
  await user.type(name, "五");
  await user.click(screen.getByRole("button", { name: "保存我的信息" }));
  expect(await screen.findByText(/已在别处改过/)).toBeTruthy();
  await user.click(screen.getByRole("button", { name: "放弃未保存修改并重新读取" }));
  await user.click(screen.getByRole("button", { name: "确定放弃并重新读取" }));
  await waitFor(() => expect(screen.getByLabelText("姓名")).toHaveProperty("value", "服务器新值"));
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

test("下拉框的存量值不在选项里时，也原样显示出来，不被首个空选项吃掉", async () => {
  const withStrayValue: ProfileRecordView = {
    ...record,
    profile: { ...record.profile, values: { ...record.profile.values, gender: "其他" } },
  };
  mount(() => withStrayValue);
  const select = (await screen.findByLabelText("性别")) as HTMLSelectElement;
  expect(select.value).toBe("其他");
  expect(within(select).getByRole("option", { name: "其他" })).toBeTruthy();
});

test("补充字段没填字段名时不标待补充", async () => {
  const user = userEvent.setup();
  mount(() => record);
  await screen.findByLabelText("姓名");
  await user.click(screen.getByRole("button", { name: "添加补充字段" }));
  const newRow = screen.getByRole("group", { name: "补充字段 2" });
  expect(within(newRow).queryByText("待补充")).toBeNull();
});

test("出生年月没有自定义占位符时显示 YYYY-MM", async () => {
  mount(() => record);
  const birth = (await screen.findByLabelText("出生年月")) as HTMLInputElement;
  expect(birth.placeholder).toBe("YYYY-MM");
});

test("保存后再编辑会清掉上一次的提示", async () => {
  const user = userEvent.setup();
  mount((command, args) => (command === "save_profile_cmd" ? { profile: args?.profile, revision: 4 } : record));
  const name = await screen.findByLabelText("姓名");
  await user.click(screen.getByRole("button", { name: "保存我的信息" }));
  await waitFor(() => expect(screen.getByText(/已保存/)).toBeTruthy());
  await user.type(name, "五");
  expect(screen.queryByText(/已保存/)).toBeNull();
});

test("表单干净时，插件写入后自动重新读取（#177）", async () => {
  let reads = 0;
  const updated: ProfileRecordView = {
    profile: { ...record.profile, custom: [...record.profile.custom, { key: "国籍", value: "" }] },
    revision: 4,
  };
  const { fire } = mountWithListen((command) => {
    if (command !== "get_profile_cmd") throw new Error(`意外调用 ${command}`);
    reads += 1;
    return reads === 1 ? record : updated;
  });
  await screen.findByLabelText("姓名");
  await act(async () => fire());
  await waitFor(() => expect(screen.getByRole("group", { name: /国籍/ })).toBeTruthy());
  expect(reads).toBe(2);
});

test("有未保存修改时，插件写入只提示，不覆盖正在改的内容（#177）", async () => {
  const user = userEvent.setup();
  const { fire } = mountWithListen((command) => {
    if (command !== "get_profile_cmd") throw new Error(`意外调用 ${command}`);
    return record;
  });
  const name = await screen.findByLabelText("姓名");
  await user.type(name, "五");
  await act(async () => fire());
  expect(await screen.findByText("插件添加了新的补充字段。当前页面还有未保存的修改。")).toBeTruthy();
  expect(name).toHaveProperty("value", "张三五");
});

test("提示里点重新读取：放弃未保存修改，显示插件新增的字段（#177）", async () => {
  const user = userEvent.setup();
  let reads = 0;
  const updated: ProfileRecordView = {
    profile: { ...record.profile, custom: [...record.profile.custom, { key: "国籍", value: "" }] },
    revision: 4,
  };
  const { fire } = mountWithListen((command) => {
    if (command !== "get_profile_cmd") throw new Error(`意外调用 ${command}`);
    reads += 1;
    return reads === 1 ? record : updated;
  });
  const name = await screen.findByLabelText("姓名");
  await user.type(name, "五");
  await act(async () => fire());
  await screen.findByText(/插件添加了新的补充字段/);
  await user.click(screen.getByRole("button", { name: "放弃未保存修改并重新读取" }));
  await user.click(screen.getByRole("button", { name: "确定放弃并重新读取" }));
  await waitFor(() => expect(screen.getByRole("group", { name: /国籍/ })).toBeTruthy());
  expect(screen.getByLabelText("姓名")).toHaveProperty("value", "张三");
  expect(screen.queryByText(/插件添加了新的补充字段/)).toBeNull();
});

test("提示里点稍后处理：保留未保存修改，不刷新（#177）", async () => {
  const user = userEvent.setup();
  const { fire, calls } = mountWithListen((command) => {
    if (command !== "get_profile_cmd") throw new Error(`意外调用 ${command}`);
    return record;
  });
  const name = await screen.findByLabelText("姓名");
  await user.type(name, "五");
  await act(async () => fire());
  await screen.findByText(/插件添加了新的补充字段/);
  const readsBefore = calls.filter((c) => c.command === "get_profile_cmd").length;
  await user.click(screen.getByRole("button", { name: "稍后处理" }));
  expect(screen.getByText(/有待同步的补充字段/)).toBeTruthy();
  expect(screen.getByRole("button", { name: "放弃未保存修改并重新读取" })).toBeTruthy();
  expect(name).toHaveProperty("value", "张三五");
  expect(calls.filter((c) => c.command === "get_profile_cmd").length).toBe(readsBefore);
});

test("重复或旧 revision 不会反复重新读取（#177）", async () => {
  const { fire, calls } = mountWithListen((command) => {
    if (command !== "get_profile_cmd") throw new Error(`意外调用 ${command}`);
    return record;
  });
  await screen.findByLabelText("姓名");
  const readsBefore = calls.filter((c) => c.command === "get_profile_cmd").length;
  await act(async () => fire(record.revision));
  await act(async () => fire(record.revision - 1));
  expect(calls.filter((c) => c.command === "get_profile_cmd").length).toBe(readsBefore);
});

test("自动读取尚未返回时开始编辑，也不会被外部数据覆盖（#177）", async () => {
  const user = userEvent.setup();
  let reads = 0;
  let finishRead: ((value: ProfileRecordView) => void) | null = null;
  const updated: ProfileRecordView = {
    profile: { ...record.profile, custom: [...record.profile.custom, { key: "国籍", value: "" }] },
    revision: 4,
  };
  const { fire } = mountWithListen((command) => {
    if (command !== "get_profile_cmd") throw new Error(`意外调用 ${command}`);
    reads += 1;
    if (reads === 1) return record;
    return new Promise<ProfileRecordView>((resolve) => {
      finishRead = resolve;
    });
  });
  const name = await screen.findByLabelText("姓名");
  await act(async () => fire());
  await waitFor(() => expect(reads).toBe(2));
  await user.type(name, "五");
  await act(async () => finishRead?.(updated));
  expect(name).toHaveProperty("value", "张三五");
  expect(await screen.findByText(/插件添加了新的补充字段/)).toBeTruthy();
  expect(screen.queryByRole("group", { name: /国籍/ })).toBeNull();
  await user.click(screen.getByRole("button", { name: "稍后处理" }));
  const readsBefore = reads;
  await act(async () => fire(updated.revision));
  expect(screen.queryByText(/插件添加了新的补充字段/)).toBeNull();
  expect(reads).toBe(readsBefore);
});

test("并发外部读取只采用最后发起的一次，不被晚到的旧响应回滚（#177）", async () => {
  let reads = 0;
  let finishOlder: ((value: ProfileRecordView) => void) | null = null;
  let finishNewer: ((value: ProfileRecordView) => void) | null = null;
  const older: ProfileRecordView = {
    profile: { ...record.profile, custom: [...record.profile.custom, { key: "旧字段", value: "" }] },
    revision: 4,
  };
  const newer: ProfileRecordView = {
    profile: { ...record.profile, custom: [...record.profile.custom, { key: "新字段", value: "" }] },
    revision: 5,
  };
  const { fire } = mountWithListen((command) => {
    if (command !== "get_profile_cmd") throw new Error(`意外调用 ${command}`);
    reads += 1;
    if (reads === 1) return record;
    return new Promise<ProfileRecordView>((resolve) => {
      if (reads === 2) finishOlder = resolve;
      else finishNewer = resolve;
    });
  });
  await screen.findByLabelText("姓名");
  await act(async () => fire(4));
  await waitFor(() => expect(reads).toBe(2));
  await act(async () => fire(4));
  expect(reads).toBe(2);
  await act(async () => fire(5));
  await waitFor(() => expect(reads).toBe(3));
  await act(async () => finishNewer?.(newer));
  expect(await screen.findByRole("group", { name: /新字段/ })).toBeTruthy();
  await act(async () => finishOlder?.(older));
  expect(screen.getByRole("group", { name: /新字段/ })).toBeTruthy();
  expect(screen.queryByRole("group", { name: /旧字段/ })).toBeNull();
});

test("主动重新读取后继续输入，新输入不会被晚到的读取覆盖（#177）", async () => {
  const user = userEvent.setup();
  let reads = 0;
  let finishRead: ((value: ProfileRecordView) => void) | null = null;
  const fresh: ProfileRecordView = {
    profile: { ...record.profile, values: { ...record.profile.values, name: "服务器新值" } },
    revision: 4,
  };
  mount((command) => {
    if (command === "save_profile_cmd") throw { code: "CONFLICT", message: "「我的信息」已在别处改过，请刷新后再保存。" };
    reads += 1;
    if (reads === 1) return record;
    return new Promise<ProfileRecordView>((resolve) => {
      finishRead = resolve;
    });
  });
  const name = await screen.findByLabelText("姓名");
  await user.type(name, "五");
  await user.click(screen.getByRole("button", { name: "保存我的信息" }));
  await user.click(await screen.findByRole("button", { name: "放弃未保存修改并重新读取" }));
  await user.click(screen.getByRole("button", { name: "确定放弃并重新读取" }));
  await waitFor(() => expect(reads).toBe(2));
  await user.type(name, "六");
  await act(async () => finishRead?.(fresh));
  expect(name).toHaveProperty("value", "张三五六");
  expect(await screen.findByText(/读取期间内容又有修改/)).toBeTruthy();
});

test("提示带 role=status", async () => {
  const user = userEvent.setup();
  mount((command, args) => (command === "save_profile_cmd" ? { profile: args?.profile, revision: 4 } : record));
  await screen.findByLabelText("姓名");
  await user.click(screen.getByRole("button", { name: "保存我的信息" }));
  expect(await screen.findByRole("status")).toBeTruthy();
});

for (const conflictPath of [false, true]) {
  test(`重新读取需要二次确认，取消保留草稿和处理入口；冲突入口=${conflictPath}`, async () => {
    const user = userEvent.setup();
    const { fire, calls } = mountWithListen((command) => {
      if (command === "save_profile_cmd") throw { code: "CONFLICT", message: "档案版本冲突" };
      return record;
    });
    const name = await screen.findByLabelText("姓名");
    await user.type(name, "五");
    if (conflictPath) await user.click(screen.getByRole("button", { name: "保存我的信息" }));
    else await act(async () => fire());
    const readsBefore = calls.filter(c => c.command === "get_profile_cmd").length;
    await user.click(screen.getByRole("button", { name: "放弃未保存修改并重新读取" }));
    expect(screen.getByRole("group", { name: "确认放弃未保存修改" })).toBeTruthy();
    expect(calls.filter(c => c.command === "get_profile_cmd").length).toBe(readsBefore);
    await user.click(screen.getByRole("button", { name: "取消，保留当前输入" }));
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "放弃未保存修改并重新读取" }));
    expect(name).toHaveProperty("value", "张三五");
    expect(calls.filter(c => c.command === "get_profile_cmd").length).toBe(readsBefore);
    expect(screen.queryByRole("group", { name: "确认放弃未保存修改" })).toBeNull();
    expect(screen.getByRole("button", { name: "放弃未保存修改并重新读取" })).toBeTruthy();
  });
}

test("稍后处理后的入口可继续确认读取，失败仍保留草稿和入口", async () => {
  const user = userEvent.setup();
  let reads = 0;
  const { fire } = mountWithListen(() => {
    if (++reads > 1) throw { message: "暂时读取失败" };
    return record;
  });
  const name = await screen.findByLabelText("姓名");
  await user.type(name, "五");
  await act(async () => fire());
  await user.click(screen.getByRole("button", { name: "稍后处理" }));
  await user.click(screen.getByRole("button", { name: "放弃未保存修改并重新读取" }));
  await user.click(screen.getByRole("button", { name: "确定放弃并重新读取" }));
  expect(await screen.findByText("暂时读取失败")).toBeTruthy();
  expect(name).toHaveProperty("value", "张三五");
  expect(screen.getByText(/有待同步的补充字段/)).toBeTruthy();
  expect(screen.getByRole("button", { name: "放弃未保存修改并重新读取" })).toHaveProperty("disabled", false);
});

test("手动读取期间到达的更新版本仍保留处理入口，下一次读取成功才清除", async () => {
  const user = userEvent.setup();
  let reads = 0;
  let finishRead: ((value: ProfileRecordView) => void) | undefined;
  const { fire } = mountWithListen(() => {
    reads += 1;
    if (reads === 2) return new Promise<ProfileRecordView>(resolve => { finishRead = resolve; });
    return { ...record, revision: reads === 1 ? 3 : 5 };
  });
  const name = await screen.findByLabelText("姓名");
  await user.type(name, "五");
  await act(async () => fire(4));
  await user.click(screen.getByRole("button", { name: "放弃未保存修改并重新读取" }));
  await user.click(screen.getByRole("button", { name: "确定放弃并重新读取" }));
  expect(reads).toBe(2);
  expect(screen.getByRole("button", { name: "放弃未保存修改并重新读取" })).toHaveProperty("disabled", true);
  expect(screen.getByRole("button", { name: "保存我的信息" })).toHaveProperty("disabled", true);
  await act(async () => fire(5));
  await act(async () => finishRead?.({ ...record, revision: 4 }));
  expect(screen.getByText(/有待同步的补充字段/)).toBeTruthy();
  await user.click(screen.getByRole("button", { name: "放弃未保存修改并重新读取" }));
  await user.click(screen.getByRole("button", { name: "确定放弃并重新读取" }));
  await waitFor(() => expect(reads).toBe(3));
  expect(screen.queryByText(/有待同步的补充字段/)).toBeNull();
  expect(screen.queryByRole("button", { name: "放弃未保存修改并重新读取" })).toBeNull();
});

test("保存成功响应晚于插件更高版本事件时仍保留同步入口", async () => {
  const user = userEvent.setup();
  let finishSave: ((value: ProfileRecordView) => void) | undefined;
  const { fire } = mountWithListen(command => command === "save_profile_cmd"
    ? new Promise<ProfileRecordView>(resolve => { finishSave = resolve; }) : record);
  await user.type(await screen.findByLabelText("姓名"), "五");
  await user.click(screen.getByRole("button", { name: "保存我的信息" }));
  await act(async () => fire(5));
  await act(async () => finishSave?.({ ...record, revision: 4, profile: {
    ...record.profile, values: { ...record.profile.values, name: "张三五" }
  } }));
  expect(screen.getByLabelText("姓名")).toHaveProperty("value", "张三五");
  expect(screen.getByText(/有待同步的补充字段/)).toBeTruthy();
  expect(screen.getByRole("button", { name: "放弃未保存修改并重新读取" })).toHaveProperty("disabled", false);
});

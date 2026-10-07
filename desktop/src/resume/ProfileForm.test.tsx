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

test("保存遇到版本冲突时读取最新档案，保留草稿供逐项处理", async () => {
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
  expect(await screen.findByText(/有 1 处更新需要确认/)).toBeTruthy();
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

test("脏表单安全加入插件新增空字段，不保存也不打断当前输入（#191）", async () => {
  const user = userEvent.setup();
  let reads = 0;
  const updated: ProfileRecordView = {
    profile: { ...record.profile, custom: [...record.profile.custom, { key: "国籍", value: "" }] },
    revision: 4,
  };
  const { fire, calls } = mountWithListen((command, args) => {
    if (command === "save_profile_cmd") return { profile: args?.profile, revision: 5 };
    reads += 1;
    return reads === 1 ? record : updated;
  });
  const name = await screen.findByLabelText("姓名");
  await user.type(name, "五");
  name.focus();
  await act(async () => fire());
  expect(await screen.findByRole("group", { name: "国籍" })).toBeTruthy();
  expect(name).toHaveProperty("value", "张三五");
  expect(document.activeElement).toBe(name);
  expect(screen.getByText(/你的修改仍未保存/)).toBeTruthy();
  expect(calls.filter((call) => call.command === "save_profile_cmd")).toHaveLength(0);
  await user.click(screen.getByRole("button", { name: "保存我的信息" }));
  const saved = calls.find((call) => call.command === "save_profile_cmd")?.args;
  expect(saved?.revision).toBe(4);
  expect((saved?.profile as typeof record.profile).values.name).toBe("张三五");
  expect((saved?.profile as typeof record.profile).custom.some((field) => field.key === "国籍")).toBe(true);
});

test("同名补充字段显示冲突，确认放弃后才能重新读取（#191）", async () => {
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
  await user.click(screen.getByRole("button", { name: "添加补充字段" }));
  await user.type(screen.getAllByLabelText("字段名").at(-1)!, "国籍");
  await user.type(screen.getAllByLabelText("内容").at(-1)!, "中国");
  await act(async () => fire());
  await screen.findByText(/有 1 处更新需要确认/);
  await user.click(screen.getByRole("button", { name: "查看并处理" }));
  expect(within(screen.getByRole("group", { name: "冲突：国籍" })).getByText("中国")).toBeTruthy();
  await user.click(screen.getByRole("button", { name: "放弃未保存修改并重新读取" }));
  await user.click(screen.getByRole("button", { name: "确定放弃并重新读取" }));
  await waitFor(() => expect(screen.getByRole("group", { name: /国籍/ })).toBeTruthy());
  expect(screen.getByLabelText("姓名")).toHaveProperty("value", "张三");
  expect(screen.queryByText(/更新需要确认/)).toBeNull();
});

test("冲突稍后处理后入口持续可见且不保存（#191）", async () => {
  const user = userEvent.setup();
  let reads = 0;
  const { fire, calls } = mountWithListen((command) => {
    if (command !== "get_profile_cmd") throw new Error(`意外调用 ${command}`);
    reads += 1;
    return reads === 1 ? record : { ...record, revision: 4, profile: { ...record.profile, values: { ...record.profile.values, name: "李四" } } };
  });
  const name = await screen.findByLabelText("姓名");
  await user.type(name, "五");
  await act(async () => fire());
  await screen.findByText(/有 1 处更新需要确认/);
  const readsBefore = calls.filter((c) => c.command === "get_profile_cmd").length;
  await user.click(screen.getByRole("button", { name: "稍后处理" }));
  expect(screen.getByText(/有 1 处更新需要确认/)).toBeTruthy();
  expect(screen.getByRole("button", { name: "查看并处理" })).toBeTruthy();
  expect(screen.getByRole("button", { name: "放弃未保存修改并重新读取" })).toBeTruthy();
  expect(name).toHaveProperty("value", "张三五");
  expect(calls.filter((c) => c.command === "get_profile_cmd").length).toBe(readsBefore);
});

test("同名字段可保留当前内容，处理前不允许整份保存（#191）", async () => {
  const user = userEvent.setup();
  let reads = 0;
  const updated: ProfileRecordView = {
    profile: { ...record.profile, custom: [...record.profile.custom, { key: "国籍", value: "" }] },
    revision: 4,
  };
  const { fire, calls } = mountWithListen((command, args) => {
    if (command === "save_profile_cmd") return { profile: args?.profile, revision: 5 };
    reads += 1;
    return reads === 1 ? record : updated;
  });
  await screen.findByLabelText("姓名");
  await user.click(screen.getByRole("button", { name: "添加补充字段" }));
  await user.type(screen.getAllByLabelText("字段名").at(-1)!, "国籍");
  await user.type(screen.getAllByLabelText("内容").at(-1)!, "中国");
  await act(async () => fire());
  await screen.findByText(/有 1 处更新需要确认/);
  await user.click(screen.getByRole("button", { name: "保存我的信息" }));
  expect(calls.filter((call) => call.command === "save_profile_cmd")).toHaveLength(0);
  const detail = screen.getByRole("group", { name: "冲突：国籍" });
  await user.click(within(detail).getByRole("button", { name: "使用当前草稿" }));
  await user.click(screen.getByRole("button", { name: "应用选择，继续编辑" }));
  expect(screen.getByText(/修改仍未保存/)).toBeTruthy();
  await user.click(screen.getByRole("button", { name: "保存我的信息" }));
  const saved = calls.find((call) => call.command === "save_profile_cmd")?.args;
  expect(saved?.revision).toBe(4);
  expect((saved?.profile as typeof record.profile).custom.filter((field) => field.key === "国籍")).toEqual([{ key: "国籍", value: "中国" }]);
});

test("同名字段分别保留时先改名，使用外部版本需二次确认（#191）", async () => {
  const user = userEvent.setup();
  let reads = 0;
  const updated: ProfileRecordView = {
    profile: { ...record.profile, custom: [...record.profile.custom, { key: "国籍", value: "" }] },
    revision: 4,
  };
  const { fire } = mountWithListen(() => (++reads === 1 ? record : updated));
  await screen.findByLabelText("姓名");
  await user.click(screen.getByRole("button", { name: "添加补充字段" }));
  await user.type(screen.getAllByLabelText("字段名").at(-1)!, "国籍");
  await user.type(screen.getAllByLabelText("内容").at(-1)!, "中国");
  await act(async () => fire());
  await screen.findByText(/有 1 处更新需要确认/);
  await user.click(screen.getByRole("button", { name: "查看并处理" }));
  const detail = screen.getByRole("group", { name: "冲突：国籍" });
  await user.click(within(detail).getByRole("button", { name: "使用外部版本" }));
  expect(within(detail).getByText(/这会放弃该处当前草稿内容/)).toBeTruthy();
  await user.click(within(detail).getByRole("button", { name: "取消" }));
  expect(within(detail).getByText("中国")).toBeTruthy();
  await user.click(within(detail).getByRole("button", { name: "分别保留" }));
  await user.click(screen.getByRole("button", { name: "应用选择，继续编辑" }));
  expect(screen.getByText(/请为「国籍」填写一个不同/)).toBeTruthy();
  await user.type(within(detail).getByLabelText("给当前草稿中的字段改名"), "个人国籍说明");
  await user.click(screen.getByRole("button", { name: "应用选择，继续编辑" }));
  expect(screen.getByRole("group", { name: "个人国籍说明" })).toBeTruthy();
  expect(screen.getByRole("group", { name: "国籍" })).toBeTruthy();
});

test("已有字段被两边改动时逐项选择，保存使用外部最新版本（#191）", async () => {
  const user = userEvent.setup();
  let reads = 0;
  const updated: ProfileRecordView = {
    profile: { ...record.profile, values: { ...record.profile.values, name: "李四" } },
    revision: 4,
  };
  const { fire, calls } = mountWithListen((command, args) => {
    if (command === "save_profile_cmd") return { profile: args?.profile, revision: 5 };
    reads += 1;
    return reads === 1 ? record : updated;
  });
  const name = await screen.findByLabelText("姓名");
  await user.type(name, "五");
  await act(async () => fire());
  await screen.findByText(/有 1 处更新需要确认/);
  await user.click(screen.getByRole("button", { name: "查看并处理" }));
  const detail = screen.getByRole("group", { name: "冲突：姓名" });
  expect(within(detail).getByText("张三五")).toBeTruthy();
  expect(within(detail).getByText("李四")).toBeTruthy();
  await user.click(within(detail).getByRole("button", { name: "使用当前草稿" }));
  await user.click(screen.getByRole("button", { name: "应用选择，继续编辑" }));
  await user.click(screen.getByRole("button", { name: "保存我的信息" }));
  const saved = calls.find((call) => call.command === "save_profile_cmd")?.args;
  expect(saved?.revision).toBe(4);
  expect((saved?.profile as typeof record.profile).values.name).toBe("张三五");
});

test("确认使用外部值后只替换冲突字段，其他草稿修改仍保留（#191）", async () => {
  const user = userEvent.setup();
  let reads = 0;
  const updated: ProfileRecordView = {
    profile: { ...record.profile, values: { ...record.profile.values, name: "李四" } },
    revision: 4,
  };
  const { fire } = mountWithListen(() => (++reads === 1 ? record : updated));
  const name = await screen.findByLabelText("姓名");
  await user.type(name, "五");
  await user.type(screen.getByLabelText("常用邮箱"), "test@example.com");
  await act(async () => fire());
  await screen.findByText(/有 1 处更新需要确认/);
  await user.click(screen.getByRole("button", { name: "查看并处理" }));
  const detail = screen.getByRole("group", { name: "冲突：姓名" });
  await user.click(within(detail).getByRole("button", { name: "使用外部版本" }));
  expect(name).toHaveProperty("value", "张三五");
  await user.click(within(detail).getByRole("button", { name: "确定使用外部版本" }));
  await user.click(screen.getByRole("button", { name: "应用选择，继续编辑" }));
  expect(name).toHaveProperty("value", "李四");
  expect(screen.getByLabelText("常用邮箱")).toHaveProperty("value", "test@example.com");
});

test("保存请求期间继续输入，新内容不会被晚到的保存响应覆盖（#191）", async () => {
  const user = userEvent.setup();
  let finishSave: ((value: ProfileRecordView) => void) | undefined;
  mount((command) => command === "save_profile_cmd"
    ? new Promise<ProfileRecordView>((resolve) => { finishSave = resolve; }) : record);
  const name = await screen.findByLabelText("姓名");
  await user.type(name, "五");
  await user.click(screen.getByRole("button", { name: "保存我的信息" }));
  await user.type(name, "六");
  await act(async () => finishSave?.({ ...record, revision: 4, profile: {
    ...record.profile, values: { ...record.profile.values, name: "张三五" },
  } }));
  expect(name).toHaveProperty("value", "张三五六");
  expect(screen.getByText(/保存期间的新输入仍未保存/)).toBeTruthy();
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

test("自动读取期间开始编辑，安全字段仍加入最新草稿（#191）", async () => {
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
  expect(await screen.findByRole("group", { name: /国籍/ })).toBeTruthy();
  expect(screen.getByText(/你的修改仍未保存/)).toBeTruthy();
  const readsBefore = reads;
  await act(async () => fire(updated.revision));
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
  const { fire } = mountWithListen((command) => {
    if (command === "save_profile_cmd") throw new Error("意外保存");
    reads += 1;
    if (reads === 1) return record;
    if (reads === 2) return fresh;
    return new Promise<ProfileRecordView>((resolve) => {
      finishRead = resolve;
    });
  });
  const name = await screen.findByLabelText("姓名");
  await user.type(name, "五");
  await act(async () => fire(4));
  await screen.findByText(/有 1 处更新需要确认/);
  await user.click(await screen.findByRole("button", { name: "放弃未保存修改并重新读取" }));
  await user.click(screen.getByRole("button", { name: "确定放弃并重新读取" }));
  await waitFor(() => expect(reads).toBe(3));
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
  expect(screen.getByText(/有待同步的更新/)).toBeTruthy();
  expect(screen.getByRole("button", { name: "放弃未保存修改并重新读取" })).toHaveProperty("disabled", false);
});

test("手动读取期间到达的更新版本仍保留处理入口，下一次读取成功才清除", async () => {
  const user = userEvent.setup();
  let reads = 0;
  let finishRead: ((value: ProfileRecordView) => void) | undefined;
  const { fire } = mountWithListen(() => {
    reads += 1;
    if (reads === 1) return record;
    if (reads === 3) return new Promise<ProfileRecordView>(resolve => { finishRead = resolve; });
    return { ...record, revision: reads === 2 ? 4 : 5,
      profile: { ...record.profile, values: { ...record.profile.values, name: "李四" } } };
  });
  const name = await screen.findByLabelText("姓名");
  await user.type(name, "五");
  await act(async () => fire(4));
  await screen.findByText(/有 1 处更新需要确认/);
  await user.click(screen.getByRole("button", { name: "放弃未保存修改并重新读取" }));
  await user.click(screen.getByRole("button", { name: "确定放弃并重新读取" }));
  expect(reads).toBe(3);
  expect(screen.getByRole("button", { name: "放弃未保存修改并重新读取" })).toHaveProperty("disabled", true);
  expect(screen.getByRole("button", { name: "保存我的信息" })).toHaveProperty("disabled", true);
  await act(async () => fire(5));
  await act(async () => finishRead?.({ ...record, revision: 4 }));
  expect(screen.getByText(/有待同步的更新/)).toBeTruthy();
  await user.click(screen.getByRole("button", { name: "放弃未保存修改并重新读取" }));
  await user.click(screen.getByRole("button", { name: "确定放弃并重新读取" }));
  await waitFor(() => expect(reads).toBe(4));
  expect(screen.queryByText(/有待同步的更新/)).toBeNull();
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
  expect(screen.getByText(/有待同步的更新/)).toBeTruthy();
  expect(screen.getByRole("button", { name: "放弃未保存修改并重新读取" })).toHaveProperty("disabled", false);
});

// #228：网页上的长题目要整句看得到；字段名和内容一样大，保存的仍是单行。
test("补充字段的长题目整句显示，字段名和内容的框一样高", async () => {
  const longKey = "在校期间是否有补考、重修情况？如有，请列出具体科目、次数以及当时的原因说明";
  mount(() => ({ ...record, profile: { ...record.profile, custom: [{ key: longKey, value: "" }] } }));
  const row = await screen.findByRole("group", { name: longKey });
  const key = within(row).getByLabelText("字段名") as HTMLTextAreaElement;
  const value = within(row).getByLabelText("内容") as HTMLTextAreaElement;
  expect(key.tagName).toBe("TEXTAREA");
  expect(key.value).toBe(longKey);
  expect(value.tagName).toBe("TEXTAREA");
  expect(key.style.height).not.toBe("");
  expect(key.style.height).toBe(value.style.height);
});

test("补充字段里回车不换行，粘贴进来的换行变成空格", async () => {
  const calls = mount((command) => (command === "save_profile_cmd" ? { revision: 4 } : record));
  const row = await screen.findByRole("group", { name: /户籍派出所/ });
  const value = within(row).getByLabelText("内容") as HTMLTextAreaElement;
  await userEvent.click(value);
  await userEvent.keyboard("第一行{Enter}");
  expect(value.value).toBe("第一行");
  await userEvent.paste("甲\n乙");
  expect(value.value).toBe("第一行甲 乙");
  await userEvent.click(screen.getByRole("button", { name: "保存我的信息" }));
  await waitFor(() => expect(calls.some((c) => c.command === "save_profile_cmd")).toBe(true));
  const saved = calls.find((c) => c.command === "save_profile_cmd")!.args!.profile as { custom: Array<{ key: string; value: string }> };
  expect(saved.custom.find((c) => c.key === "户籍派出所")?.value).toBe("第一行甲 乙");
});

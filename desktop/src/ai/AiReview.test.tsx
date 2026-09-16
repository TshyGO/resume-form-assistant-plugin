import { expect, test } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { AiSuggestion, Invoke, OutboundPreview } from "../api.ts";
import { InvokeProvider } from "../react/invoke.tsx";
import { AiReview } from "./AiReview.tsx";

const preview: OutboundPreview = {
  host: "api.example.test",
  model: "fake-model",
  bodyChars: 120,
  truncated: false,
  hasSubject: true,
  hasFrom: true,
  candidates: [{ label: "c1", company: "合成科技", title: "后端实习", stage: "submitted" }],
  bodyPreview: "您好，时间定在下周二上午十点。",
  summary: "发往 api.example.test · 模型 fake-model · 正文 120 字 · 候选 1 条",
  slowHintSeconds: 15,
  timeoutSeconds: 60,
};

const suggestion: AiSuggestion = {
  id: "sug-1",
  evidenceId: "ev-1",
  status: "pending",
  candidates: [{ id: "app-a", company: "合成科技", title: "后端实习", stage: "submitted" }],
  stage: "interview",
  round: 1,
  replyClass: "interview_invite",
  sendMode: "automated",
  todos: [],
  excerpts: ["下周二上午十点"],
  uncertainties: [],
  modelLabel: "fake-model",
  promptScope: "发往 api.example.test · 候选 1 条",
  createdAt: "2026-09-16T02:00:00Z",
};

const applications = {
  items: [
    { id: "app-a", company: "合成科技", title: "后端实习" },
    { id: "app-b", company: "别家公司", title: "前端实习" },
  ],
  total: 2,
};

/** 造 n 条申请，用来验证翻页。 */
function manyApplications(total: number, offset: number, limit: number) {
  const items = Array.from({ length: Math.max(0, Math.min(limit, total - offset)) }, (_, i) => ({
    id: `app-${offset + i}`,
    company: `公司 ${offset + i}`,
    title: "岗位",
  }));
  return { items, total };
}

type Handler = (command: string, args?: Record<string, unknown>) => unknown;

function mount(handler: Handler, onConfirmed?: (message: string) => void) {
  const calls: Array<{ command: string; args?: Record<string, unknown> }> = [];
  const invoke = (async (command: string, args?: Record<string, unknown>) => {
    calls.push({ command, args });
    return handler(command, args);
  }) as Invoke;
  const view = render(
    <InvokeProvider invoke={invoke}>
      <AiReview evidenceId="ev-1" onConfirmed={onConfirmed} />
    </InvokeProvider>,
  );
  return Object.assign(calls, { unmount: view.unmount });
}

const base: Handler = (command) => {
  if (command === "list_suggestions_cmd") return [];
  if (command === "preview_analysis_cmd") return preview;
  if (command === "list_applications_cmd") return applications;
  if (command === "get_evidence_preview_cmd") return { bodyExtract: "您好，时间定在下周二上午十点。" };
  return null;
};

test("发送前先给预览：发往哪、发多少字、带哪几条候选", async () => {
  const user = userEvent.setup();
  mount(base);
  await user.click(await screen.findByRole("button", { name: "AI 整理" }));
  expect(await screen.findByText("api.example.test")).toBeTruthy();
  expect(screen.getByText(/可能会留存/)).toBeTruthy();
  // 预览里写着的候选，和下面「自己选候选」的清单里都有它。
  expect(screen.getAllByText(/合成科技 · 后端实习/).length).toBeGreaterThan(0);
  expect(screen.getByRole("button", { name: "发送" })).toBeTruthy();
});

test("自己勾候选会重新算一次预览，并把选中的 id 带上", async () => {
  const user = userEvent.setup();
  const calls = mount(base);
  await user.click(await screen.findByRole("button", { name: "AI 整理" }));
  await screen.findByText("api.example.test");
  await user.click(screen.getByLabelText(/别家公司/));
  await waitFor(() => {
    const previews = calls.filter((call) => call.command === "preview_analysis_cmd");
    expect(previews[previews.length - 1]?.args?.candidateIds).toEqual(["app-b"]);
  });
});

test("没配 Key 时指引去设置页，并说明手动分类照常可用", async () => {
  const user = userEvent.setup();
  mount((command, args) => {
    if (command === "analyze_evidence_cmd") {
      throw { code: "AI_NOT_CONFIGURED", message: "还没有配置 AI Key。" };
    }
    return base(command, args);
  });
  await user.click(await screen.findByRole("button", { name: "AI 整理" }));
  await screen.findByText("api.example.test");
  await user.click(screen.getByRole("button", { name: "发送" }));
  expect(await screen.findByText(/设置页/)).toBeTruthy();
  expect(screen.getByText(/手动分类/)).toBeTruthy();
});

test("取消之后回到能再发一次的状态", async () => {
  const user = userEvent.setup();
  let reject: ((error: unknown) => void) | null = null;
  mount((command, args) => {
    if (command === "analyze_evidence_cmd") {
      return new Promise((_resolve, fail) => {
        reject = fail;
      });
    }
    if (command === "cancel_analysis_cmd") {
      reject?.({ code: "AI_CANCELLED", message: "已取消。" });
      return true;
    }
    return base(command, args);
  });
  await user.click(await screen.findByRole("button", { name: "AI 整理" }));
  await screen.findByText("api.example.test");
  await user.click(screen.getByRole("button", { name: "发送" }));
  await user.click(await screen.findByRole("button", { name: "取消" }));
  expect(await screen.findByText(/计费/)).toBeTruthy();
  expect(await screen.findByRole("button", { name: "再试一次" })).toBeTruthy();
});

test("成功之后进入审核，四个按钮都在，进度默认不勾", async () => {
  const user = userEvent.setup();
  mount((command, args) =>
    command === "analyze_evidence_cmd" ? suggestion : base(command, args),
  );
  await user.click(await screen.findByRole("button", { name: "AI 整理" }));
  await screen.findByText("api.example.test");
  await user.click(screen.getByRole("button", { name: "发送" }));
  expect(await screen.findByRole("button", { name: "确认" })).toBeTruthy();
  expect(screen.getByRole("button", { name: "拒绝" })).toBeTruthy();
  expect(screen.getByRole("button", { name: "暂存" })).toBeTruthy();
  expect(screen.getByLabelText("同时更新申请进度")).toHaveProperty("checked", false);
});

test("暂存过的建议下次打开这条证据还能接着看", async () => {
  const user = userEvent.setup();
  mount((command, args) =>
    command === "list_suggestions_cmd" ? [{ ...suggestion, status: "deferred" }] : base(command, args),
  );
  await user.click(await screen.findByRole("button", { name: "打开暂存的建议" }));
  expect(await screen.findByRole("button", { name: "确认" })).toBeTruthy();
});

test("确认把改完的入参交给命令层，并把结果交给宿主去显示", async () => {
  const user = userEvent.setup();
  const messages: string[] = [];
  const calls = mount((command, args) => {
    if (command === "analyze_evidence_cmd") return suggestion;
    if (command === "confirm_suggestion_cmd") {
      return { suggestion, alreadyConfirmed: false, events: [], todos: [], reminderProblems: [] };
    }
    return base(command, args);
  }, (message) => messages.push(message));
  await user.click(await screen.findByRole("button", { name: "AI 整理" }));
  await screen.findByText("api.example.test");
  await user.click(screen.getByRole("button", { name: "发送" }));
  await user.click(await screen.findByRole("button", { name: "确认" }));
  // 面板马上会被宿主卸掉重画，所以这句话得交到宿主手上，不能只留在面板里。
  await waitFor(() => expect(messages[0]).toMatch(/已确认/));
  const confirmed = calls.find((call) => call.command === "confirm_suggestion_cmd");
  const args = confirmed?.args?.args as Record<string, unknown>;
  expect(args.applicationId).toBe("app-a");
  expect(args.updateProgress).toBe(false);
  expect(args.stage).toBe("interview");
});

test("拒绝之后明说正式记录没动", async () => {
  const user = userEvent.setup();
  mount((command, args) => {
    if (command === "analyze_evidence_cmd") return suggestion;
    if (command === "reject_suggestion_cmd") return { ...suggestion, status: "rejected" };
    return base(command, args);
  });
  await user.click(await screen.findByRole("button", { name: "AI 整理" }));
  await screen.findByText("api.example.test");
  await user.click(screen.getByRole("button", { name: "发送" }));
  await user.click(await screen.findByRole("button", { name: "拒绝" }));
  expect(await screen.findByText(/正式记录一个字都没动/)).toBeTruthy();
});

test("确认失败不会把用户踢出审核，也不给「再试一次」（那是重新发一次的钱）", async () => {
  const user = userEvent.setup();
  mount((command, args) => {
    if (command === "analyze_evidence_cmd") return suggestion;
    if (command === "confirm_suggestion_cmd") {
      throw { code: "CONFLICT", message: "这条建议已经按别的决定确认过了。" };
    }
    return base(command, args);
  });
  await user.click(await screen.findByRole("button", { name: "AI 整理" }));
  await screen.findByText("api.example.test");
  await user.click(screen.getByRole("button", { name: "发送" }));
  await user.click(await screen.findByRole("button", { name: "确认" }));
  await screen.findByText(/别的决定确认过/);
  expect(screen.queryByRole("button", { name: "再试一次" })).toBeNull();
  // 草稿还在：四个按钮仍然在页面上。
  expect(screen.getByRole("button", { name: "拒绝" })).toBeTruthy();
  await user.click(screen.getByRole("button", { name: "关掉" }));
  expect(screen.getByRole("button", { name: "确认" })).toBeTruthy();
});

test("面板被卸掉时，正在跑的那次请求会被取消", async () => {
  const user = userEvent.setup();
  const calls = mount((command, args) => {
    if (command === "analyze_evidence_cmd") return new Promise(() => {});
    return base(command, args);
  });
  await user.click(await screen.findByRole("button", { name: "AI 整理" }));
  await screen.findByText("api.example.test");
  await user.click(screen.getByRole("button", { name: "发送" }));
  await screen.findByRole("button", { name: "取消" });

  calls.unmount();

  await waitFor(() => {
    expect(calls.some((call) => call.command === "cancel_analysis_cmd")).toBe(true);
  });
});

test("预览还在重算时，改不了候选也发不出去——看到的和发出去的必须是同一份", async () => {
  const user = userEvent.setup();
  let release: ((value: OutboundPreview) => void) | null = null;
  mount((command, args) => {
    if (command === "preview_analysis_cmd") {
      const ids = (args?.candidateIds ?? null) as string[] | null;
      if (!ids) return preview;
      return new Promise<OutboundPreview>((resolve) => {
        release = resolve;
      });
    }
    return base(command, args);
  });
  await user.click(await screen.findByRole("button", { name: "AI 整理" }));
  await screen.findByText("api.example.test");
  await user.click(screen.getByLabelText(/别家公司/));

  await waitFor(() => expect(screen.getByRole("button", { name: "发送" })).toHaveProperty("disabled", true));
  expect(screen.getByLabelText(/合成科技/)).toHaveProperty("disabled", true);

  release!({ ...preview, candidates: [{ label: "c1", company: "别家公司", title: "前端实习", stage: "submitted" }] });
  await waitFor(() => expect(screen.getByRole("button", { name: "发送" })).toHaveProperty("disabled", false));
});

test("申请超过一页时会一直翻到取完，第 201 条也选得到", async () => {
  const user = userEvent.setup();
  mount((command, args) => {
    if (command === "list_applications_cmd") {
      const query = args?.args as { limit: number; offset: number };
      return manyApplications(250, query.offset, query.limit);
    }
    if (command === "analyze_evidence_cmd") return { ...suggestion, candidates: [] };
    return base(command, args);
  });
  await user.click(await screen.findByRole("button", { name: "AI 整理" }));
  await screen.findByText("api.example.test");
  await user.click(screen.getByRole("button", { name: "发送" }));

  await screen.findByText(/认不出这封信是哪一条申请/);
  expect(screen.getByRole("option", { name: /公司 249/ })).toBeTruthy();
});

test("预览还在重算时点「先不发」，晚到的结果不会把人拉回预览页", async () => {
  const user = userEvent.setup();
  let release: ((value: OutboundPreview) => void) | null = null;
  mount((command, args) => {
    if (command === "preview_analysis_cmd") {
      const ids = (args?.candidateIds ?? null) as string[] | null;
      if (!ids) return preview;
      return new Promise<OutboundPreview>((resolve) => {
        release = resolve;
      });
    }
    return base(command, args);
  });
  await user.click(await screen.findByRole("button", { name: "AI 整理" }));
  await screen.findByText("api.example.test");
  await user.click(screen.getByLabelText(/别家公司/));
  await user.click(screen.getByRole("button", { name: "先不发" }));

  release!(preview);
  await waitFor(() => expect(screen.getByRole("button", { name: "AI 整理" })).toBeTruthy());
  expect(screen.queryByRole("button", { name: "发送" })).toBeNull();
});

test("预览里写明候选连当前阶段一起发出去", async () => {
  const user = userEvent.setup();
  mount(base);
  await user.click(await screen.findByRole("button", { name: "AI 整理" }));
  await screen.findByText("api.example.test");
  expect(screen.getByText(/当前阶段：已投递/)).toBeTruthy();
});

test("等不下去时有一条纯界面的退路，并顺手取消请求", async () => {
  const user = userEvent.setup();
  const calls = mount((command, args) => {
    if (command === "analyze_evidence_cmd") return new Promise(() => {});
    if (command === "cancel_analysis_cmd") return new Promise(() => {});
    return base(command, args);
  });
  await user.click(await screen.findByRole("button", { name: "AI 整理" }));
  await screen.findByText("api.example.test");
  await user.click(screen.getByRole("button", { name: "发送" }));
  await screen.findByRole("button", { name: "取消" });

  await user.click(screen.getByRole("button", { name: "不等了，关掉" }));

  expect(await screen.findByRole("button", { name: "AI 整理" })).toBeTruthy();
  expect(calls.some((call) => call.command === "cancel_analysis_cmd")).toBe(true);
});

test("拒绝过的建议还能再打开——点错了不该只能再花一次钱", async () => {
  const user = userEvent.setup();
  mount((command, args) =>
    command === "list_suggestions_cmd" ? [{ ...suggestion, status: "rejected" }] : base(command, args),
  );
  await user.click(await screen.findByRole("button", { name: "打开拒绝过的建议" }));
  expect(await screen.findByRole("button", { name: "确认" })).toBeTruthy();
});

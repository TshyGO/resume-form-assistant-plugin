import { useState } from "react";
import { expect, test } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { AiSuggestion, ApplicationSummary } from "../api.ts";
import { ReviewPanel } from "./ReviewPanel.tsx";
import { initialDraft } from "./review.ts";
import type { Draft } from "./review.ts";

const twoCandidates: AiSuggestion = {
  id: "sug-1",
  evidenceId: "ev-1",
  status: "pending",
  candidates: [
    { id: "app-a", company: "合成科技", title: "后端实习", stage: "submitted" },
    { id: "app-b", company: "合成科技", title: "前端实习", stage: "submitted" },
  ],
  stage: "interview",
  round: 1,
  replyClass: "interview_invite",
  sendMode: "automated",
  todos: [
    {
      title: "一面",
      duePrecision: "datetime",
      dueAtUtc: "2026-09-22T02:00:00Z",
      dueDate: null,
      timeZone: "Asia/Shanghai",
      interviewRound: 1,
    },
  ],
  excerpts: ["下周二上午十点"],
  uncertainties: ["发信人没写具体地点。"],
  modelLabel: "fake-model",
  promptScope: "发往 api.example.test · 候选 2 条",
  createdAt: "2026-09-16T02:00:00Z",
};

const body = "您好，时间定在下周二上午十点，地点待定。";

/** 面板自己不存草稿，这里用一个最小的宿主替它存，和真实调用方一样。 */
function Host({
  suggestion,
  applications = [],
  onConfirm,
}: {
  suggestion: AiSuggestion;
  applications?: ApplicationSummary[];
  onConfirm?: (draft: Draft) => void;
}) {
  const [draft, setDraft] = useState<Draft>(() => initialDraft(suggestion));
  return (
    <ReviewPanel
      suggestion={suggestion}
      applications={applications}
      body={body}
      draft={draft}
      busy={false}
      onDraftChange={setDraft}
      onConfirm={() => onConfirm?.(draft)}
      onReject={() => {}}
      onDefer={() => {}}
    />
  );
}

test("多个候选没选，确认按不下去，并说清楚差什么", async () => {
  render(<Host suggestion={twoCandidates} />);
  expect(screen.getByRole("button", { name: "确认" })).toHaveProperty("disabled", true);
  expect(screen.getByText(/哪一条申请还没选/)).toBeTruthy();

  const user = userEvent.setup();
  await user.selectOptions(screen.getByLabelText("申请"), "app-b");
  expect(screen.getByRole("button", { name: "确认" })).toHaveProperty("disabled", false);
});

test("改过之后按钮变成「改完确认」", async () => {
  const user = userEvent.setup();
  render(<Host suggestion={{ ...twoCandidates, candidates: [twoCandidates.candidates[0]!] }} />);
  expect(screen.getByRole("button", { name: "确认" })).toBeTruthy();
  await user.selectOptions(screen.getByLabelText("发送方式"), "unknown");
  expect(screen.getByRole("button", { name: "改完确认" })).toBeTruthy();
});

test("「同时更新申请进度」默认不勾，勾了才会带上", async () => {
  const user = userEvent.setup();
  let submitted: Draft | null = null;
  render(
    <Host
      suggestion={{ ...twoCandidates, candidates: [twoCandidates.candidates[0]!] }}
      onConfirm={(draft) => {
        submitted = draft;
      }}
    />,
  );
  const box = screen.getByLabelText("同时更新申请进度");
  expect(box).toHaveProperty("checked", false);
  await user.click(box);
  // 勾进度不算「改建议」，按钮还是「确认」。
  await user.click(screen.getByRole("button", { name: "确认" }));
  expect(submitted!.updateProgress).toBe(true);
});

test("原文依据能展开，命中的那一段高亮", async () => {
  const user = userEvent.setup();
  const { container } = render(<Host suggestion={twoCandidates} />);
  await user.click(screen.getByText("下周二上午十点", { selector: "summary" }));
  const marked = container.querySelector("mark");
  expect(marked?.textContent).toBe("下周二上午十点");
});

test("模型自己不确定的地方单独列出来", () => {
  render(<Host suggestion={twoCandidates} />);
  expect(screen.getByText("发信人没写具体地点。")).toBeTruthy();
});

test("待办可以改标题和时刻，也可以整条不要", async () => {
  const user = userEvent.setup();
  let submitted: Draft | null = null;
  render(
    <Host
      suggestion={{ ...twoCandidates, candidates: [twoCandidates.candidates[0]!] }}
      onConfirm={(draft) => {
        submitted = draft;
      }}
    />,
  );
  await user.clear(screen.getByLabelText("待办 1 标题"));
  await user.type(screen.getByLabelText("待办 1 标题"), "一面（改到周三）");
  await user.click(screen.getByRole("button", { name: "改完确认" }));
  expect(submitted!.todos[0]!.title).toBe("一面（改到周三）");

  await user.click(screen.getByLabelText("转成待办"));
  await user.click(screen.getByRole("button", { name: "改完确认" }));
  expect(submitted!.todos[0]!.keep).toBe(false);
});

test("这一次到底发出去了什么，点开能看到", async () => {
  const user = userEvent.setup();
  render(<Host suggestion={twoCandidates} />);
  await user.click(screen.getByRole("button", { name: "看看这次发出去了什么" }));
  expect(screen.getByText(/发往 api.example.test · 候选 2 条/)).toBeTruthy();
});

test("模型一条都没指认时，让用户从在办申请里自己挑", async () => {
  const user = userEvent.setup();
  render(
    <Host
      suggestion={{ ...twoCandidates, candidates: [] }}
      applications={
        [
          { id: "app-c", company: "第三家", title: "数据实习", current_stage: "submitted" },
        ] as ApplicationSummary[]
      }
    />,
  );
  expect(screen.getByText(/认不出这封信是哪一条申请/)).toBeTruthy();
  expect(screen.getByRole("button", { name: "确认" })).toHaveProperty("disabled", true);
  await user.selectOptions(screen.getByLabelText("申请"), "app-c");
  expect(screen.getByRole("button", { name: "确认" })).toHaveProperty("disabled", false);
});

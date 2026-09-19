import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import type { AiSuggestion, ApplicationSummary } from "../api.ts";
import { confirmArgs, confirmBlocker, initialDraft, isModified } from "./review.ts";

const fixtureUrl = new URL(
  "../../../docs/desktop-mvp/acceptance/fixtures/d14-v1/dataset.json",
  import.meta.url,
);
const expectedUrl = new URL(
  "../../../docs/desktop-mvp/acceptance/fixtures/d14-v1/expected-results.json",
  import.meta.url,
);
const dataset = JSON.parse(readFileSync(fixtureUrl, "utf8"));
const expected = JSON.parse(readFileSync(expectedUrl, "utf8"));

const byId = (list: string, logicalId: string): Record<string, any> =>
  dataset[list].find((item: Record<string, any>) => item.logicalId === logicalId);

const application = (logicalId: string): ApplicationSummary => {
  const mapping = byId("applications", logicalId);
  const job = byId("jobs", mapping.job);
  return {
    id: mapping.fixtureUuid,
    company: job.company,
    title: job.title,
    source_url: job.url,
    location: job.location,
    current_stage: "submitted",
    reply_evidence_state: "none_imported",
    updated_at: dataset.generatedFrom.baseInstant,
    recycle_state: "active",
  };
};

function suggestion(overrides: Partial<AiSuggestion> = {}): AiSuggestion {
  const notice = byId("notices", "notice-ambiguous-acme");
  const model = byId("modelResponses", "model-valid-ambiguous").value;
  const candidates = [application("application-a"), application("application-b")];
  return {
    id: "d14-suggestion-ambiguous",
    evidenceId: notice.logicalId,
    status: "pending",
    candidates: candidates.map((item) => ({
      id: item.id,
      company: item.company,
      title: item.title,
      stage: item.current_stage ?? "saved",
    })),
    stage: "interview",
    round: 1,
    replyClass: model.replyClass,
    sendMode: model.sendMode,
    todos: [],
    excerpts: [],
    uncertainties: model.uncertainties,
    modelLabel: "d14-fixed-response",
    promptScope: "D14 synthetic notice · 2 candidates",
    createdAt: notice.receivedAt,
    ...overrides,
  };
}

test("D14 T2: ambiguous same-company notice requires an explicit application choice", () => {
  const item = suggestion();
  const draft = initialDraft(item);
  assert.deepEqual(
    item.candidates.map((candidate) => candidate.id),
    expected.logicalEntities.sameCompanyAmbiguity.map((id: string) => byId("applications", id).fixtureUuid),
  );
  assert.equal(draft.applicationId, "");
  assert.match(confirmBlocker(draft, item) ?? "", /哪一条申请/);

  const applicationB = application("application-b");
  const selected = { ...draft, applicationId: applicationB.id };
  assert.equal(confirmBlocker(selected, item), null);
  assert.equal(confirmArgs(selected, item).applicationId, applicationB.id);
  assert.equal(
    isModified(selected, item),
    false,
    "choosing among the model's candidates is required approval, not an edit to the suggestion",
  );
});

test("D14 T2: edited review sends only the approved candidate, stage and todo", () => {
  const item = suggestion({
    todos: [
      {
        title: "一面",
        duePrecision: "datetime",
        dueAtUtc: "2026-10-22T06:00:00Z",
        dueDate: null,
        timeZone: dataset.generatedFrom.timezone,
        interviewRound: 1,
      },
    ],
  });
  const applicationB = application("application-b");
  const draft = initialDraft(item);
  const edited = {
    ...draft,
    applicationId: applicationB.id,
    replyClass: "interview_invite" as const,
    sendMode: "human" as const,
    updateProgress: true,
    todos: [
      {
        ...draft.todos[0]!,
        title: "平台工程师面试（已人工改期）",
        dueAtUtc: "2026-10-24T02:30:00Z",
      },
    ],
  };

  assert.equal(confirmBlocker(edited, item), null);
  const args = confirmArgs(edited, item);
  assert.equal(args.applicationId, applicationB.id);
  assert.equal(args.replyClass, "interview_invite");
  assert.equal(args.sendMode, "human");
  assert.equal(args.stage, "interview");
  assert.equal(args.createTodos, true);
  assert.deepEqual(args.todos, [
    {
      title: "平台工程师面试（已人工改期）",
      duePrecision: "datetime",
      dueAtUtc: "2026-10-24T02:30:00Z",
      dueDate: null,
      timeZone: "Asia/Shanghai",
      interviewRound: 1,
    },
  ]);
});

test("D14 T2: ATS interview remains automated and progress is opt-in", () => {
  const notice = byId("notices", "notice-ats-interview-a");
  const item = suggestion({
    id: "d14-suggestion-ats",
    evidenceId: notice.logicalId,
    candidates: [suggestion().candidates[0]!],
    replyClass: notice.expectedReplyClass,
    sendMode: notice.expectedSendMode,
  });
  const draft = initialDraft(item);

  assert.equal(draft.applicationId, application("application-a").id);
  assert.equal(draft.sendMode, "automated");
  assert.equal(draft.updateProgress, false);
  const args = confirmArgs(draft, item);
  assert.equal(args.stage, "interview", "the proposed stage remains visible for review");
  assert.equal(args.updateProgress, false, "the backend must not apply the proposed stage without opt-in");
});

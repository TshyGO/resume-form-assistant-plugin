import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  ISSUE_LABEL,
  ISSUE_MARKER,
  StoreWatchError,
  describeStatus,
  main,
  parseAssignees,
  reminderIssue,
  syncReminderIssue,
} from "./chrome-web-store-watch.js";

const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, "..", "..");
const repository = "ptjworks/resume-form-assistant-plugin";
const token = "ghs_watch-token-value";

const staged = {
  publishedVersions: ["0.4.2"],
  submittedVersions: ["0.4.3"],
  submittedState: "STAGED",
  uploadState: null,
  takenDown: false,
  warned: false,
};

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

/** 假的 GitHub：只记录调用，按路径回放预设的应答。 */
function fakeGitHub(routes) {
  const calls = [];
  const fetchImpl = async (url, options) => {
    const path = String(url).replace(`https://api.github.com/repos/${repository}`, "");
    const body = options.body === undefined ? undefined : JSON.parse(options.body);
    calls.push({ method: options.method, path, body, headers: options.headers });
    const route = routes[`${options.method} ${path.split("?")[0]}`];
    if (!route) throw new Error(`unexpected ${options.method} ${path}`);
    return typeof route === "function" ? route(body) : jsonResponse(route);
  };
  return { calls, fetchImpl };
}

test("过审停在 STAGED 时提醒写明版本、tag 和上线命令", () => {
  const issue = reminderIssue(staged, { repository });
  assert.ok(issue);
  assert.match(issue.title, /0\.4\.3 已过审，等待上线/);
  assert.match(issue.body, /STAGED/);
  assert.match(issue.body, /还是 0\.4\.2/);
  assert.ok(issue.body.includes(
    `gh workflow run release.yml --repo ${repository} --ref v0.4.3 -f dry_run=false -f release_staged=true`,
  ));
  assert.ok(issue.body.includes(`https://github.com/${repository}/actions/workflows/release.yml`));
  assert.match(issue.body, /\n<!-- chrome-web-store-watch v=[0-9a-f]{16} -->$/);
  assert.ok(issue.body.endsWith(`v=${issue.fingerprint} -->`));
  // 不知道仓库时命令照样能在克隆里用，只是不带 --repo。
  assert.match(reminderIssue(staged).body, /gh workflow run release\.yml --ref v0\.4\.3 /);
});

test("被拒、被警告或下架也提醒；审核中、已上线、已取消不提醒", () => {
  const rejected = reminderIssue({ ...staged, submittedState: "REJECTED" }, { repository });
  assert.match(rejected.title, /0\.4\.3 被商店拒绝/);
  assert.match(rejected.body, /版本号升上去/);
  assert.doesNotMatch(rejected.body, /release_staged/);

  const takenDown = reminderIssue({ ...staged, submittedState: "PENDING_REVIEW", takenDown: true });
  assert.match(takenDown.title, /已被下架/);
  assert.match(reminderIssue({ publishedVersions: ["0.4.2"], warned: true }).title, /政策警告/);

  for (const submittedState of ["PENDING_REVIEW", "PUBLISHED", "CANCELLED", null]) {
    assert.equal(reminderIssue({ ...staged, submittedState }), null, String(submittedState));
  }
  assert.equal(reminderIssue({ publishedVersions: ["0.4.3"], submittedVersions: [], submittedState: null }), null);
  assert.throws(() => reminderIssue([]), StoreWatchError);
});

test("正文不含 uploadState，同一状态每天生成的内容一样", () => {
  const first = reminderIssue(staged, { repository });
  const later = reminderIssue({ ...staged, uploadState: "SUCCEEDED" }, { repository });
  assert.deepEqual(later, first);
  assert.equal(describeStatus(staged), "线上 0.4.2；已提交 0.4.3（STAGED）");
  assert.equal(describeStatus({}), "线上 无；已提交 无");
});

test("没有提醒 issue 时建标签再开一个，并指派维护者", async () => {
  const issue = reminderIssue(staged, { repository });
  const github = fakeGitHub({
    "GET /issues": [],
    "POST /labels": () => jsonResponse({ message: "Validation Failed" }, 422),
    "POST /issues": (body) => jsonResponse({ number: 7, ...body }, 201),
  });
  const result = await syncReminderIssue({
    issue, status: staged, repository, token, fetchImpl: github.fetchImpl, assignees: ["TshyGO"],
  });
  assert.deepEqual(result, { action: "opened", numbers: [7] });
  const created = github.calls.find((call) => call.method === "POST" && call.path === "/issues");
  assert.deepEqual(created.body, { title: issue.title, body: issue.body, labels: [ISSUE_LABEL], assignees: ["TshyGO"] });
  assert.match(github.calls[0].path, /state=open/);
  assert.ok(github.calls[0].path.includes(`labels=${encodeURIComponent(ISSUE_LABEL)}`));
  assert.equal(github.calls[0].headers.Authorization, `Bearer ${token}`);
});

test("指派人填错时去掉指派人照样开出提醒", async () => {
  const issue = reminderIssue(staged, { repository });
  const bodies = [];
  const github = fakeGitHub({
    "GET /issues": [],
    "POST /labels": { name: ISSUE_LABEL },
    "POST /issues": (body) => {
      bodies.push(body);
      return body.assignees ? jsonResponse({ message: "Validation Failed" }, 422) : jsonResponse({ number: 8 }, 201);
    },
  });
  const result = await syncReminderIssue({
    issue, status: staged, repository, token, fetchImpl: github.fetchImpl, assignees: ["not-a-collaborator"],
  });
  assert.deepEqual(result, { action: "opened", numbers: [8] });
  assert.equal(bodies.length, 2);
  assert.equal(bodies[1].assignees, undefined);
  assert.deepEqual(parseAssignees(" TshyGO, bad/name ,,foo-,-foo"), { valid: ["TshyGO"], invalid: ["bad/name", "foo-", "-foo"] });
});

test("状态没变就不动 issue，维护者补的说明也保留；变了先留言再更新", async () => {
  const issue = reminderIssue(staged, { repository });
  const edited = `维护者补充：周一再上线。\r\n\r\n${issue.body.replace(/\n/g, "\r\n")}`;
  const existing = { number: 5, title: "维护者改过的标题", body: edited };
  const unchanged = fakeGitHub({ "GET /issues": [existing] });
  assert.deepEqual(
    await syncReminderIssue({ issue, status: staged, repository, token, fetchImpl: unchanged.fetchImpl }),
    { action: "unchanged", numbers: [5] },
  );
  assert.equal(unchanged.calls.length, 1);

  const rejectedStatus = { ...staged, submittedState: "REJECTED" };
  const rejected = reminderIssue(rejectedStatus, { repository });
  assert.notEqual(rejected.fingerprint, issue.fingerprint);
  const changed = fakeGitHub({
    "GET /issues": [existing],
    "PATCH /issues/5": (body) => jsonResponse({ number: 5, ...body }),
    "POST /issues/5/comments": { id: 1 },
  });
  assert.deepEqual(
    await syncReminderIssue({ issue: rejected, status: rejectedStatus, repository, token, fetchImpl: changed.fetchImpl }),
    { action: "updated", numbers: [5] },
  );
  // 留言在前：改正文之后留言失败的话，下次运行会以为已经通知过。
  assert.deepEqual(changed.calls.slice(1).map((call) => `${call.method} ${call.path}`), [
    "POST /issues/5/comments",
    "PATCH /issues/5",
  ]);
  assert.match(changed.calls[1].body.body, /被商店拒绝/);
  assert.deepEqual(changed.calls[2].body, { title: rejected.title, body: rejected.body });

  // 留言失败时不改正文，下次运行指纹仍不同，会再留言。
  const commentFails = fakeGitHub({
    "GET /issues": [existing],
    "POST /issues/5/comments": () => jsonResponse({ message: "Server Error" }, 502),
  });
  await assert.rejects(
    () => syncReminderIssue({ issue: rejected, status: rejectedStatus, repository, token, fetchImpl: commentFails.fetchImpl }),
    (error) => error instanceof StoreWatchError && error.status === 502,
  );
  assert.equal(commentFails.calls.some((call) => call.method === "PATCH"), false);
});

test("多出来的提醒 issue 指向最早那个后关闭", async () => {
  const issue = reminderIssue(staged, { repository });
  const github = fakeGitHub({
    "GET /issues": [
      { number: 12, title: "旧提醒", body: `旧\n${ISSUE_MARKER} v=0000000000000000 -->` },
      { number: 5, title: issue.title, body: issue.body },
    ],
    "POST /issues/12/comments": { id: 3 },
    "PATCH /issues/12": { number: 12, state: "closed" },
  });
  assert.deepEqual(
    await syncReminderIssue({ issue, status: staged, repository, token, fetchImpl: github.fetchImpl }),
    { action: "unchanged", numbers: [5] },
  );
  assert.match(github.calls[1].body.body, /以 #5 为准/);
  assert.deepEqual(github.calls[2].body, { state: "closed", state_reason: "not_planned" });
  assert.equal(github.calls.length, 3);
});

test("情况消失后留言并关闭提醒；不碰别的同标签 issue 和 PR", async () => {
  const published = { publishedVersions: ["0.4.3"], submittedVersions: [], submittedState: null };
  const github = fakeGitHub({
    "GET /issues": [
      { number: 9, title: "手动打了同一标签", body: "人写的说明" },
      { number: 10, title: "PR", body: ISSUE_MARKER, pull_request: {} },
      { number: 5, title: "Chrome 商店：0.4.3 已过审，等待上线", body: `说明\n${ISSUE_MARKER}` },
    ],
    "POST /issues/5/comments": { id: 2 },
    "PATCH /issues/5": { number: 5, state: "closed" },
  });
  const result = await syncReminderIssue({ issue: null, status: published, repository, token, fetchImpl: github.fetchImpl });
  assert.deepEqual(result, { action: "closed", numbers: [5] });
  assert.match(github.calls[1].body.body, /线上 0\.4\.3/);
  assert.deepEqual(github.calls[2].body, { state: "closed", state_reason: "completed" });
  assert.equal(github.calls.some((call) => call.path.startsWith("/issues/9") || call.path.startsWith("/issues/10")), false);

  const quiet = fakeGitHub({ "GET /issues": [] });
  assert.deepEqual(
    await syncReminderIssue({ issue: null, status: published, repository, token, fetchImpl: quiet.fetchImpl }),
    { action: "none", numbers: [] },
  );
});

test("GitHub 报错里不留下 token；仓库名和 token 缺失时不发请求", async () => {
  const issue = reminderIssue(staged, { repository });
  await assert.rejects(
    () => syncReminderIssue({
      issue,
      status: staged,
      repository,
      token,
      fetchImpl: async () => jsonResponse({ message: `Bad credentials ${token}` }, 401),
    }),
    (error) => error instanceof StoreWatchError && error.status === 401 && !error.message.includes(token),
  );
  await assert.rejects(
    () => syncReminderIssue({
      issue, status: staged, repository, token, fetchImpl: async () => { throw new Error(`socket ${token}`); },
    }),
    (error) => error instanceof StoreWatchError && !error.message.includes(token),
  );
  const refuse = async () => { throw new Error("must not fetch"); };
  await assert.rejects(() => syncReminderIssue({ issue, status: staged, repository: "", token, fetchImpl: refuse }), /owner\/repo/);
  await assert.rejects(() => syncReminderIssue({ issue, status: staged, repository, token: "", fetchImpl: refuse }), /GITHUB_TOKEN/);
});

test("main 默认只打印判断；--sync 才改 issue", async () => {
  const lines = [];
  const files = { "status.json": JSON.stringify(staged), "bad.json": "Chrome Web Store GET failed" };
  const io = {
    readFile: (path) => files[path],
    log: (line) => lines.push(line),
    fetchImpl: async () => { throw new Error("print mode must not fetch"); },
  };
  await main(["--status", "status.json"], {}, io);
  assert.match(lines.join("\n"), /0\.4\.3 已过审/);
  await assert.rejects(() => main(["--status", "bad.json"], {}, io), /不是 chrome-web-store\.js status 输出的 JSON/);
  await assert.rejects(() => main([], {}, io), /用法/);

  const github = fakeGitHub({
    "GET /issues": [],
    "POST /labels": { name: ISSUE_LABEL },
    "POST /issues": (body) => jsonResponse({ number: 11, ...body }, 201),
  });
  lines.length = 0;
  await main(["--status", "status.json", "--sync"], {
    GITHUB_REPOSITORY: repository,
    GITHUB_TOKEN: token,
    WATCH_ASSIGNEES: "TshyGO,bad/name",
  }, { ...io, fetchImpl: github.fetchImpl });
  const printed = lines.join("\n");
  assert.match(printed, /issue: opened #11/);
  assert.match(printed, /跳过不合法的指派人：bad\/name/);
  assert.equal(printed.includes(token), false);
  assert.deepEqual(github.calls.at(-1).body.assignees, ["TshyGO"]);
});

test("提醒工作流每天只读商店，商店凭据和 GitHub token 分在两步", () => {
  const workflow = readFileSync(join(repo, ".github", "workflows", "chrome-web-store-watch.yml"), "utf8")
    .split("\r\n").join("\n");
  assert.match(workflow, /schedule:\n\s+- cron:/);
  assert.match(workflow, /workflow_dispatch:/);
  assert.match(workflow, /runs-on: ubuntu-latest/);
  assert.match(workflow, /issues: write/);
  assert.doesNotMatch(workflow, /contents: write/);
  assert.match(workflow, /persist-credentials: false/);
  // 别的分支手动运行时，在拿到商店凭据之前就失败。
  const guard = workflow.indexOf('test "$REF" = "refs/heads/main"');
  assert.ok(guard > 0 && guard < workflow.indexOf("secrets."));
  // 只读商店：不出现上传、送审、上线。
  assert.match(workflow, /chrome-web-store\.js status/);
  assert.doesNotMatch(workflow, /chrome-web-store\.js (publish|release-staged)/);
  assert.doesNotMatch(workflow, /release_staged=true/);

  const steps = workflow.split(/\n {6}- name: /);
  const statusStep = steps.find((step) => step.startsWith("Read the store status"));
  const syncStep = steps.find((step) => step.startsWith("Open, update or close the reminder issue"));
  assert.ok(statusStep && syncStep);
  assert.match(statusStep, /CHROME_WEB_STORE_CREDENTIALS/);
  assert.doesNotMatch(statusStep, /github\.token|GITHUB_TOKEN/);
  assert.match(syncStep, /GITHUB_TOKEN: \$\{\{ github\.token \}\}/);
  assert.match(syncStep, /chrome-web-store-watch\.js --status .* --sync/);
  assert.doesNotMatch(syncStep, /secrets\./);
  assert.equal((workflow.match(/secrets\./g) ?? []).length, 6);
});

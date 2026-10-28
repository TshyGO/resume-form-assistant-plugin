import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  DIGEST_LABEL,
  ISSUE_LABEL,
  ISSUE_MARKER,
  STALE_HOURS,
  DigestWatchError,
  describeDigest,
  describeTime,
  fetchLatestDigest,
  main,
  reminderIssue,
  syncReminderIssue,
} from "./feedback-digest-watch.js";

const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, "..", "..");
const repository = "ptjworks/resume-form-assistant-plugin";
const token = "ghs_watch-token-value";
const HOUR_MS = 60 * 60 * 1000;

const lastDigest = { number: 342, title: "【用户反馈日报】2026-10-24", created_at: "2026-10-24T23:57:00Z" };
const createdMs = Date.parse(lastDigest.created_at);
const at = (hours) => new Date(createdMs + hours * HOUR_MS);
const freshDigest = { number: 360, title: "【用户反馈日报】2026-10-29", created_at: "2026-10-29T23:57:00Z" };

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
    return typeof route === "function" ? route(body, path) : jsonResponse(route);
  };
  return { calls, fetchImpl };
}

test("36 小时内有日报不提醒，正好 36 小时也不提醒，超过才提醒", () => {
  assert.equal(STALE_HOURS, 36);
  assert.equal(reminderIssue(lastDigest, at(2.7), { repository }), null);
  assert.equal(reminderIssue(lastDigest, at(26.7), { repository }), null);
  assert.equal(reminderIssue(lastDigest, at(36), { repository }), null);
  // 时钟偏差导致日报看起来来自未来，也不算停了。
  assert.equal(reminderIssue(lastDigest, at(-1), { repository }), null);

  const stale = reminderIssue(lastDigest, new Date(createdMs + 36 * HOUR_MS + 1), { repository });
  assert.ok(stale);
  assert.equal(stale.title, "用户反馈日报超过 36 小时没有生成");
  assert.ok(stale.body.includes("#342「【用户反馈日报】2026-10-24」"));
  assert.ok(stale.body.includes("2026-10-24 23:57 UTC（台北时间 2026-10-25 07:57）"));
  assert.match(stale.body, /relay \/ Muse/);
  assert.match(stale.body, /GitHub token/);
  assert.ok(stale.body.includes(`仓库路径是否是 ${repository}`));
  assert.ok(stale.body.includes(`https://github.com/${repository}/actions/workflows/feedback-digest-watch.yml`));
  assert.match(stale.body, /\n<!-- feedback-digest-watch v=[0-9a-f]{16} -->$/);
  assert.ok(stale.body.endsWith(`v=${stale.fingerprint} -->`));
});

test("一份日报都没有时也提醒", () => {
  const issue = reminderIssue(null, at(0), { repository });
  assert.ok(issue);
  assert.equal(issue.title, "用户反馈日报超过 36 小时没有生成");
  assert.ok(issue.body.includes(`带「${DIGEST_LABEL}」标签的 issue 里没有标题以【用户反馈日报】开头的日报`));
  assert.doesNotMatch(issue.body, /最近一份日报是/);
  // 不知道仓库时也能生成，只是不带链接。
  assert.doesNotMatch(reminderIssue(null, at(0)).body, /https:\/\//);
});

test("正文不含当前时间，日报不变时每天生成的内容一样", () => {
  const first = reminderIssue(lastDigest, at(40), { repository });
  assert.deepEqual(reminderIssue(lastDigest, at(100), { repository }), first);
  const newer = { number: 343, title: "【用户反馈日报】2026-10-25", created_at: "2026-10-25T23:57:00Z" };
  assert.notEqual(reminderIssue(newer, at(100), { repository }).fingerprint, first.fingerprint);
  assert.notEqual(reminderIssue(null, at(100), { repository }).fingerprint, first.fingerprint);
});

test("日报缺编号或时间、当前时间无效时报错，不当成没事", () => {
  assert.throws(() => reminderIssue({ number: 1, created_at: "not a date" }, at(0)), DigestWatchError);
  assert.throws(() => reminderIssue({ created_at: lastDigest.created_at }, at(0)), DigestWatchError);
  assert.throws(() => reminderIssue(lastDigest, new Date("nope")), DigestWatchError);
  assert.throws(() => reminderIssue(lastDigest, "2026-10-29"), DigestWatchError);
  assert.equal(describeTime(new Date("2026-12-31T20:05:00Z")), "2026-12-31 20:05 UTC（台北时间 2027-01-01 04:05）");
  assert.equal(describeDigest({ ...lastDigest, title: "  多行\n标题 " }).startsWith("#342「多行 标题」"), true);
});

test("按创建时间倒序取最新一份日报，开着关着都算", async () => {
  const github = fakeGitHub({ "GET /issues": [lastDigest] });
  assert.deepEqual(await fetchLatestDigest({ repository, token, fetchImpl: github.fetchImpl }), lastDigest);
  const query = new URLSearchParams(github.calls[0].path.split("?")[1]);
  assert.equal(query.get("labels"), DIGEST_LABEL);
  assert.equal(query.get("state"), "all");
  assert.equal(query.get("sort"), "created");
  assert.equal(query.get("direction"), "desc");
  assert.equal(query.get("per_page"), "20");
  assert.equal(github.calls[0].headers.Authorization, `Bearer ${token}`);

  const none = fakeGitHub({ "GET /issues": [] });
  assert.equal(await fetchLatestDigest({ repository, fetchImpl: none.fetchImpl }), null);
  assert.equal(none.calls[0].headers.Authorization, undefined);
  const odd = fakeGitHub({ "GET /issues": { message: "odd" } });
  await assert.rejects(() => fetchLatestDigest({ repository, fetchImpl: odd.fetchImpl }), /不是数组/);
});

test("同标签的 PR 和讨论 issue 不算日报，日报停了照样提醒", async () => {
  const pr = { number: 370, title: "【用户反馈日报】修模板", created_at: "2026-10-29T08:00:00Z", pull_request: {} };
  const discussion = { number: 369, title: "日报停了的讨论", created_at: "2026-10-29T07:00:00Z" };
  const github = fakeGitHub({ "GET /issues": [pr, discussion, lastDigest] });
  const digest = await fetchLatestDigest({ repository, token, fetchImpl: github.fetchImpl });
  assert.deepEqual(digest, lastDigest);
  assert.ok(reminderIssue(digest, at(40), { repository }));

  const onlyNoise = fakeGitHub({ "GET /issues": [pr, discussion] });
  assert.equal(await fetchLatestDigest({ repository, fetchImpl: onlyNoise.fetchImpl }), null);
});

test("没有提醒 issue 时建标签再开一个，并指派维护者", async () => {
  const issue = reminderIssue(lastDigest, at(50), { repository });
  const github = fakeGitHub({
    "GET /issues": [],
    "POST /labels": (body) => jsonResponse({ ...body }, 201),
    "POST /issues": (body) => jsonResponse({ number: 7, ...body }, 201),
  });
  const result = await syncReminderIssue({
    issue, digest: lastDigest, repository, token, fetchImpl: github.fetchImpl, assignees: ["TshyGO"],
  });
  assert.deepEqual(result, { action: "opened", numbers: [7] });
  assert.match(github.calls[0].path, /state=open/);
  assert.ok(github.calls[0].path.includes(`labels=${encodeURIComponent(ISSUE_LABEL)}`));
  const label = github.calls.find((call) => call.path === "/labels");
  assert.equal(label.body.name, ISSUE_LABEL);
  assert.match(label.body.color, /^[0-9A-F]{6}$/);
  const created = github.calls.find((call) => call.method === "POST" && call.path === "/issues");
  assert.deepEqual(created.body, { title: issue.title, body: issue.body, labels: [ISSUE_LABEL], assignees: ["TshyGO"] });

  // 标签已经存在（422）时照样开 issue；别的错误不吞掉。
  const exists = fakeGitHub({
    "GET /issues": [],
    "POST /labels": () => jsonResponse({ message: "Validation Failed" }, 422),
    "POST /issues": { number: 8 },
  });
  assert.deepEqual(
    await syncReminderIssue({ issue, digest: lastDigest, repository, token, fetchImpl: exists.fetchImpl }),
    { action: "opened", numbers: [8] },
  );
  const forbidden = fakeGitHub({
    "GET /issues": [],
    "POST /labels": () => jsonResponse({ message: "Resource not accessible" }, 403),
  });
  await assert.rejects(
    () => syncReminderIssue({ issue, digest: lastDigest, repository, token, fetchImpl: forbidden.fetchImpl }),
    (error) => error instanceof DigestWatchError && error.status === 403,
  );
});

test("指派人填错时去掉指派人照样开出提醒", async () => {
  const issue = reminderIssue(null, at(0), { repository });
  const bodies = [];
  const github = fakeGitHub({
    "GET /issues": [],
    "POST /labels": { name: ISSUE_LABEL },
    "POST /issues": (body) => {
      bodies.push(body);
      return body.assignees ? jsonResponse({ message: "Validation Failed" }, 422) : jsonResponse({ number: 9 }, 201);
    },
  });
  assert.deepEqual(
    await syncReminderIssue({ issue, digest: null, repository, token, fetchImpl: github.fetchImpl, assignees: ["nobody-here"] }),
    { action: "opened", numbers: [9] },
  );
  assert.equal(bodies.length, 2);
  assert.equal(bodies[1].assignees, undefined);

  const noNumber = fakeGitHub({ "GET /issues": [], "POST /labels": { name: ISSUE_LABEL }, "POST /issues": {} });
  await assert.rejects(
    () => syncReminderIssue({ issue, digest: null, repository, token, fetchImpl: noNumber.fetchImpl }),
    /没有返回编号/,
  );
});

test("指纹没变就不动 issue，维护者补的说明也保留；变了先留言再更新", async () => {
  const issue = reminderIssue(lastDigest, at(50), { repository });
  const edited = `维护者补充：已经在查 Muse。\r\n\r\n${issue.body.replace(/\n/g, "\r\n")}`;
  const existing = { number: 5, title: "维护者改过的标题", body: edited };
  const unchanged = fakeGitHub({ "GET /issues": [existing] });
  assert.deepEqual(
    await syncReminderIssue({ issue: reminderIssue(lastDigest, at(80), { repository }), digest: lastDigest, repository, token, fetchImpl: unchanged.fetchImpl }),
    { action: "unchanged", numbers: [5] },
  );
  assert.equal(unchanged.calls.length, 1);

  // 中间来过一份日报但又停了：指纹变了，留言后更新正文。
  const newer = { number: 343, title: "【用户反馈日报】2026-10-25", created_at: "2026-10-25T23:57:00Z" };
  const changedIssue = reminderIssue(newer, at(100), { repository });
  const changed = fakeGitHub({
    "GET /issues": [existing],
    "PATCH /issues/5": (body) => jsonResponse({ number: 5, ...body }),
    "POST /issues/5/comments": { id: 1 },
  });
  assert.deepEqual(
    await syncReminderIssue({ issue: changedIssue, digest: newer, repository, token, fetchImpl: changed.fetchImpl }),
    { action: "updated", numbers: [5] },
  );
  assert.deepEqual(changed.calls.slice(1).map((call) => `${call.method} ${call.path}`), [
    "POST /issues/5/comments",
    "PATCH /issues/5",
  ]);
  assert.match(changed.calls[1].body.body, /#343/);
  assert.deepEqual(changed.calls[2].body, { title: changedIssue.title, body: changedIssue.body });

  // 留言失败时不改正文，下次运行指纹仍不同，会再留言。
  const commentFails = fakeGitHub({
    "GET /issues": [existing],
    "POST /issues/5/comments": () => jsonResponse({ message: "Server Error" }, 502),
  });
  await assert.rejects(
    () => syncReminderIssue({ issue: changedIssue, digest: newer, repository, token, fetchImpl: commentFails.fetchImpl }),
    (error) => error instanceof DigestWatchError && error.status === 502,
  );
  assert.equal(commentFails.calls.some((call) => call.method === "PATCH"), false);
});

test("多出来的提醒 issue 指向最早那个后关闭", async () => {
  const issue = reminderIssue(lastDigest, at(50), { repository });
  const github = fakeGitHub({
    "GET /issues": [
      { number: 12, title: "旧提醒", body: `旧\n${ISSUE_MARKER} v=0000000000000000 -->` },
      { number: 5, title: issue.title, body: issue.body },
    ],
    "POST /issues/12/comments": { id: 3 },
    "PATCH /issues/12": { number: 12, state: "closed" },
  });
  assert.deepEqual(
    await syncReminderIssue({ issue, digest: lastDigest, repository, token, fetchImpl: github.fetchImpl }),
    { action: "unchanged", numbers: [5] },
  );
  assert.match(github.calls[1].body.body, /以 #5 为准/);
  assert.deepEqual(github.calls[2].body, { state: "closed", state_reason: "not_planned" });
  assert.equal(github.calls.length, 3);
});

test("新日报出现后留言并关闭提醒；不碰别的同标签 issue 和 PR", async () => {
  const github = fakeGitHub({
    "GET /issues": [
      { number: 9, title: "手动打了同一标签", body: "人写的说明" },
      { number: 10, title: "PR", body: ISSUE_MARKER, pull_request: {} },
      { number: 5, title: "用户反馈日报超过 36 小时没有生成", body: `说明\n${ISSUE_MARKER}` },
    ],
    "POST /issues/5/comments": { id: 2 },
    "PATCH /issues/5": { number: 5, state: "closed" },
  });
  const result = await syncReminderIssue({ issue: null, digest: freshDigest, repository, token, fetchImpl: github.fetchImpl });
  assert.deepEqual(result, { action: "closed", numbers: [5] });
  assert.match(github.calls[1].body.body, /日报已经恢复/);
  assert.match(github.calls[1].body.body, /#360/);
  assert.deepEqual(github.calls[2].body, { state: "closed", state_reason: "completed" });
  assert.equal(github.calls.some((call) => call.path.startsWith("/issues/9") || call.path.startsWith("/issues/10")), false);

  const quiet = fakeGitHub({ "GET /issues": [] });
  assert.deepEqual(
    await syncReminderIssue({ issue: null, digest: freshDigest, repository, token, fetchImpl: quiet.fetchImpl }),
    { action: "none", numbers: [] },
  );
});

test("GitHub 报错里不留下 token；仓库名和 token 缺失时不发请求", async () => {
  const issue = reminderIssue(null, at(0), { repository });
  await assert.rejects(
    () => syncReminderIssue({
      issue, digest: null, repository, token,
      fetchImpl: async () => jsonResponse({ message: `Bad credentials ${token}` }, 401),
    }),
    (error) => error instanceof DigestWatchError && error.status === 401 && !error.message.includes(token),
  );
  await assert.rejects(
    () => syncReminderIssue({
      issue, digest: null, repository, token, fetchImpl: async () => { throw new Error(`socket ${token}`); },
    }),
    (error) => error instanceof DigestWatchError && !error.message.includes(token),
  );
  const refuse = async () => { throw new Error("must not fetch"); };
  await assert.rejects(() => syncReminderIssue({ issue, digest: null, repository: "", token, fetchImpl: refuse }), /owner\/repo/);
  await assert.rejects(() => syncReminderIssue({ issue, digest: null, repository, token: "", fetchImpl: refuse }), /GITHUB_TOKEN/);
  await assert.rejects(() => fetchLatestDigest({ repository: "", fetchImpl: refuse }), /owner\/repo/);
});

test("main 默认只读日报并打印判断；--sync 才改 issue", async () => {
  const lines = [];
  const reads = fakeGitHub({ "GET /issues": [lastDigest] });
  const io = { now: () => at(60), log: (line) => lines.push(line), fetchImpl: reads.fetchImpl };
  await main([], { GITHUB_REPOSITORY: repository }, io);
  assert.equal(reads.calls.length, 1);
  assert.equal(reads.calls[0].method, "GET");
  assert.match(lines.join("\n"), /最新日报：#342/);
  assert.match(lines.join("\n"), /需要处理：用户反馈日报超过 36 小时没有生成/);

  lines.length = 0;
  await main([], { GITHUB_REPOSITORY: repository }, { ...io, now: () => at(3) });
  assert.match(lines.join("\n"), /日报正常/);

  await assert.rejects(() => main(["--status", "x"], {}, io), /用法/);
  await assert.rejects(() => main(["--sync"], { GITHUB_REPOSITORY: repository }, io), /GITHUB_TOKEN/);

  // --sync：先按日报标签读最新一份，再按提醒标签找已有提醒。
  const github = fakeGitHub({
    "GET /issues": (_body, path) => jsonResponse(path.includes(`labels=${encodeURIComponent(ISSUE_LABEL)}`) ? [] : [lastDigest]),
    "POST /labels": { name: ISSUE_LABEL },
    "POST /issues": (body) => jsonResponse({ number: 11, ...body }, 201),
  });
  lines.length = 0;
  await main(["--sync"], {
    GITHUB_REPOSITORY: repository,
    GITHUB_TOKEN: token,
    WATCH_ASSIGNEES: "TshyGO,bad/name",
  }, { ...io, fetchImpl: github.fetchImpl });
  const printed = lines.join("\n");
  assert.match(printed, /issue: opened #11/);
  assert.match(printed, /跳过不合法的指派人：bad\/name/);
  assert.equal(printed.includes(token), false);
  assert.deepEqual(github.calls.at(-1).body.assignees, ["TshyGO"]);
  assert.deepEqual(github.calls.at(-1).body.labels, [ISSUE_LABEL]);
});

test("看门狗工作流每天只用 github.token，不拿别的凭据", () => {
  const workflow = readFileSync(join(repo, ".github", "workflows", "feedback-digest-watch.yml"), "utf8")
    .split("\r\n").join("\n");
  assert.match(workflow, /schedule:\n\s+- cron: "\d+ \d+ \* \* \*"/);
  assert.match(workflow, /workflow_dispatch:/);
  assert.match(workflow, /runs-on: ubuntu-latest/);
  // 顶层只读，issues: write 只给 job。
  const [top, jobs] = workflow.split("\njobs:\n");
  assert.match(top, /permissions:\n {2}contents: read\n/);
  assert.doesNotMatch(top, /issues: write/);
  assert.match(jobs, /issues: write/);
  assert.doesNotMatch(workflow, /contents: write/);
  assert.match(workflow, /persist-credentials: false/);
  assert.doesNotMatch(workflow, /secrets\./);
  // 别的分支手动运行时，在跑脚本之前就失败。
  const guard = workflow.indexOf('test "$REF" = "refs/heads/main"');
  assert.ok(guard > 0 && guard < workflow.indexOf("feedback-digest-watch.js"));
  for (const uses of workflow.match(/uses: \S+/g) ?? []) {
    assert.match(uses, /@[0-9a-f]{40}$/, uses);
  }

  const steps = workflow.split(/\n {6}- name: /);
  const syncStep = steps.find((step) => step.startsWith("Open, update or close the reminder issue"));
  assert.ok(syncStep);
  assert.match(syncStep, /GITHUB_TOKEN: \$\{\{ github\.token \}\}/);
  assert.match(syncStep, /feedback-digest-watch\.js --sync/);
});

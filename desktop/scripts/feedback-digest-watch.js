// 用户反馈日报看门狗：日报太久没生成时，放一个固定的 GitHub issue 提醒维护者。
//
// 【用户反馈日报】由仓库外的 relay / Muse 任务每天建成带「日报」标签的 issue。
// 仓库 2026-10-25 从 TshyGO 迁到 ptjworks 后这个任务悄悄停了（最后一份是 #342），
// 四天没人发现。这里读最新一份日报：没有日报，或最新一份超过 30 小时，就打开或更新
// 一个带固定标签的 issue；新日报出现后留言并关闭它。
//
//   GITHUB_REPOSITORY=ptjworks/resume-form-assistant-plugin node desktop/scripts/feedback-digest-watch.js   # 只打印判断
//   node desktop/scripts/feedback-digest-watch.js --sync   # 同步 issue（在 Actions 里跑，需要 GITHUB_TOKEN）
//
// 只用 GITHUB_TOKEN 读日报、改提醒 issue；不碰日报本身，也不读别的凭据。

import { createHash } from "node:crypto";
import { realpathSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { redact } from "./chrome-web-store.js";
import { parseAssignees } from "./chrome-web-store-watch.js";

export const DIGEST_LABEL = "日报";
// 日报 issue 的标题都以这个开头。带「日报」标签的讨论 issue、PR 不算日报。
export const DIGEST_TITLE_PREFIX = "【用户反馈日报】";
// 往前看多少条带标签的 issue 找真正的日报。
const DIGEST_SCAN = 20;
export const ISSUE_LABEL = "日报提醒";
// 正文末尾的标记带着生成内容的指纹：`<!-- feedback-digest-watch v=… -->`。
// 只比指纹，维护者在正文里补的说明不会被下次运行覆盖。
export const ISSUE_MARKER = "<!-- feedback-digest-watch";
const FINGERPRINT = /<!-- feedback-digest-watch v=([0-9a-f]{16}) -->/;
// 日报平常在 UTC 23:57 左右生成，看门狗每天 UTC 02:37 和 14:37 各查一次。晚几个小时不算停；
// 漏了一份，下一次 14:37 的检查（日报约 38.7 小时没更新）就会提醒。
export const STALE_HOURS = 30;
const HOUR_MS = 60 * 60 * 1000;
const LABEL_COLOR = "D93F0B";
const LABEL_DESCRIPTION = "用户反馈日报太久没有生成（自动维护）";
const GITHUB_API_VERSION = "2022-11-28";

export class DigestWatchError extends Error {
  constructor(message) {
    super(message);
    this.name = "DigestWatchError";
  }
}

function pad(value) {
  return String(value).padStart(2, "0");
}

function formatTime(date, offsetHours) {
  const shifted = new Date(date.getTime() + offsetHours * HOUR_MS);
  return `${shifted.getUTCFullYear()}-${pad(shifted.getUTCMonth() + 1)}-${pad(shifted.getUTCDate())} ${pad(shifted.getUTCHours())}:${pad(shifted.getUTCMinutes())}`;
}

/** UTC 和台北时间并排写。台北没有夏令时，固定 UTC+8。 */
export function describeTime(date) {
  return `${formatTime(date, 0)} UTC（台北时间 ${formatTime(date, 8)}）`;
}

function digestCreatedAt(digest) {
  const createdAt = new Date(String(digest?.created_at ?? ""));
  if (!Number.isInteger(digest?.number) || Number.isNaN(createdAt.getTime())) {
    throw new DigestWatchError("最新的日报 issue 缺少编号或创建时间");
  }
  return createdAt;
}

function digestTitle(digest) {
  return String(digest?.title ?? "").replace(/\s+/g, " ").trim() || "（无标题）";
}

export function describeDigest(digest) {
  if (!digest) return `最近 ${DIGEST_SCAN} 条带「${DIGEST_LABEL}」标签的 issue 里没有标题以${DIGEST_TITLE_PREFIX}开头的日报`;
  return `#${digest.number}「${digestTitle(digest)}」，创建于 ${describeTime(digestCreatedAt(digest))}`;
}

/**
 * 根据最新一份日报（没有就是 null）和当前时间决定提醒内容。不需要提醒时返回 null。
 * 正好 30 小时还不提醒，超过才提醒。正文只放日报编号、标题和创建时间，不放当前时间，
 * 日报一直没变就不会每天改 issue。
 */
export function reminderIssue(digest, now, { repository = "", serverUrl = "https://github.com" } = {}) {
  const nowMs = now instanceof Date ? now.getTime() : Number.NaN;
  if (Number.isNaN(nowMs)) throw new DigestWatchError("当前时间无效");
  if (digest && nowMs - digestCreatedAt(digest).getTime() <= STALE_HOURS * HOUR_MS) return null;

  const repoUrl = repository ? `${serverUrl}/${repository}` : "";
  const repoName = repository || "现在的仓库";
  const title = `用户反馈日报超过 ${STALE_HOURS} 小时没有生成`;
  const last = digest
    ? `最近一份日报是 ${describeDigest(digest)}。`
    : `${describeDigest(null)}，日报可能从没生成过，或者标签、标题格式改了。`;
  const watchLink = repoUrl ? `[Feedback Digest Watch](${repoUrl}/actions/workflows/feedback-digest-watch.yml)` : "Feedback Digest Watch";
  const text = [
    `## ${title}`,
    "",
    `${last}日报平常每天 UTC 23:57 左右生成，超过 ${STALE_HOURS} 小时没有新的，说明生成日报的任务停了。`,
    "",
    "请检查：",
    "",
    "- 发日报的 relay / Muse 任务还在不在跑，最近一次运行有没有报错。",
    `- 它用的 GitHub token 是否还有效，有没有在 ${repoName} 建 issue 的权限。`,
    `- 它配置的仓库路径是否是 ${repoName}（仓库 2026-10 从 TshyGO 迁到了 ptjworks）。`,
    `- 新建的日报是否还带「${DIGEST_LABEL}」标签，标题是否还以${DIGEST_TITLE_PREFIX}开头。`,
    "",
    "---",
    "",
    `这个 issue 由 ${watchLink} 每天检查后自动打开、更新和关闭。情况还在时手动关掉，下次检查会重新打开一个。`,
    "补充说明请写在评论里：情况变化时正文会整段重写。正文末尾的隐藏标记不要删，脚本靠它认出这个 issue。",
  ].join("\n");
  const fingerprint = createHash("sha256").update(`${title}\n${text}`).digest("hex").slice(0, 16);
  return { title, body: `${text}\n\n${ISSUE_MARKER} v=${fingerprint} -->`, fingerprint };
}

function createGitHub({ apiUrl, repository, token, fetchImpl, requireToken }) {
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository)) {
    throw new DigestWatchError(`GITHUB_REPOSITORY 应该是 owner/repo，现在是 ${repository || "空"}`);
  }
  if (requireToken && !token) throw new DigestWatchError("同步 issue 需要 GITHUB_TOKEN");
  return async function github(method, path, body) {
    const url = `${apiUrl}/repos/${repository}${path}`;
    let response;
    try {
      response = await fetchImpl(url, {
        method,
        redirect: "error",
        headers: {
          Accept: "application/vnd.github+json",
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
          "User-Agent": "feedback-digest-watch",
          "X-GitHub-Api-Version": GITHUB_API_VERSION,
          ...(body === undefined ? {} : { "Content-Type": "application/json" }),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
    } catch (error) {
      throw new DigestWatchError(redact(`GitHub ${method} ${path} failed: ${error instanceof Error ? error.message : error}`, [token]));
    }
    const text = await response.text();
    let parsed = null;
    if (text) {
      try {
        parsed = JSON.parse(text);
      } catch {
        parsed = text;
      }
    }
    if (!response.ok) {
      const detail = parsed && typeof parsed === "object" ? parsed.message ?? JSON.stringify(parsed) : String(parsed ?? "");
      const failure = new DigestWatchError(redact(`GitHub ${method} ${path} failed: HTTP ${response.status} ${detail}`, [token]));
      failure.status = response.status;
      throw failure;
    }
    return parsed;
  };
}

/**
 * 按创建时间倒序读带「日报」标签的 issue（开着的、关了的都算），取第一份真正的日报。
 * 只取一条不够：有人给讨论 issue 或 PR 打了同一标签，它比最后一份日报新，
 * 就会被当成新日报，日报停了也报正常，还会把开着的提醒关掉。
 */
async function readLatestDigest(github) {
  const query = new URLSearchParams({ labels: DIGEST_LABEL, state: "all", sort: "created", direction: "desc", per_page: String(DIGEST_SCAN) });
  const listed = await github("GET", `/issues?${query}`);
  if (!Array.isArray(listed)) throw new DigestWatchError("GitHub 列 issue 的应答不是数组");
  return listed.find((item) => !item?.pull_request && String(item?.title ?? "").trim().startsWith(DIGEST_TITLE_PREFIX)) ?? null;
}

export async function fetchLatestDigest({ repository, token = "", fetchImpl, apiUrl = "https://api.github.com" }) {
  return readLatestDigest(createGitHub({ apiUrl, repository, token, fetchImpl, requireToken: false }));
}

/**
 * 只认带固定标签、正文里有标记的 issue，别人手动打了同一标签的 issue 不会被改或关。
 * issue 被手动关掉而情况还在时，会新开一个。
 */
export async function syncReminderIssue({
  issue,
  digest,
  repository,
  token,
  fetchImpl,
  apiUrl = "https://api.github.com",
  assignees = [],
}) {
  const github = createGitHub({ apiUrl, repository, token, fetchImpl, requireToken: true });
  const listed = await github("GET", `/issues?state=open&labels=${encodeURIComponent(ISSUE_LABEL)}&per_page=100`);
  const open = (Array.isArray(listed) ? listed : [])
    .filter((item) => !item.pull_request && String(item.body ?? "").includes(ISSUE_MARKER))
    .sort((a, b) => a.number - b.number);

  if (!issue) {
    for (const item of open) {
      await github("POST", `/issues/${item.number}/comments`, {
        body: `日报已经恢复，自动关闭。最新一份是 ${describeDigest(digest)}。`,
      });
      await github("PATCH", `/issues/${item.number}`, { state: "closed", state_reason: "completed" });
    }
    return { action: open.length > 0 ? "closed" : "none", numbers: open.map((item) => item.number) };
  }

  const [current, ...duplicates] = open;
  if (current) {
    // 多出来的提醒（手动重开的旧 issue 等）指向编号最小的那个后关闭，不留陈旧状态。
    for (const item of duplicates) {
      await github("POST", `/issues/${item.number}/comments`, { body: `重复的日报提醒，以 #${current.number} 为准，自动关闭。` });
      await github("PATCH", `/issues/${item.number}`, { state: "closed", state_reason: "not_planned" });
    }
    if (FINGERPRINT.exec(String(current.body ?? ""))?.[1] === issue.fingerprint) {
      return { action: "unchanged", numbers: [current.number] };
    }
    // 改正文不会通知任何人，留言才会。先留言：正文没改成，下次运行指纹仍不同，会再试一次，
    // 通知不会因为正文已经是新的而丢掉。
    await github("POST", `/issues/${current.number}/comments`, {
      body: `日报还是没有恢复，最新一份是 ${describeDigest(digest)}。上面的说明已更新。`,
    });
    await github("PATCH", `/issues/${current.number}`, { title: issue.title, body: issue.body });
    return { action: "updated", numbers: [current.number] };
  }

  try {
    await github("POST", "/labels", { name: ISSUE_LABEL, color: LABEL_COLOR, description: LABEL_DESCRIPTION });
  } catch (error) {
    // 422 是标签已经存在。
    if (!(error instanceof DigestWatchError) || error.status !== 422) throw error;
  }
  const fields = { title: issue.title, body: issue.body, labels: [ISSUE_LABEL] };
  let created;
  try {
    created = await github("POST", "/issues", assignees.length > 0 ? { ...fields, assignees } : fields);
  } catch (error) {
    // 指派人填错时 GitHub 回 422。提醒本身比指派重要，去掉指派人再开一次。
    if (assignees.length === 0 || !(error instanceof DigestWatchError) || error.status !== 422) throw error;
    created = await github("POST", "/issues", fields);
  }
  if (!Number.isInteger(created?.number)) {
    throw new DigestWatchError("GitHub 建 issue 后没有返回编号");
  }
  return { action: "opened", numbers: [created.number] };
}

export async function main(argv, env = process.env, io = {}) {
  const unknown = argv.filter((arg) => arg !== "--sync");
  if (unknown.length > 0) {
    throw new DigestWatchError(`用法：feedback-digest-watch.js [--sync]，不认识 ${unknown.join(" ")}`);
  }
  const log = io.log ?? console.log;
  const now = io.now ? io.now() : new Date();
  const repository = env.GITHUB_REPOSITORY ?? "";
  const token = env.GITHUB_TOKEN ?? "";
  const fetchImpl = io.fetchImpl ?? globalThis.fetch;
  const apiUrl = env.GITHUB_API_URL || "https://api.github.com";
  const sync = argv.includes("--sync");
  if (sync && !token) throw new DigestWatchError("同步 issue 需要 GITHUB_TOKEN");

  const digest = await fetchLatestDigest({ repository, token, fetchImpl, apiUrl });
  const issue = reminderIssue(digest, now, { repository, serverUrl: env.GITHUB_SERVER_URL || "https://github.com" });
  log(`最新日报：${describeDigest(digest)}`);
  log(issue ? `需要处理：${issue.title}` : `日报正常，${STALE_HOURS} 小时内有新的`);
  if (!sync) return;

  const assignees = parseAssignees(env.WATCH_ASSIGNEES);
  if (assignees.invalid.length > 0) {
    log(`跳过不合法的指派人：${assignees.invalid.join(", ")}`);
  }
  const result = await syncReminderIssue({
    issue,
    digest,
    repository,
    token,
    fetchImpl,
    apiUrl,
    assignees: assignees.valid,
  });
  const numbers = result.numbers.map((number) => `#${number}`).join(", ");
  log(`issue: ${result.action}${numbers ? ` ${numbers}` : ""}`);
}

function invokedDirectly() {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    return import.meta.url === pathToFileURL(realpathSync(entry)).href;
  } catch {
    return import.meta.url === pathToFileURL(entry).href;
  }
}

if (invokedDirectly()) {
  main(process.argv.slice(2)).catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}

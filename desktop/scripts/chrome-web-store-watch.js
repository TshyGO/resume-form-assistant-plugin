// 商店审核结果提醒：把需要维护者动手的商店状态放进一个固定的 GitHub issue。
//
// 正式发布故意停在 STAGED（见 chrome-web-store.js），审核通过后要维护者手动上线，
// 可商店不会通知到仓库。0.4.3 过审后一直停在 STAGED 没人发现，还挡住了 0.4.4 的上传。
// 这里读 `chrome-web-store.js status` 的输出：过审待上线、被拒、被警告或被下架时，
// 打开或更新一个带固定标签的 issue；情况消失后留言并关闭它。
//
//   node desktop/scripts/chrome-web-store.js status > store-status.json
//   node desktop/scripts/chrome-web-store-watch.js --status store-status.json          # 只打印判断
//   node desktop/scripts/chrome-web-store-watch.js --status store-status.json --sync   # 同步 issue
//
// 这个脚本不读商店凭据，也不调商店接口；--sync 只用 GITHUB_TOKEN 改 issue。

import { createHash } from "node:crypto";
import { readFileSync, realpathSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { redact } from "./chrome-web-store.js";

export const ISSUE_LABEL = "商店提醒";
// 正文末尾的标记带着生成内容的指纹：`<!-- chrome-web-store-watch v=… -->`。
// 只比指纹，维护者在正文里补的说明不会被下次运行覆盖。
export const ISSUE_MARKER = "<!-- chrome-web-store-watch";
const FINGERPRINT = /<!-- chrome-web-store-watch v=([0-9a-f]{16}) -->/;
// Chrome Web Store API v2 的 ItemState。不在这里的状态当成需要人看一眼，而不是“没事”。
const KNOWN_STATES = new Set(["PENDING_REVIEW", "STAGED", "PUBLISHED", "PUBLISHED_TO_TESTERS", "REJECTED", "CANCELLED"]);
const LABEL_COLOR = "D93F0B";
const LABEL_DESCRIPTION = "Chrome 商店审核结果需要维护者处理（自动维护）";
const GITHUB_API_VERSION = "2022-11-28";

export class StoreWatchError extends Error {
  constructor(message) {
    super(message);
    this.name = "StoreWatchError";
  }
}

function versionList(value) {
  return Array.isArray(value) ? value.filter((version) => typeof version === "string" && version.length > 0) : [];
}

export function describeStatus(status) {
  const published = versionList(status?.publishedVersions);
  const submitted = versionList(status?.submittedVersions);
  const state = status?.submittedState ?? null;
  const live = published.join("、") || "无";
  const pending = submitted.length > 0 || state ? `${submitted.join("、") || "无版本"}（${state ?? "无状态"}）` : "无";
  return `线上 ${live}；已提交 ${pending}`;
}

/**
 * 根据 `status` 的输出决定提醒内容。没有需要维护者处理的事项时返回 null。
 * 正文只放版本和状态，不放 uploadState 这类每天会变的字段，状态不变就不会改 issue。
 */
export function reminderIssue(status, { repository = "", serverUrl = "https://github.com" } = {}) {
  if (!status || typeof status !== "object" || Array.isArray(status)) {
    throw new StoreWatchError("商店状态不是 JSON 对象");
  }
  const submitted = versionList(status.submittedVersions);
  const version = submitted[0] ?? null;
  const shown = submitted.join("、") || "送审版本";
  const live = versionList(status.publishedVersions).join("、");
  const liveText = live ? `商店用户拿到的还是 ${live}` : "商店里还没有公开的版本";
  const repoUrl = repository ? `${serverUrl}/${repository}` : "";
  const headlines = [];
  const sections = [];

  if (status.takenDown) {
    headlines.push("商店条目已被下架");
    sections.push([
      "## 商店条目已被下架",
      "",
      "商店因违反政策下架了这个扩展，详情在 Chrome Web Store Developer Dashboard。处理完下架原因之前不要继续发版。",
    ].join("\n"));
  }
  if (status.warned) {
    headlines.push("商店条目收到政策警告");
    sections.push([
      "## 商店条目收到政策警告",
      "",
      "不处理会被下架，详情在 Chrome Web Store Developer Dashboard。",
    ].join("\n"));
  }
  if (status.submittedState === "STAGED") {
    const tag = version ? `v${version}` : "vX.Y.Z";
    const repoFlag = repository ? ` --repo ${repository}` : "";
    const actionsLink = repoUrl ? `[Release Extension](${repoUrl}/actions/workflows/release.yml)` : "Release Extension";
    headlines.push(`${shown} 已过审，等待上线`);
    sections.push([
      `## ${shown} 已过审，等待上线`,
      "",
      `商店里的 ${shown} 已审核通过，停在 \`STAGED\`。${liveText}；这一版上线或取消之前，下一版也传不上去。`,
      "",
      ...(status.takenDown ? ["条目已被下架：先按上面处理下架，再决定要不要上线这一版。", ""] : []),
      "确认可以上线后，二选一：",
      "",
      `- 在 tag \`${tag}\` 上运行 ${actionsLink}，勾上 \`release_staged\`。它不上传新包，只在商店状态仍是 \`STAGED\`、版本与这个 tag 的 \`manifest.json\` 一致时才公开：`,
      "",
      "  ```bash",
      `  gh workflow run release.yml${repoFlag} --ref ${tag} -f dry_run=false -f release_staged=true`,
      "  ```",
      "",
      "- 或者在 Chrome Web Store Developer Dashboard 里发布这个暂存版本。",
    ].join("\n"));
  }
  if (status.submittedState === "REJECTED") {
    headlines.push(`${shown} 被商店拒绝`);
    sections.push([
      `## ${shown} 被商店拒绝`,
      "",
      `商店没有通过 ${shown}，原因在 Chrome Web Store Developer Dashboard 和发布者邮箱里。修好后把 \`manifest.json\` 的版本号升上去，再发新的正式 GitHub Release；同一个版本不要重新上传。新版本送审后这个 issue 会自动关闭。`,
    ].join("\n"));
  }
  const state = status.submittedState;
  if (state !== null && state !== undefined && !KNOWN_STATES.has(state)) {
    headlines.push(`商店返回了未识别的状态 ${state}`);
    sections.push([
      `## 商店返回了未识别的状态 \`${state}\``,
      "",
      `送审版本 ${shown} 的状态是 \`${state}\`，这个脚本不认识，不能当成没事。到 Chrome Web Store Developer Dashboard 看一眼，必要时更新 \`desktop/scripts/chrome-web-store-watch.js\`。状态变回已知值后这个 issue 会自动关闭。`,
    ].join("\n"));
  }
  if (sections.length === 0) return null;

  const watchLink = repoUrl ? `[Chrome Web Store Watch](${repoUrl}/actions/workflows/chrome-web-store-watch.yml)` : "Chrome Web Store Watch";
  const title = `Chrome 商店：${headlines.join("；")}`;
  const text = [
    ...sections,
    "",
    "---",
    "",
    `商店状态：${describeStatus(status)}。`,
    "",
    `这个 issue 由 ${watchLink} 每天检查后自动打开、更新和关闭。情况还在时手动关掉，下次检查会重新打开一个。`,
    "补充说明请写在评论里：状态变化时正文会整段重写。正文末尾的隐藏标记不要删，脚本靠它认出这个 issue。",
  ].join("\n");
  const fingerprint = createHash("sha256").update(`${title}\n${text}`).digest("hex").slice(0, 16);
  return { title, body: `${text}\n\n${ISSUE_MARKER} v=${fingerprint} -->`, fingerprint };
}

/** 指派人写错不能让提醒开不出来：不合法的用户名只跳过，由调用方打印出来。 */
export function parseAssignees(text) {
  const logins = String(text ?? "").split(/[\s,]+/).filter((login) => login.length > 0);
  const valid = logins.filter((login) => /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/.test(login));
  return { valid, invalid: logins.filter((login) => !valid.includes(login)) };
}

function createGitHub({ apiUrl, repository, token, fetchImpl }) {
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository)) {
    throw new StoreWatchError(`GITHUB_REPOSITORY 应该是 owner/repo，现在是 ${repository || "空"}`);
  }
  if (!token) throw new StoreWatchError("同步 issue 需要 GITHUB_TOKEN");
  return async function github(method, path, body) {
    const url = `${apiUrl}/repos/${repository}${path}`;
    let response;
    try {
      response = await fetchImpl(url, {
        method,
        redirect: "error",
        headers: {
          Accept: "application/vnd.github+json",
          Authorization: `Bearer ${token}`,
          "User-Agent": "chrome-web-store-watch",
          "X-GitHub-Api-Version": GITHUB_API_VERSION,
          ...(body === undefined ? {} : { "Content-Type": "application/json" }),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
    } catch (error) {
      throw new StoreWatchError(redact(`GitHub ${method} ${path} failed: ${error instanceof Error ? error.message : error}`, [token]));
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
      const failure = new StoreWatchError(redact(`GitHub ${method} ${path} failed: HTTP ${response.status} ${detail}`, [token]));
      failure.status = response.status;
      throw failure;
    }
    return parsed;
  };
}

/**
 * 只认带固定标签、正文里有标记的 issue，别人手动打了同一标签的 issue 不会被改或关。
 * issue 被手动关掉而情况还在时，会新开一个。
 */
export async function syncReminderIssue({
  issue,
  status,
  repository,
  token,
  fetchImpl,
  apiUrl = "https://api.github.com",
  assignees = [],
}) {
  const github = createGitHub({ apiUrl, repository, token, fetchImpl });
  const listed = await github("GET", `/issues?state=open&labels=${encodeURIComponent(ISSUE_LABEL)}&per_page=100`);
  const open = (Array.isArray(listed) ? listed : [])
    .filter((item) => !item.pull_request && String(item.body ?? "").includes(ISSUE_MARKER))
    .sort((a, b) => a.number - b.number);

  if (!issue) {
    for (const item of open) {
      await github("POST", `/issues/${item.number}/comments`, {
        body: `商店已经没有需要处理的事项，自动关闭。商店状态：${describeStatus(status)}。`,
      });
      await github("PATCH", `/issues/${item.number}`, { state: "closed", state_reason: "completed" });
    }
    return { action: open.length > 0 ? "closed" : "none", numbers: open.map((item) => item.number) };
  }

  const [current, ...duplicates] = open;
  if (current) {
    // 多出来的提醒（手动重开的旧 issue 等）指向编号最小的那个后关闭，不留陈旧状态。
    for (const item of duplicates) {
      await github("POST", `/issues/${item.number}/comments`, { body: `重复的商店提醒，以 #${current.number} 为准，自动关闭。` });
      await github("PATCH", `/issues/${item.number}`, { state: "closed", state_reason: "not_planned" });
    }
    if (FINGERPRINT.exec(String(current.body ?? ""))?.[1] === issue.fingerprint) {
      return { action: "unchanged", numbers: [current.number] };
    }
    // 改正文不会通知任何人，留言才会。先留言：正文没改成，下次运行指纹仍不同，会再试一次，
    // 通知不会因为正文已经是新的而丢掉。
    await github("POST", `/issues/${current.number}/comments`, {
      body: `商店状态有变化：${issue.title.replace(/^Chrome 商店：/, "")}。上面的说明已更新。`,
    });
    await github("PATCH", `/issues/${current.number}`, { title: issue.title, body: issue.body });
    return { action: "updated", numbers: [current.number] };
  }

  try {
    await github("POST", "/labels", { name: ISSUE_LABEL, color: LABEL_COLOR, description: LABEL_DESCRIPTION });
  } catch (error) {
    // 422 是标签已经存在。
    if (!(error instanceof StoreWatchError) || error.status !== 422) throw error;
  }
  const fields = { title: issue.title, body: issue.body, labels: [ISSUE_LABEL] };
  let created;
  try {
    created = await github("POST", "/issues", assignees.length > 0 ? { ...fields, assignees } : fields);
  } catch (error) {
    // 指派人填错时 GitHub 回 422。提醒本身比指派重要，去掉指派人再开一次。
    if (assignees.length === 0 || !(error instanceof StoreWatchError) || error.status !== 422) throw error;
    created = await github("POST", "/issues", fields);
  }
  if (!Number.isInteger(created?.number)) {
    throw new StoreWatchError("GitHub 建 issue 后没有返回编号");
  }
  return { action: "opened", numbers: [created.number] };
}

function flag(argv, name) {
  const index = argv.indexOf(name);
  if (index < 0) return "";
  return argv[index + 1] ?? "";
}

export async function main(argv, env = process.env, io = {}) {
  const statusPath = flag(argv, "--status");
  if (!statusPath) {
    throw new StoreWatchError("用法：--status <chrome-web-store.js status 的输出文件> [--sync]");
  }
  const readFile = io.readFile ?? ((path) => readFileSync(path, "utf8"));
  const log = io.log ?? console.log;
  let raw;
  try {
    raw = readFile(statusPath);
  } catch (error) {
    throw new StoreWatchError(`读不了 ${statusPath}：${error instanceof Error ? error.message : error}`);
  }
  let status;
  try {
    status = JSON.parse(raw);
  } catch {
    throw new StoreWatchError(`${statusPath} 不是 chrome-web-store.js status 输出的 JSON`);
  }
  const repository = env.GITHUB_REPOSITORY ?? "";
  const issue = reminderIssue(status, { repository, serverUrl: env.GITHUB_SERVER_URL || "https://github.com" });
  log(`商店状态：${describeStatus(status)}`);
  log(issue ? `需要处理：${issue.title}` : "没有需要维护者处理的事项");
  if (!argv.includes("--sync")) return;

  const assignees = parseAssignees(env.WATCH_ASSIGNEES);
  if (assignees.invalid.length > 0) {
    log(`跳过不合法的指派人：${assignees.invalid.join(", ")}`);
  }
  const result = await syncReminderIssue({
    issue,
    status,
    repository,
    token: env.GITHUB_TOKEN ?? "",
    fetchImpl: io.fetchImpl ?? globalThis.fetch,
    apiUrl: env.GITHUB_API_URL || "https://api.github.com",
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

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { simpleGit } from "simple-git";
import type { PlatformAdapter } from "./types.js";

const GITHUB_API = "https://api.github.com";
const USER_AGENT = "code-review-agent";

export interface PullRequestRef {
  cloneUrl: string;
  baseSha: string;
  headSha: string;
}

// owner/repo：拒绝空白、空段与多余斜杠，防止拼进 URL 时被注入路径或越权。
const REPO_PATTERN = /^[^/\s]+\/[^/\s]+$/;

// reviewId 形如 owner/repo#<prNumber>：三段各自校验，避免空格/斜杠/非数字注入 URL。
const REVIEW_ID_PATTERN = /^([^/]+)\/([^#]+)#(\d+)$/;

// git 子进程只需最小环境：透传 process.env 会把 GIT_EDITOR/GIT_SSH 等传给子进程，
// 触发 simple-git 的 unsafe 拦截，也会把 DEEPSEEK_API_KEY 等密钥泄露给克隆到的敌意仓库。
// token 经 GIT_CONFIG_* 环境变量注入 http.extraHeader：git 从环境读取这些变量（而非 argv），
// 密钥不进入子进程命令行，不会出现在 ps/进程列表，也不写入 clone URL 或 .git/config。
export function gitEnv(token?: string): NodeJS.ProcessEnv {
  const whitelist = [
    "PATH", "PATHEXT", "SystemRoot", "COMSPEC",
    "TEMP", "TMP", "HOME", "USERPROFILE", "HOMEDRIVE", "HOMEPATH",
    "LANG", "LC_ALL", "LC_CTYPE", "LC_MESSAGES",
  ];
  const env: NodeJS.ProcessEnv = {};
  for (const key of whitelist) {
    const value = process.env[key];
    if (value !== undefined) env[key] = value;
  }
  env.GIT_TERMINAL_PROMPT = "0";
  if (token) {
    // GitHub 的 git 智能 HTTP 传输只认 Basic 认证（Bearer 仅对 REST API 有效），
    // 否则 clone 私有仓库时 git 会回退到交互式询问用户名，触发 terminal prompts disabled 失败。
    // x-access-token 是 GitHub Actions 内置 token 的约定用户名；token 仍只经
    // GIT_CONFIG_* 环境变量注入，不进入 argv，也不会写进 clone URL 或 .git/config。
    const basicAuth = Buffer.from(`x-access-token:${token}`).toString("base64");
    env.GIT_CONFIG_COUNT = "1";
    env.GIT_CONFIG_KEY_0 = "http.extraHeader";
    env.GIT_CONFIG_VALUE_0 = `Authorization: Basic ${basicAuth}`;
  }
  return env;
}

export async function resolvePullRequest(
  repo: string,
  prNumber: number,
  token?: string,
): Promise<PullRequestRef> {
  if (!REPO_PATTERN.test(repo)) {
    throw new Error(`非法仓库名（需 owner/repo）：${repo}`);
  }
  const [owner, name] = repo.split("/");

  const res = await fetch(`${GITHUB_API}/repos/${owner}/${name}/pulls/${prNumber}`, {
    headers: {
      Accept: "application/vnd.github+json",
      "User-Agent": USER_AGENT,
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
  });
  if (!res.ok) {
    throw new Error(`GitHub API 解析 PR 失败（${res.status}）：${await res.text()}`);
  }

  const data = (await res.json()) as {
    base?: { sha?: string; repo?: { clone_url?: string } };
    head?: { sha?: string };
  };
  const baseSha = data.base?.sha;
  const headSha = data.head?.sha;
  const cloneUrl = data.base?.repo?.clone_url;
  // 任一关键字段缺失即 fail-closed，不得携带 undefined 继续后续流程。
  if (!baseSha || !headSha || !cloneUrl) {
    throw new Error("GitHub API 返回的 PR 数据缺失 base.sha / head.sha / base.repo.clone_url");
  }
  return { cloneUrl, baseSha, headSha };
}

export async function clonePullRequest(
  cloneUrl: string,
  baseSha: string,
  headSha: string,
  token?: string,
): Promise<{ dir: string; base: string; head: string; cleanup: () => Promise<void> }> {
  const dir = await mkdtemp(join(tmpdir(), "code-review-pr-"));
  // allowEnvironment 放行 GIT_TERMINAL_PROMPT 与 GIT_CONFIG_*：token 只经环境变量注入，
  // 不进入子进程 argv，也不写进 clone URL 或 .git/config，避免凭据出现在 ps/进程列表。
  const git = simpleGit({
    baseDir: dir,
    allowEnvironment: ["GIT_TERMINAL_PROMPT", "GIT_CONFIG_COUNT", "GIT_CONFIG_KEY_0", "GIT_CONFIG_VALUE_0"],
    // GIT_CONFIG_* 是 git 官方从环境读取配置的通道（不进入 argv）；放行该计数变量，
    // 仅用于注入 http.extraHeader（http.extraHeader 不在 simple-git 的配置黑名单内）。
    unsafe: { allowUnsafeConfigEnvCount: true },
  }).env(gitEnv(token));
  try {
    await git.raw(["clone", "--no-checkout", cloneUrl, "."]);
    await git.raw(["fetch", "origin", headSha]);
    await git.raw(["fetch", "origin", baseSha]);
  } catch (error) {
    await rm(dir, { recursive: true, force: true });
    throw error;
  }
  return {
    dir,
    base: baseSha,
    head: headSha,
    cleanup: () => rm(dir, { recursive: true, force: true }),
  };
}

export class GitHubPlatformAdapter implements PlatformAdapter {
  constructor(private readonly token: string) {}

  async postReviewComment(reviewId: string, body: string): Promise<void> {
    const match = REVIEW_ID_PATTERN.exec(reviewId);
    if (!match) {
      throw new Error(`非法 reviewId（需 owner/repo#<prNumber>）：${reviewId}`);
    }
    const [, owner, repo, pr] = match;

    const res = await fetch(`${GITHUB_API}/repos/${owner}/${repo}/issues/${pr}/comments`, {
      method: "POST",
      headers: {
        Accept: "application/vnd.github+json",
        Authorization: `Bearer ${this.token}`,
        "Content-Type": "application/json",
        "User-Agent": USER_AGENT,
      },
      body: JSON.stringify({ body }),
    });
    if (!res.ok) {
      throw new Error(`GitHub 评论发布失败（${res.status}）：${await res.text()}`);
    }
  }
}

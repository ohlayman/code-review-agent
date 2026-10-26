import { readFile as readDiskFile } from "node:fs/promises";
import path from "node:path";
import { simpleGit, type SimpleGit } from "simple-git";

export interface RepoAccess {
  readFile(path: string, rev?: string): Promise<string>;
  readWorktreeFile(path: string): Promise<string>;
  grep(pattern: string, rev?: string): Promise<string>;
  grepWorktree(pattern: string): Promise<string>;
  listFiles(rev?: string): Promise<string[]>;
}

export interface RepositoryAdapter extends RepoAccess {
  getWorkingTreeDiff(): Promise<string>;
  getCommitDiff(sha: string): Promise<string>;
  getBranchDiff(branch: string, base?: string): Promise<string>;
  gitLog(): Promise<string>;
}

// git 把以 `-` 开头的参数当选项解析；被审仓库/LLM 提供的 rev/ref 未经校验会构成参数注入。
function assertSafeRef(value: string, label: string): void {
  if (value.length === 0 || value.startsWith("-")) {
    throw new Error(`非法 git 引用（${label}）：${JSON.stringify(value)}`);
  }
}

// 显式构造 git 子进程环境：剔除可能执行外部程序的守卫变量，保留 PATH/HOME 等必要变量，
// 并注入 GIT_TERMINAL_PROMPT=0，确保 git 永不弹出交互式提示。
function buildGitEnv(): NodeJS.ProcessEnv {
  const guarded = new Set(["editor", "pager", "visual", "prefix", "ssh_askpass"]);
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(process.env)) {
    const lower = key.toLowerCase();
    if (lower.startsWith("git_") || guarded.has(lower)) continue;
    env[key] = value;
  }
  env.GIT_TERMINAL_PROMPT = "0";
  return env;
}

// 工作区读取必须严格限定在仓库根目录内：先拒绝绝对路径与 `..`，再 resolve 后做前缀校验，
// 防止被审内容诱导工具读取仓库外的文件。
function resolveWorktreePath(root: string, relativePath: string): string {
  if (
    relativePath.length === 0 ||
    path.isAbsolute(relativePath) ||
    relativePath.split(/[\\/]/).includes("..")
  ) {
    throw new Error(`非法路径（必须为仓库内相对路径）：${JSON.stringify(relativePath)}`);
  }
  const resolved = path.resolve(root, relativePath);
  const rootPrefix = root.endsWith(path.sep) ? root : root + path.sep;
  if (!resolved.startsWith(rootPrefix)) {
    throw new Error(`非法路径（越界仓库根目录）：${JSON.stringify(relativePath)}`);
  }
  return resolved;
}

export class GitRepositoryAdapter implements RepositoryAdapter {
  private readonly git: SimpleGit;
  private readonly repoPath: string;

  constructor(repoPath: string) {
    this.repoPath = path.resolve(repoPath);
    this.git = simpleGit({
      baseDir: this.repoPath,
      allowEnvironment: ["GIT_TERMINAL_PROMPT"],
      // 允许在 raw 中固定关闭 fsmonitor/pager；取值由本文件硬编码，不来自被审仓库。
      unsafe: { allowUnsafeFsMonitor: true, allowUnsafePager: true },
    }).env(buildGitEnv());
  }

  // 被审仓库的 .git/config 可将 fsmonitor/pager 指向外部程序；-c 必须位于子命令之前，
  // 故统一经此包装，所有 raw 调用都带上固定值。
  private raw(args: string[]): Promise<string> {
    return this.git.raw(["-c", "core.fsmonitor=false", "-c", "core.pager=cat", ...args]);
  }

  private async grepArgs(args: string[]): Promise<string> {
    try {
      return await this.raw(["grep", "-n", ...args]);
    } catch (error) {
      // git grep 无匹配时退出码为 1，部分 simple-git 版本会以空消息 reject。
      if (error instanceof Error && error.message.trim() === "") return "";
      throw error;
    }
  }

  async readFile(path: string, rev = "HEAD"): Promise<string> {
    assertSafeRef(rev, "rev");
    return this.raw(["show", "--no-ext-diff", "--no-textconv", `${rev}:${path}`]);
  }

  async readWorktreeFile(relativePath: string): Promise<string> {
    return readDiskFile(resolveWorktreePath(this.repoPath, relativePath), "utf8");
  }

  async grep(pattern: string, rev = "HEAD"): Promise<string> {
    assertSafeRef(rev, "rev");
    return this.grepArgs(["-e", pattern, rev, "--"]);
  }

  async grepWorktree(pattern: string): Promise<string> {
    return this.grepArgs(["-e", pattern, "--"]);
  }

  async listFiles(rev?: string): Promise<string[]> {
    if (rev) assertSafeRef(rev, "rev");
    const out = rev
      ? await this.raw(["ls-tree", "-r", "--name-only", rev])
      : await this.raw(["ls-files"]);
    return out.split("\n").filter((line) => line.length > 0);
  }

  async getWorkingTreeDiff(): Promise<string> {
    return this.raw(["diff", "--no-ext-diff", "--no-textconv", "HEAD"]);
  }

  async getCommitDiff(sha: string): Promise<string> {
    assertSafeRef(sha, "sha");
    return this.raw(["show", "--no-ext-diff", "--no-textconv", "--format=", sha]);
  }

  async getBranchDiff(branch: string, base = "main"): Promise<string> {
    assertSafeRef(base, "base");
    assertSafeRef(branch, "branch");
    const mergeBase = (await this.raw(["merge-base", base, branch])).trim();
    return this.raw(["diff", "--no-ext-diff", "--no-textconv", `${mergeBase}..${branch}`]);
  }

  async gitLog(): Promise<string> {
    return this.raw(["log", "--oneline"]);
  }
}

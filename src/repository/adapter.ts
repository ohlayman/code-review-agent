import { readFile as readDiskFile, realpath, stat } from "node:fs/promises";
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

// 拆分路径段并丢弃空段与 `.`，避免 `./.git/config` 之类前缀绕过首段检查。
function pathSegments(value: string): string[] {
  return value.split(/[\\/]/).filter((segment) => segment.length > 0 && segment !== ".");
}

// 仓库自带的 .env / .git 属于敏感内容，不得回传给模型。
function assertNotSensitivePath(segments: string[], displayPath: string): void {
  if (segments.length === 0) return;
  const base = segments[segments.length - 1].toLowerCase();
  if (segments[0].toLowerCase() === ".git" || base === ".env" || base.startsWith(".env.")) {
    throw new Error(`拒绝读取敏感路径：${JSON.stringify(displayPath)}`);
  }
}

// 工作区读取必须严格限定在仓库顶层目录内：先做词法校验与敏感路径拒绝，
// 再用 realpath 解析真实路径后做前缀校验，并按真实路径复查敏感目标，
// 防止符号链接把读取引向仓库外或仓库内的 .git/.env。
async function resolveWorktreePath(realRoot: string, relativePath: string): Promise<string> {
  const requestedSegments = pathSegments(relativePath);
  if (
    relativePath.length === 0 ||
    path.isAbsolute(relativePath) ||
    requestedSegments.includes("..")
  ) {
    throw new Error(`非法路径（必须为仓库内相对路径）：${JSON.stringify(relativePath)}`);
  }
  assertNotSensitivePath(requestedSegments, relativePath);

  const realCandidate = await realpath(path.resolve(realRoot, relativePath));
  const rootPrefix = realRoot.endsWith(path.sep) ? realRoot : realRoot + path.sep;
  if (!realCandidate.startsWith(rootPrefix)) {
    throw new Error(`非法路径（越界仓库根目录）：${JSON.stringify(relativePath)}`);
  }
  // 链接可能把普通文件名指向 .git/config 或 .env；必须按真实路径再拒绝一次。
  assertNotSensitivePath(pathSegments(path.relative(realRoot, realCandidate)), relativePath);
  return realCandidate;
}

export class GitRepositoryAdapter implements RepositoryAdapter {
  private readonly git: SimpleGit;
  private readonly repoPath: string;
  private worktreeRootPromise?: Promise<string>;

  constructor(repoPath: string) {
    this.repoPath = path.resolve(repoPath);
    this.git = simpleGit({
      baseDir: this.repoPath,
      allowEnvironment: ["GIT_TERMINAL_PROMPT"],
      // 允许在 raw 中固定关闭 fsmonitor/pager 并用 -C 锚定文件系统派生的仓库顶层；
      // 取值均来自本文件或可信 repoPath，不来自被审仓库内容。
      unsafe: {
        allowUnsafeFsMonitor: true,
        allowUnsafePager: true,
        allowUnsafeConfigPaths: true,
      },
    }).env(buildGitEnv());
  }

  // 被审仓库的 .git/config 可将 fsmonitor/pager 指向外部程序；-c 必须位于子命令之前，
  // 故统一经此包装，所有 raw 调用都带上固定值。
  private raw(args: string[]): Promise<string> {
    return this.git.raw(["-c", "core.fsmonitor=false", "-c", "core.pager=cat", ...args]);
  }

  // 从可信的 repoPath 向上查找 .git 标记（目录或文件）确定顶层。
  // 不能使用 `git rev-parse --show-toplevel`：它读取仓库可控的 core.worktree，
  // 恶意仓库可借此把限制根指向任意目录。
  private worktreeRoot(): Promise<string> {
    this.worktreeRootPromise ??= this.findWorktreeRoot();
    return this.worktreeRootPromise;
  }

  private async findWorktreeRoot(): Promise<string> {
    let current = await realpath(this.repoPath);
    for (;;) {
      try {
        await stat(path.join(current, ".git"));
        return current;
      } catch {
        const parent = path.dirname(current);
        if (parent === current) {
          throw new Error("无法确定仓库顶层（未找到 .git 标记）");
        }
        current = parent;
      }
    }
  }

  // worktree 语义的 git 命令统一以顶层为工作目录，保证路径与 diff 输出一致。
  private async worktreeRaw(args: string[]): Promise<string> {
    const topLevel = await this.worktreeRoot();
    return this.raw(["-C", topLevel, ...args]);
  }

  private async grepArgs(args: string[], worktree = false): Promise<string> {
    try {
      const grepArgs = ["grep", "-n", ...args];
      return worktree ? await this.worktreeRaw(grepArgs) : await this.raw(grepArgs);
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
    const realRoot = await this.worktreeRoot();
    return readDiskFile(await resolveWorktreePath(realRoot, relativePath), "utf8");
  }

  async grep(pattern: string, rev = "HEAD"): Promise<string> {
    assertSafeRef(rev, "rev");
    return this.grepArgs(["-e", pattern, rev, "--"]);
  }

  async grepWorktree(pattern: string): Promise<string> {
    return this.grepArgs(["-e", pattern, "--"], true);
  }

  async listFiles(rev?: string): Promise<string[]> {
    if (rev) assertSafeRef(rev, "rev");
    const out = rev
      ? await this.raw(["ls-tree", "-r", "--name-only", rev])
      : await this.worktreeRaw(["ls-files"]);
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

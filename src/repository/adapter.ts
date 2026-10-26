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

// 只接受安全 token；含 `=`/空白/引号/控制字符会被 -c 的「首 = 分割」解析成别的 key，
// 令中和失效。任何不安全名字必须抛错 fail-closed，绝不带着未中和的过滤器继续 diff。
const SAFE_FILTER_DRIVER = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

// 表示仓库无工作区顶层（bare 仓库，或沿祖先未找到 .git 标记）。
// revRaw 据此回退为「不加 -C、从 repoPath 直接读对象库」；worktree 命令必须失败关闭。
class MissingWorktreeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MissingWorktreeError";
  }
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
  private filterDriversPromise?: Promise<string[]>;

  constructor(repoPath: string) {
    this.repoPath = path.resolve(repoPath);
    this.git = simpleGit({
      baseDir: this.repoPath,
      allowEnvironment: ["GIT_TERMINAL_PROMPT"],
      // 允许在 raw 中固定关闭 fsmonitor/pager、用 -C 锚定文件系统派生的仓库顶层，
      // 并把被审仓库定义的 filter 驱动覆盖为恒等 cat（allowUnsafeFilter）。
      // 取值均来自本文件或可信 repoPath，只有驱动名来自仓库配置，且仅用于拼接 `cat`/空值。
      unsafe: {
        allowUnsafeFsMonitor: true,
        allowUnsafePager: true,
        allowUnsafeConfigPaths: true,
        allowUnsafeFilter: true,
      },
    }).env(buildGitEnv());
  }

  // 被审仓库的 .git/config 可将 fsmonitor/pager 指向外部程序，也可用 core.worktree
  // 把 diff/grep 重定向到仓库外。fsmonitor/pager 统一在此关闭；core.worktree 的重定向
  // 只在读工作区的命令（worktreeRaw / getWorkingTreeDiff）上用 --work-tree 覆盖——
  // rev 类命令读对象库、不接触工作区，无需也不应强制工作区根（否则 bare 仓库的
  // commit/branch 审查会因找不到 .git 标记而失败关闭）。
  // 路径作为独立 argv 元素传递（不经 shell），含空格也安全。
  private async raw(args: string[]): Promise<string> {
    return this.git.raw([
      "-c",
      "core.fsmonitor=false",
      "-c",
      "core.pager=cat",
      ...args,
    ]);
  }

  // 从可信的 repoPath 向上查找 .git 标记（目录或文件）确定顶层。
  // 不能使用 `git rev-parse --show-toplevel`：它读取仓库可控的 core.worktree，
  // 恶意仓库可借此把限制根指向任意目录。
  private worktreeRoot(): Promise<string> {
    this.worktreeRootPromise ??= this.findWorktreeRoot();
    return this.worktreeRootPromise;
  }

  private async findWorktreeRoot(): Promise<string> {
    const realRoot = await realpath(this.repoPath);
    // repoPath 本身若是 bare 仓库则无工作区顶层。用 git 自身判定，而非可伪造的
    // 「HEAD 文件 + objects 目录」启发式：普通提交的 sub/HEAD + sub/objects 会让
    // 子目录启动被误判为 bare，进而 revRaw 无锚回退、静默漏报顶层文件。
    if (await this.isBareRepository(realRoot)) {
      throw new MissingWorktreeError("无工作区顶层（bare 仓库）");
    }
    let current = realRoot;
    for (;;) {
      try {
        await stat(path.join(current, ".git"));
        return current;
      } catch (error) {
        // 只有「此处没有 .git」才继续向上；EACCES/ELOOP 等错误必须失败关闭，
        // 否则可能静默放宽到祖先仓库，扩大可信根。
        const code = (error as NodeJS.ErrnoException).code;
        if (code !== "ENOENT" && code !== "ENOTDIR") throw error;
      }
      const parent = path.dirname(current);
      if (parent === current) {
        throw new MissingWorktreeError("无法确定仓库顶层（未找到 .git 标记）");
      }
      current = parent;
    }
  }

  // 用 git 判定 bare（`git --git-dir=<dir> rev-parse --is-bare-repository`）：
  // rev-parse 不执行外部命令/过滤器，安全；伪造目录（仅有 HEAD+objects 文件、
  // 无有效 gitdir 结构）会报「not a git repository」而非 true，判为非 bare 继续上溯。
  // 仅「非 git 仓库」视为非 bare；EACCES 等真实错误必须 fail-closed。
  private async isBareRepository(dir: string): Promise<boolean> {
    try {
      const out = await this.raw([`--git-dir=${dir}`, "rev-parse", "--is-bare-repository"]);
      return out.trim() === "true";
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (/not a git repository|not a git directory|does not appear to be a git/i.test(message)) {
        return false;
      }
      throw error;
    }
  }

  // 敌对 .git/config 可定义 filter.<driver>.clean/smudge/process（由 .gitattributes 声明启用），
  // diff 比较工作区文件时会执行 clean 过滤器，从而在审查阶段运行任意命令；
  // --no-ext-diff/--no-textconv 都拦不住。这里枚举已配置的驱动名，供 getWorkingTreeDiff 中和。
  // 用 -z 按 NUL 分隔记录、按首个换行切 key，避免含空格/`=` 的驱动名被空白切分误读。
  // 不安全的驱动名无法安全中和（会被 -c 的「首 = 分割」拆错 key），必须 fail-closed。
  private filterDrivers(): Promise<string[]> {
    this.filterDriversPromise ??= this.raw(["config", "-z", "--get-regexp", "^filter\\."])
      .then((out) => {
        const drivers = new Set<string>();
        for (const record of out.split("\0")) {
          if (record.length === 0) continue;
          const nl = record.indexOf("\n");
          const key = nl >= 0 ? record.slice(0, nl) : record;
          const match = /^filter\.(.*)\.(clean|smudge|process)$/.exec(key);
          if (match) drivers.add(match[1]);
        }
        const names = [...drivers];
        for (const name of names) {
          if (!SAFE_FILTER_DRIVER.test(name)) {
            throw new Error(`拒绝不安全的 filter 驱动名：${JSON.stringify(name)}`);
          }
        }
        return names;
      })
      .catch((error) => {
        // 仅「无匹配」视为无过滤器；真实枚举失败必须 fail-closed，不能带着未中和的过滤器继续。
        if (error instanceof Error && error.message.trim() === "") return [];
        throw error;
      });
    return this.filterDriversPromise;
  }

  // 命令行级 -c 优先级最高，可覆盖 .git/config：clean/smudge 用恒等的 cat，
  // process 置空以禁用长驻过滤器。审查本就应看到原始内容，不应跑 LFS 等过滤器。
  private filterNeutralArgs(drivers: string[]): string[] {
    const args: string[] = [];
    for (const name of drivers) {
      args.push(
        "-c",
        `filter.${name}.clean=cat`,
        "-c",
        `filter.${name}.smudge=cat`,
        "-c",
        `filter.${name}.process=`,
      );
    }
    return args;
  }

  // worktree 语义的 git 命令统一以顶层为工作目录，保证路径与 diff 输出一致；
  // 同时用 --work-tree 钉住可信顶层，避免 core.worktree 把工作区重定向到仓库外。
  private async worktreeRaw(args: string[]): Promise<string> {
    const topLevel = await this.worktreeRoot();
    return this.raw(["-C", topLevel, `--work-tree=${topLevel}`, ...args]);
  }

  // rev 模式命令（grep/ls-tree）默认相对 cwd：从子目录启动时只覆盖子目录，且输出路径
  // 也相对 cwd，会静默漏报顶层文件。用 -C 锚定到文件系统派生的顶层；不加 --work-tree，
  // 保持 bare 仓库可用。仅「确无工作区顶层」才回退为不加 -C；命令自身失败不回退重试，
  // EACCES/ELOOP 等真实 IO 错误必须 fail-closed。
  private async revRaw(args: string[]): Promise<string> {
    let top: string;
    try {
      top = await this.worktreeRoot();
    } catch (error) {
      if (error instanceof MissingWorktreeError) return this.raw(args);
      throw error;
    }
    return this.raw(["-C", top, ...args]);
  }

  private async grepArgs(args: string[], worktree = false): Promise<string> {
    try {
      const grepArgs = ["grep", "-n", ...args];
      return worktree ? await this.worktreeRaw(grepArgs) : await this.revRaw(grepArgs);
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
      ? await this.revRaw(["ls-tree", "-r", "--name-only", rev])
      : await this.worktreeRaw(["ls-files"]);
    return out.split("\n").filter((line) => line.length > 0);
  }

  // 必须先中和 filter 驱动：diff 会比较工作区侧文件，触发 .gitattributes 声明的
  // clean/process 命令（定义在被审仓库的 .git/config 中），--no-ext-diff/--no-textconv
  // 不阻断这类过滤器，敌对仓库可借此在审查时执行任意命令。
  async getWorkingTreeDiff(): Promise<string> {
    const topLevel = await this.worktreeRoot();
    const drivers = await this.filterDrivers();
    return this.raw([
      ...this.filterNeutralArgs(drivers),
      `--work-tree=${topLevel}`,
      "diff",
      "--no-ext-diff",
      "--no-textconv",
      "HEAD",
    ]);
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

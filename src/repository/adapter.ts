import { simpleGit, type SimpleGit } from "simple-git";

export interface RepoAccess {
  readFile(path: string, rev?: string): Promise<string>;
  grep(pattern: string, rev?: string): Promise<string>;
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

export class GitRepositoryAdapter implements RepositoryAdapter {
  private readonly git: SimpleGit;

  constructor(repoPath: string) {
    this.git = simpleGit(repoPath);
  }

  async readFile(path: string, rev = "HEAD"): Promise<string> {
    assertSafeRef(rev, "rev");
    return this.git.raw(["show", `${rev}:${path}`]);
  }

  async grep(pattern: string, rev = "HEAD"): Promise<string> {
    try {
      assertSafeRef(rev, "rev");
      return await this.git.raw(["grep", "-n", "-e", pattern, rev, "--"]);
    } catch (error) {
      // git grep 无匹配时退出码为 1，部分 simple-git 版本会以空消息 reject。
      if (error instanceof Error && error.message.trim() === "") return "";
      throw error;
    }
  }

  async listFiles(rev?: string): Promise<string[]> {
    if (rev) assertSafeRef(rev, "rev");
    const out = rev
      ? await this.git.raw(["ls-tree", "-r", "--name-only", rev])
      : await this.git.raw(["ls-files"]);
    return out.split("\n").filter((line) => line.length > 0);
  }

  async getWorkingTreeDiff(): Promise<string> {
    return this.git.diff(["HEAD"]);
  }

  async getCommitDiff(sha: string): Promise<string> {
    assertSafeRef(sha, "sha");
    return this.git.raw(["show", "--format=", sha]);
  }

  async getBranchDiff(branch: string, base = "main"): Promise<string> {
    assertSafeRef(base, "base");
    assertSafeRef(branch, "branch");
    const mergeBase = (await this.git.raw(["merge-base", base, branch])).trim();
    return this.git.diff([`${mergeBase}..${branch}`]);
  }

  async gitLog(): Promise<string> {
    return this.git.raw(["log", "--oneline"]);
  }
}

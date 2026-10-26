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

export class GitRepositoryAdapter implements RepositoryAdapter {
  private readonly git: SimpleGit;

  constructor(repoPath: string) {
    this.git = simpleGit(repoPath);
  }

  async readFile(path: string, rev = "HEAD"): Promise<string> {
    return this.git.raw(["show", `${rev}:${path}`]);
  }

  async grep(pattern: string, rev = "HEAD"): Promise<string> {
    return this.git.raw(["grep", "-n", pattern, rev, "--"]);
  }

  async listFiles(rev?: string): Promise<string[]> {
    const out = rev
      ? await this.git.raw(["ls-tree", "-r", "--name-only", rev])
      : await this.git.raw(["ls-files"]);
    return out.split("\n").filter((line) => line.length > 0);
  }

  async getWorkingTreeDiff(): Promise<string> {
    return this.git.diff(["HEAD"]);
  }

  async getCommitDiff(sha: string): Promise<string> {
    return this.git.raw(["show", "--format=", sha]);
  }

  async getBranchDiff(branch: string, base = "main"): Promise<string> {
    const mergeBase = (await this.git.raw(["merge-base", base, branch])).trim();
    return this.git.diff([`${mergeBase}..${branch}`]);
  }

  async gitLog(): Promise<string> {
    return this.git.raw(["log", "--oneline"]);
  }
}

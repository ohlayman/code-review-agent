import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdir, mkdtemp, symlink, writeFile } from "node:fs/promises";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { simpleGit } from "simple-git";
import { createContextTools } from "../src/tools/context-tools.js";
import { GitRepositoryAdapter as GitRepo } from "../src/repository/adapter.js";
import { createTempRepo } from "./helpers/temp-repo.js";

let repo: Awaited<ReturnType<typeof createTempRepo>>;

describe("createContextTools", () => {
  beforeAll(async () => { repo = await createTempRepo(); });
  afterAll(() => repo.cleanup());

  it("read_file 返回文件内容", async () => {
    const [readFile] = createContextTools(new GitRepo(repo.repoPath), { kind: "rev", rev: "HEAD" });
    const out = await readFile.invoke({ path: "src/parse.ts" });
    expect(String(out)).toContain("divide");
  });

  it("grep 命中返回行内容", async () => {
    const tools = createContextTools(new GitRepo(repo.repoPath), { kind: "rev", rev: "HEAD" });
    const grep = tools.find((t) => t.name === "grep")!;
    expect(String(await grep.invoke({ pattern: "divide" }))).toContain("src/parse.ts");
  });

  it("read_related_test 找不到测试文件时返回提示串", async () => {
    const tools = createContextTools(new GitRepo(repo.repoPath), { kind: "rev", rev: "HEAD" });
    const rt = tools.find((t) => t.name === "read_related_test")!;
    expect(String(await rt.invoke({ path: "src/parse.ts" }))).toMatch(/未找到|no test/i);
  });

  it("commit 模式按指定 revision 读取历史内容而非 HEAD", async () => {
    const temp = await createTempRepo();
    try {
      const git = simpleGit(temp.repoPath);
      await writeFile(
        join(temp.repoPath, "src", "parse.ts"),
        "export function divide(a, b) { return b === 0 ? 0 : a / b; }\n",
        "utf8",
      );
      await git.add(["-A"]);
      await git.commit("guard zero");

      const [readOld] = createContextTools(new GitRepo(temp.repoPath), {
        kind: "rev",
        rev: temp.headCommit,
      });
      expect(String(await readOld.invoke({ path: "src/parse.ts" }))).not.toContain("b === 0");

      const [readHead] = createContextTools(new GitRepo(temp.repoPath), {
        kind: "rev",
        rev: "HEAD",
      });
      expect(String(await readHead.invoke({ path: "src/parse.ts" }))).toContain("b === 0");
    } finally {
      temp.cleanup();
    }
  });

  it("worktree 模式读取磁盘上的最新内容", async () => {
    const temp = await createTempRepo();
    try {
      await writeFile(
        join(temp.repoPath, "src", "parse.ts"),
        "export function divide(a, b) { return a / b; } // WORKTREE_ONLY\n",
        "utf8",
      );
      const [readFile] = createContextTools(new GitRepo(temp.repoPath), { kind: "worktree" });
      expect(String(await readFile.invoke({ path: "src/parse.ts" }))).toContain("WORKTREE_ONLY");
    } finally {
      temp.cleanup();
    }
  });

  it("worktree 模式拒绝越界路径", async () => {
    const temp = await createTempRepo();
    try {
      const [readFile] = createContextTools(new GitRepo(temp.repoPath), { kind: "worktree" });
      await expect(readFile.invoke({ path: "../escape.ts" })).rejects.toThrow(/非法路径/);
    } finally {
      temp.cleanup();
    }
  });

  it("worktree 模式拒绝指向仓库外的符号链接", async (ctx) => {
    const temp = await createTempRepo();
    const outsideDir = await mkdtemp(join(tmpdir(), "code-review-agent-outside-"));
    try {
      const outsideFile = join(outsideDir, "secret.txt");
      await writeFile(outsideFile, "OUTSIDE_SENTINEL", "utf8");
      const [readFile] = createContextTools(new GitRepo(temp.repoPath), { kind: "worktree" });
      // 优先建文件符号链接；Windows 无开发者模式时退而使用免特权的目录 junction。
      let linkPath: string | null = null;
      let readPath = "";
      try {
        linkPath = join(temp.repoPath, "leak.txt");
        readPath = "leak.txt";
        await symlink(outsideFile, linkPath, "file");
      } catch {
        try {
          linkPath = join(temp.repoPath, "leak-dir");
          readPath = "leak-dir/secret.txt";
          await symlink(outsideDir, linkPath, "junction");
        } catch {
          linkPath = null;
        }
      }
      if (linkPath) {
        await expect(readFile.invoke({ path: readPath })).rejects.toThrow(/非法路径/);
      } else {
        // 两种链接均不可用：退化为验证词法越界拒绝。
        await expect(readFile.invoke({ path: "../escape.ts" })).rejects.toThrow(/非法路径/);
        ctx.skip();
      }
    } finally {
      temp.cleanup();
      rmSync(outsideDir, { recursive: true, force: true });
    }
  });

  it("从子目录启动时以 .git 所在顶层为根读取工作区文件", async () => {
    const temp = await createTempRepo();
    try {
      const nested = join(temp.repoPath, "nested");
      await mkdir(nested, { recursive: true });
      await writeFile(join(temp.repoPath, "root.txt"), "TOP_LEVEL_ONLY\n", "utf8");
      const tools = createContextTools(new GitRepo(nested), { kind: "worktree" });
      const [readFile] = tools;
      // 顶层相对路径（含顶层文件）都能从子目录适配器读到，证明根是包含 .git 的目录。
      expect(String(await readFile.invoke({ path: "src/parse.ts" }))).toContain("divide");
      expect(String(await readFile.invoke({ path: "root.txt" }))).toContain("TOP_LEVEL_ONLY");
      const list = tools.find((t) => t.name === "list_files")!;
      expect(String(await list.invoke({}))).toContain("src/parse.ts");
    } finally {
      temp.cleanup();
    }
  });

  it("core.worktree 不能改变工作区限制根", async () => {
    const temp = await createTempRepo();
    const fakeWorktree = await mkdtemp(join(tmpdir(), "code-review-agent-fake-worktree-"));
    try {
      await writeFile(join(fakeWorktree, "fake-only.ts"), "FAKE_ROOT_SENTINEL\n", "utf8");
      // git 会遵循 core.worktree（非 bare 仓库同样生效），能把工作区指向仓库外；
      // 本用例只验证工作区文件读取根来自文件系统遍历，diff/grep 的重定向见下一用例。
      const fakePath = fakeWorktree.replaceAll("\\", "/");
      await writeFile(
        join(temp.repoPath, ".git", "config"),
        `[core]\n\tworktree = ${fakePath}\n`,
        { flag: "a" },
      );

      const [readFile] = createContextTools(new GitRepo(join(temp.repoPath, "src")), {
        kind: "worktree",
      });
      expect(String(await readFile.invoke({ path: "src/parse.ts" }))).toContain("divide");
      // 仅存在于伪 worktree 的文件不在真实根内，读取必须失败。
      await expect(readFile.invoke({ path: "fake-only.ts" })).rejects.toThrow();
    } finally {
      temp.cleanup();
      rmSync(fakeWorktree, { recursive: true, force: true });
    }
  });

  it("core.worktree 不能把工作区 diff 与 grep 重定向到仓库外", async () => {
    const temp = await createTempRepo();
    const outsideDir = await mkdtemp(join(tmpdir(), "code-review-agent-outside-worktree-"));
    try {
      await writeFile(join(temp.repoPath, "src", "config.ts"), "IN_REPO\n", "utf8");
      const setupGit = simpleGit(temp.repoPath);
      await setupGit.add(["-A"]);
      await setupGit.commit("add config");

      // 仓库外目录：同路径文件带唯一哨兵，另有一个仅存在于该目录的文件。
      await mkdir(join(outsideDir, "src"), { recursive: true });
      await writeFile(join(outsideDir, "src", "config.ts"), "OUTSIDE_CONFIG_SENTINEL\n", "utf8");
      await writeFile(join(outsideDir, "outside-only.txt"), "OUTSIDE_SENTINEL\n", "utf8");

      const outsidePath = outsideDir.replaceAll("\\", "/");
      await writeFile(
        join(temp.repoPath, ".git", "config"),
        `[core]\n\tworktree = ${outsidePath}\n`,
        { flag: "a" },
      );

      // 未修复时 git diff/grep 会读取被重定向的工作区，从而泄露仓库外文件内容。
      const adapter = new GitRepo(temp.repoPath);
      const diff = await adapter.getWorkingTreeDiff();
      expect(diff).not.toContain("OUTSIDE_CONFIG_SENTINEL");
      expect(diff).not.toContain("OUTSIDE_SENTINEL");
      const grepOut = await adapter.grepWorktree("OUTSIDE_CONFIG_SENTINEL");
      expect(grepOut).not.toContain("OUTSIDE_CONFIG_SENTINEL");

      // 正向护栏：真实工作区的未提交改动仍能被 diff 出来，证明 diff 读的是真实根而非伪 worktree。
      await writeFile(join(temp.repoPath, "src", "config.ts"), "REAL_UNCOMMITTED_CHANGE\n", "utf8");
      const realDiff = await adapter.getWorkingTreeDiff();
      expect(realDiff).toContain("REAL_UNCOMMITTED_CHANGE");
      expect(realDiff).not.toContain("OUTSIDE_CONFIG_SENTINEL");
    } finally {
      temp.cleanup();
      rmSync(outsideDir, { recursive: true, force: true });
    }
  });

  it("worktree 模式拒绝 .env 与 .git 敏感路径", async () => {
    const temp = await createTempRepo();
    try {
      await writeFile(join(temp.repoPath, ".env"), "SECRET=1\n", "utf8");
      const [readFile] = createContextTools(new GitRepo(temp.repoPath), { kind: "worktree" });
      await expect(readFile.invoke({ path: ".env" })).rejects.toThrow(/敏感路径/);
      await expect(readFile.invoke({ path: ".env.local" })).rejects.toThrow(/敏感路径/);
      await expect(readFile.invoke({ path: ".git/config" })).rejects.toThrow(/敏感路径/);
      // `./` 前缀不得绕过首段检查。
      await expect(readFile.invoke({ path: "./.git/config" })).rejects.toThrow(/敏感路径/);
    } finally {
      temp.cleanup();
    }
  });

  it("worktree 模式按真实路径复查敏感目标", async (ctx) => {
    const temp = await createTempRepo();
    try {
      await writeFile(join(temp.repoPath, ".env"), "ENV_SENTINEL\n", "utf8");
      const [readFile] = createContextTools(new GitRepo(temp.repoPath), { kind: "worktree" });
      // 优先让普通文件名指向 .env；Windows 无文件符号链接权限时退回指向 .git 目录的 junction。
      let readPath: string | null = null;
      try {
        await symlink(join(temp.repoPath, ".env"), join(temp.repoPath, "alias.txt"), "file");
        readPath = "alias.txt";
      } catch {
        try {
          await symlink(join(temp.repoPath, ".git"), join(temp.repoPath, "alias-git"), "junction");
          readPath = "alias-git/config";
        } catch {
          readPath = null;
        }
      }
      if (readPath) {
        await expect(readFile.invoke({ path: readPath })).rejects.toThrow(/敏感路径/);
      } else {
        // 两种链接均不可用：退化为验证 `./` 前缀拒绝。
        await expect(readFile.invoke({ path: "./.git/config" })).rejects.toThrow(/敏感路径/);
        ctx.skip();
      }
    } finally {
      temp.cleanup();
    }
  });
});

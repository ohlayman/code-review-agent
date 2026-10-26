import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { writeFile } from "node:fs/promises";
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
    const [readFile] = createContextTools(new GitRepo(repo.repoPath));
    const out = await readFile.invoke({ path: "src/parse.ts" });
    expect(String(out)).toContain("divide");
  });

  it("grep 命中返回行内容", async () => {
    const tools = createContextTools(new GitRepo(repo.repoPath));
    const grep = tools.find((t) => t.name === "grep")!;
    expect(String(await grep.invoke({ pattern: "divide" }))).toContain("src/parse.ts");
  });

  it("read_related_test 找不到测试文件时返回提示串", async () => {
    const tools = createContextTools(new GitRepo(repo.repoPath));
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
});

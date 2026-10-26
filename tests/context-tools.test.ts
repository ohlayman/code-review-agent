import { describe, it, expect, beforeAll, afterAll } from "vitest";
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
});

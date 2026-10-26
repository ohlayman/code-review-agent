import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { GitRepositoryAdapter } from "../src/repository/adapter.js";
import { createReviewModel } from "../src/llm/adapter.js";
import { createTempRepo } from "./helpers/temp-repo.js";

let repo: { repoPath: string; headCommit: string; cleanup: () => void };

describe("GitRepositoryAdapter", () => {
  beforeAll(async () => { repo = await createTempRepo(); });
  afterAll(() => repo.cleanup());

  it("getCommitDiff 返回首个提交的 diff 且含 src/parse.ts", async () => {
    const a = new GitRepositoryAdapter(repo.repoPath);
    const diff = await a.getCommitDiff(repo.headCommit);
    expect(diff).toContain("src/parse.ts");
  });

  it("readFile 能按 rev 读历史文件，grep 能命中", async () => {
    const a = new GitRepositoryAdapter(repo.repoPath);
    const text = await a.readFile("src/parse.ts");
    expect(text).toContain("divide");
    expect(await a.grep("divide")).toContain("src/parse.ts");
    expect(await a.listFiles()).toContain("src/parse.ts");
    expect(await a.grep("zzz_not_found_identifier")).toBe("");
  });

  it("拒绝以 - 开头的 rev（防参数注入）", async () => {
    const a = new GitRepositoryAdapter(repo.repoPath);
    await expect(a.readFile("x.ts", "--evil")).rejects.toThrow();
  });
});

describe("createReviewModel", () => {
  it("映射 config 到 ChatOpenAI（模型名与温度）", () => {
    const m = createReviewModel({
      apiKey: "k",
      model: "deepseek-chat",
      baseURL: "https://api.deepseek.com",
      maxToolSteps: 8,
      maxFilesPerBatch: 20,
    });
    expect((m as any).model).toBe("deepseek-chat");
    expect(m.temperature).toBe(0);
  });
});

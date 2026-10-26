import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { simpleGit } from "simple-git";
import { buildReviewGraph, prefixBatchIds } from "../src/core/graph.js";
import { GitRepositoryAdapter } from "../src/repository/adapter.js";
import { createContextTools } from "../src/tools/context-tools.js";
import { makeFakeModel } from "./helpers/fake-model.js";
import { createTempRepo } from "./helpers/temp-repo.js";
import type { Candidate, VerificationResult } from "../src/llm/schemas.js";

const candidate: Candidate = { id: "c1", title: "除零未检查", severity: "P2", file: "src/parse.ts", line: 2, category: "correctness", description: "…", trigger: "…", impact: "…", suggestion: "…" };
const verification: VerificationResult = { id: "c1", verdict: "confirmed", severity: "P2", confidence: "high", evidence: "diff 显示 / b", reason: "…" };

let repo: Awaited<ReturnType<typeof createTempRepo>>;

describe("buildReviewGraph", () => {
  beforeAll(async () => { repo = await createTempRepo(); });
  afterAll(() => repo.cleanup());

  it("空变更产出未发现问题的报告", async () => {
    const model = makeFakeModel({ findings: [] }, []);
    const graph = buildReviewGraph({ model: model as any, toolsFactory: createContextTools, repoFactory: (p) => new GitRepositoryAdapter(p), maxToolSteps: 2, maxFilesPerBatch: 20 });
    // repo 无未提交变更 → changeSet.files 为空
    const out = await graph.invoke({ repoPath: repo.repoPath, range: "diff", ref: null, base: null });
    expect(out.report).toContain("未发现明确问题");
  });

  it("全部变更被 .gitattributes 二进制抑制时 fail-closed 而非报告未发现问题", async () => {
    const temp = await createTempRepo();
    try {
      const setupGit = simpleGit(temp.repoPath);
      // 被审提交带 `* -diff`：文本文件也按二进制输出，parseDiff 只剩 skippedFiles。
      await writeFile(join(temp.repoPath, ".gitattributes"), "* -diff\n", "utf8");
      await writeFile(
        join(temp.repoPath, "src", "parse.ts"),
        "export const BINARY_SUPPRESSED_CHANGE = 1;\n",
        "utf8",
      );
      await setupGit.add(["-A"]);
      const commit = await setupGit.commit("suppress text diff");
      const head = commit.commit;

      const model = makeFakeModel(new Error("二进制抑制时不应调用模型"), []);
      const graph = buildReviewGraph({ model: model as any, toolsFactory: createContextTools, repoFactory: (p) => new GitRepositoryAdapter(p), maxToolSteps: 2, maxFilesPerBatch: 20 });
      const out = await graph.invoke({ repoPath: temp.repoPath, range: "commit", ref: head, base: null });
      expect(out.report).toContain("无法充分审查");
      expect(out.report).not.toContain("未发现明确问题");
    } finally {
      temp.cleanup();
    }
  });

  it("发现的问题进入报告并带分级", async () => {
    const model = makeFakeModel({ findings: [candidate] }, [verification]);
    const graph = buildReviewGraph({ model: model as any, toolsFactory: createContextTools, repoFactory: (p) => new GitRepositoryAdapter(p), maxToolSteps: 2, maxFilesPerBatch: 20 });
    const out = await graph.invoke({ repoPath: repo.repoPath, range: "commit", ref: repo.headCommit, base: null });
    expect(out.report).toContain("### [P2]");
    expect(out.report).toContain("src/parse.ts");
  });

  it("空变更不调用模型（短路返回空候选）", async () => {
    const model = makeFakeModel(new Error("空变更不应调用模型"), []);
    const graph = buildReviewGraph({ model: model as any, toolsFactory: createContextTools, repoFactory: (p) => new GitRepositoryAdapter(p), maxToolSteps: 2, maxFilesPerBatch: 20 });
    const out = await graph.invoke({ repoPath: repo.repoPath, range: "diff", ref: null, base: null });
    expect(out.report).toContain("未发现明确问题");
  });

  it("跨批次合并时重写候选 id 以避免冲突", () => {
    const merged = [
      ...prefixBatchIds(1, [candidate]),
      ...prefixBatchIds(2, [{ ...candidate }]),
    ];
    expect(merged.map((item) => item.id)).toEqual(["b1-c1", "b2-c1"]);
    expect(new Set(merged.map((item) => item.id)).size).toBe(merged.length);
  });

  it("仅部分候选被复核覆盖时报「无法充分审查」", async () => {
    // 2 个候选只有 c1 得到复核；c2 缺失复核说明链路不完整，必须 fail-closed 而非输出部分结论。
    const model = makeFakeModel(
      { findings: [candidate, { ...candidate, id: "c2" }] },
      [verification],
    );
    const graph = buildReviewGraph({ model: model as any, toolsFactory: createContextTools, repoFactory: (p) => new GitRepositoryAdapter(p), maxToolSteps: 2, maxFilesPerBatch: 20 });
    const out = await graph.invoke({ repoPath: repo.repoPath, range: "commit", ref: repo.headCommit, base: null });
    expect(out.report).toContain("无法充分审查");
    expect(out.report).not.toContain("未发现明确问题");
  });

  it("失败报告中的审查范围被 HTML 转义", async () => {
    const model = makeFakeModel(new Error("x"), []);
    const graph = buildReviewGraph({ model: model as any, toolsFactory: createContextTools, repoFactory: (p) => new GitRepositoryAdapter(p), maxToolSteps: 2, maxFilesPerBatch: 20 });
    // 该 ref 会让 parse 阶段的 git show 失败，从而进入失败报告路径。
    const out = await graph.invoke({ repoPath: repo.repoPath, range: "commit", ref: "<img onerror=alert(1)>", base: null });
    expect(out.report).toContain("&lt;img");
    expect(out.report).not.toContain("<img onerror");
  });

  it("候选 id 重复时不得绕过复核覆盖守卫", async () => {
    // 两个候选共用 id c1、只有一条复核；旧实现用 Set 判重会对两条都判「已覆盖」。
    const model = makeFakeModel({ findings: [candidate, { ...candidate }] }, [verification]);
    const graph = buildReviewGraph({ model: model as any, toolsFactory: createContextTools, repoFactory: (p) => new GitRepositoryAdapter(p), maxToolSteps: 2, maxFilesPerBatch: 20 });
    const out = await graph.invoke({ repoPath: repo.repoPath, range: "commit", ref: repo.headCommit, base: null });
    expect(out.report).toContain("无法充分审查");
  });

  it("发现候选但复核返回空结果时报「无法充分审查」", async () => {
    const model = makeFakeModel({ findings: [candidate] }, []);
    const graph = buildReviewGraph({ model: model as any, toolsFactory: createContextTools, repoFactory: (p) => new GitRepositoryAdapter(p), maxToolSteps: 2, maxFilesPerBatch: 20 });
    const out = await graph.invoke({ repoPath: repo.repoPath, range: "commit", ref: repo.headCommit, base: null });
    expect(out.report).toContain("无法充分审查");
    expect(out.report).not.toContain("未发现明确问题");
  });

  it("引擎抛错时产出「无法充分审查」而非「未发现明确问题」", async () => {
    const model = makeFakeModel(new Error("boom"), []);
    const graph = buildReviewGraph({ model: model as any, toolsFactory: createContextTools, repoFactory: (p) => new GitRepositoryAdapter(p), maxToolSteps: 2, maxFilesPerBatch: 20 });
    const out = await graph.invoke({ repoPath: repo.repoPath, range: "commit", ref: repo.headCommit, base: null });
    expect(out.report).toContain("无法充分审查");
    expect(out.report).not.toContain("未发现明确问题");
  });
});

import { describe, it, expect, beforeAll, afterAll } from "vitest";
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

  it("引擎抛错时产出「无法充分审查」而非「未发现明确问题」", async () => {
    const model = makeFakeModel(new Error("boom"), []);
    const graph = buildReviewGraph({ model: model as any, toolsFactory: createContextTools, repoFactory: (p) => new GitRepositoryAdapter(p), maxToolSteps: 2, maxFilesPerBatch: 20 });
    const out = await graph.invoke({ repoPath: repo.repoPath, range: "commit", ref: repo.headCommit, base: null });
    expect(out.report).toContain("无法充分审查");
    expect(out.report).not.toContain("未发现明确问题");
  });
});

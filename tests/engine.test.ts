import { describe, it, expect } from "vitest";
import { discoverCandidates, verifyCandidates } from "../src/review/engine.js";
import { makeFakeModel } from "./helpers/fake-model.js";
import { parseDiff } from "../src/repository/diff.js";
import type { Candidate, VerificationResult } from "../src/llm/schemas.js";
import { CandidateListSchema } from "../src/llm/schemas.js";

const diff = parseDiff(`diff --git a/src/parse.ts b/src/parse.ts
--- a/src/parse.ts
+++ b/src/parse.ts
@@ -1,2 +1,2 @@
 export function divide(a, b) {
-  return a / b;
+  return a / b;
 }
`);

const candidate: Candidate = { id: "c1", title: "除零未检查", severity: "P2", file: "src/parse.ts", line: 2, category: "correctness", description: "…", trigger: "…", impact: "…", suggestion: "…" };
const verification: VerificationResult = { id: "c1", verdict: "confirmed", severity: "P2", confidence: "high", evidence: "diff 显示 / b", reason: "…" };

describe("engine", () => {
  it("discoverCandidates 返回结构化候选", async () => {
    const model = makeFakeModel({ findings: [candidate] }, []);
    const out = await discoverCandidates({ model: model as any, tools: [], maxToolSteps: 2 }, diff);
    expect(out).toEqual([candidate]);
  });

  it("verifyCandidates 返回复核结果", async () => {
    const model = makeFakeModel({}, [{ ...verification }]);
    const out = await verifyCandidates({ model: model as any, tools: [], maxToolSteps: 2 }, [candidate], diff);
    expect(out).toEqual([verification]);
  });

  it("模型返回畸形结构化输出时降级为空列表而非抛异常", async () => {
    const malformed = CandidateListSchema.safeParse({ findings: "not-an-array" });
    const model = makeFakeModel(malformed.error!, []);
    const out = await discoverCandidates({ model: model as any, tools: [], maxToolSteps: 2 }, diff);
    expect(out).toEqual([]);
  });

  it("模型网络/鉴权错误时冒泡而非降级（fail-closed）", async () => {
    const model = makeFakeModel(new Error("fetch failed: 401"), []);
    await expect(
      discoverCandidates({ model: model as any, tools: [], maxToolSteps: 2 }, diff),
    ).rejects.toThrow("fetch failed: 401");
  });

  it("工具循环会调用模型请求的工具", async () => {
    const calls: unknown[] = [];
    const readFileTool = {
      name: "read_file",
      invoke: async (args: unknown) => { calls.push(args); return "content"; },
    };
    const model = makeFakeModel({ findings: [candidate] }, [], [[
      { name: "read_file", args: { path: "src/parse.ts" }, id: "call_1" },
    ]]);
    const out = await discoverCandidates({ model: model as any, tools: [readFileTool as any], maxToolSteps: 2 }, diff);
    expect(calls).toEqual([{ path: "src/parse.ts" }]);
    expect(out).toEqual([candidate]);
  });

  it("工具抛错时降级为提示消息而非整阶段失败", async () => {
    const throwingTool = {
      name: "read_file",
      invoke: async () => { throw new Error("git show failed"); },
    };
    const model = makeFakeModel({ findings: [candidate] }, [], [[
      { name: "read_file", args: { path: "src/missing.ts" }, id: "call_1" },
    ]]);
    const out = await discoverCandidates({ model: model as any, tools: [throwingTool as any], maxToolSteps: 2 }, diff);
    expect(out).toEqual([candidate]); // 工具失败不中断，仍能抽取结果
  });

  it("verifyCandidates 丢弃 id 不匹配的复核结果", async () => {
    const wrongId = { ...verification, id: "WRONG" };
    const model = makeFakeModel({}, [wrongId]);
    const out = await verifyCandidates({ model: model as any, tools: [], maxToolSteps: 2 }, [candidate], diff);
    expect(out).toEqual([]);
  });

  it("verifyCandidates 逐条复核（每个候选一次调用）", async () => {
    const c2: Candidate = { ...candidate, id: "c2" };
    const v1 = { ...verification, id: "c1" };
    const v2 = { ...verification, id: "c2" };
    const model = makeFakeModel({}, [v1, v2]);
    const out = await verifyCandidates({ model: model as any, tools: [], maxToolSteps: 2 }, [candidate, c2], diff);
    expect(out).toEqual([v1, v2]);
  });
});

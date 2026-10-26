import { describe, it, expect } from "vitest";
import { discoverCandidates, verifyCandidates } from "../src/review/engine.js";
import { makeFakeModel } from "./helpers/fake-model.js";
import { parseDiff } from "../src/repository/diff.js";
import type { Candidate, VerificationResult } from "../src/llm/schemas.js";

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

  it("模型返回畸形输出时降级为空列表而非抛异常", async () => {
    const model = makeFakeModel(new Error("bad json"), []);
    const out = await discoverCandidates({ model: model as any, tools: [], maxToolSteps: 2 }, diff);
    expect(out).toEqual([]);
  });
});

import { describe, it, expect } from "vitest";
import { finalizeFindings, dedupeFindings, sortFindings } from "../src/review/grade.js";

const c = (id: string, severity: string, file = "a.ts", line = 1) => ({ id, title: id, severity, file, line, category: "correctness", description: "d", trigger: "t", impact: "i", suggestion: "s" }) as any;

describe("finalizeFindings", () => {
  it("confirmed 保留并带 evidence；rejected 丢弃；downgraded 降级", () => {
    const cands = [c("a", "P1"), c("b", "P2"), c("c", "P3")];
    const vers = [
      { id: "a", verdict: "confirmed", severity: "P1", confidence: "high", evidence: "e1", reason: "r" },
      { id: "b", verdict: "rejected", severity: "P2", confidence: "low", evidence: "e2", reason: "r" },
      { id: "c", verdict: "downgraded", severity: "P3", confidence: "medium", evidence: "e3", reason: "r" },
    ];
    const out = finalizeFindings(cands, vers as any);
    expect(out.map((f) => f.id).sort()).toEqual(["a", "c"]);
    expect(out.find((f) => f.id === "a")!.evidence).toBe("e1");
  });

  it("无对应 verification 的 candidate 被丢弃", () => {
    expect(finalizeFindings([c("x", "P1")], [])).toEqual([]);
  });
});

describe("sortFindings", () => {
  it("按 P0→P3 排序，同级按 file 再 line", () => {
    const out = sortFindings([c("a", "P3", "a.ts", 2), c("b", "P0", "b.ts", 1), c("d", "P3", "a.ts", 1)]);
    expect(out.map((f) => f.id)).toEqual(["b", "d", "a"]);
  });
});

describe("dedupeFindings", () => {
  it("同 file+line+category 只留一条", () => {
    const out = dedupeFindings([c("a", "P2", "x.ts", 3), c("b", "P1", "x.ts", 3)]);
    expect(out).toHaveLength(1);
  });
});

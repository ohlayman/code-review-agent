import { describe, it, expect } from "vitest";
import { renderReport } from "../src/report/generator.js";

const f = (over = {}) => ({ id: "c1", title: "除零", severity: "P2", file: "src/parse.ts", line: 2, category: "correctness", description: "d", trigger: "t", impact: "i", suggestion: "s", confidence: "high", evidence: "e", ...over }) as any;

describe("renderReport", () => {
  it("含标题、摘要、问题详情三段", () => {
    const md = renderReport([f()], "commit abc", ["未接真实平台"]);
    expect(md).toContain("# Code Review Report");
    expect(md).toContain("## 1. 审查摘要");
    expect(md).toContain("## 2. 问题详情");
    expect(md).toContain("## 3. 总结与后续建议");
    expect(md).toContain("### [P2] 除零");
    expect(md).toContain("`src/parse.ts`");
  });

  it("无问题时如实报告未发现", () => {
    const md = renderReport([], "commit abc", []);
    expect(md).toContain("未发现明确问题");
    expect(md).not.toContain("### [P");
  });

  it("P0/P1 给出阻止/修复后合并结论", () => {
    const md = renderReport([f({ severity: "P1" })], "s", []);
    expect(md).toContain("修复后合并");
  });
});

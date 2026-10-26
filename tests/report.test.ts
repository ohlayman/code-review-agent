import { describe, it, expect } from "vitest";
import { renderReport, escapeHtml } from "../src/report/generator.js";

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

  it("P0 给出建议阻止合并结论", () => {
    const md = renderReport([f({ severity: "P0" })], "s", []);
    expect(md).toContain("建议阻止合并");
  });

  it("仅有 P2/P3 给出可合并但建议改进结论", () => {
    const md = renderReport([f({ severity: "P2" })], "s", []);
    expect(md).toContain("可合并但建议改进");
  });

  it("无问题时给出可合并结论", () => {
    const md = renderReport([], "s", []);
    expect(md).toContain("总体建议：可合并");
    expect(md).not.toContain("可合并但建议改进");
  });

  it("转义 LLM 自由文本中的 HTML 字符", () => {
    const md = renderReport([f({ description: "<script>alert(1)</script>" })], "s", []);
    expect(md).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
    expect(md).not.toContain("<script>");
  });

  it("不转义反引号，保留建议中的代码格式", () => {
    const md = renderReport([f({ suggestion: "改为 `return a ?? 0`" })], "s", []);
    expect(md).toContain("`return a ?? 0`");
  });

  it("剔除自由文本中的换行/控制字符，不能伪造报告章节", () => {
    const escaped = escapeHtml("安全\n## 伪造章节\n### [P0] 假结论");
    expect(escaped).not.toContain("\n##");
    expect(escaped).not.toContain("\n###");
    expect(escaped).toContain("安全");
    // 原有 HTML 转义行为保持不变。
    expect(escapeHtml("<script>")).toBe("&lt;script&gt;");
  });

  it("剔除 Unicode 行分隔符 U+2028/U+2029", () => {
    const withSep = "a" + String.fromCharCode(0x2028) + "## 伪造" + String.fromCharCode(0x2029) + "### [P0]";
    const escaped = escapeHtml(withSep);
    // 行分隔符必须被剔除，否则 Markdown 会把其后的 ##/### 当成行首标题。
    expect(escaped).not.toContain(String.fromCharCode(0x2028));
    expect(escaped).not.toContain(String.fromCharCode(0x2029));
    // 内容仍在，但已退化为单行（分隔符被替换为空格）。
    expect(escaped).toBe("a ## 伪造 ### [P0]");
  });

  it("存在未文本审查文件时降级为无法充分审查/需要补充信息", () => {
    const md = renderReport([], "s", [], true);
    expect(md).toContain("审查状态：无法充分审查");
    expect(md).toContain("总体建议：需要补充信息");
    expect(md).not.toContain("未发现明确问题");
    expect(md).not.toContain("可合并");
  });
});

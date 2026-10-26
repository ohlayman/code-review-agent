import type { Finding } from "../llm/schemas.js";

const SEVERITIES = ["P0", "P1", "P2", "P3"] as const;

function countSeverities(findings: Finding[]): Record<(typeof SEVERITIES)[number], number> {
  const counts = { P0: 0, P1: 0, P2: 0, P3: 0 };
  for (const finding of findings) counts[finding.severity] += 1;
  return counts;
}

function overallAdvice(findings: Finding[]): string {
  const present = new Set(findings.map((finding) => finding.severity));
  if (present.has("P0")) return "建议阻止合并";
  if (present.has("P1")) return "修复后合并";
  if (present.size > 0) return "可合并但建议改进";
  return "可合并";
}

function renderSummary(findings: Finding[], scope: string, limitations: string[]): string {
  const counts = countSeverities(findings);
  const stats = SEVERITIES.map((severity) => `${severity} ${counts[severity]} 个`).join(" / ");
  const limitationLines =
    limitations.length > 0 ? limitations.map((item) => `  - ${item}`) : ["  - 无"];

  return [
    "## 1. 审查摘要",
    "",
    `- 审查状态：${findings.length > 0 ? "发现问题" : "未发现明确问题"}`,
    `- 总体建议：${overallAdvice(findings)}`,
    `- 问题统计：${stats}（共 ${findings.length} 个）`,
    `- 审查范围：${scope}`,
    "- 验证限制：",
    ...limitationLines,
  ].join("\n");
}

function renderDetail(finding: Finding): string {
  return [
    `### [${finding.severity}] ${finding.title}`,
    "",
    `- 文件：\`${finding.file}\``,
    `- 代码位置：\`${finding.file}:${finding.line}\``,
    `- 问题类型：${finding.category}`,
    `- 问题描述：${finding.description}`,
    `- 触发条件：${finding.trigger}`,
    `- 影响分析：${finding.impact}`,
    `- 修复建议：${finding.suggestion}`,
    `- 置信度：${finding.confidence}`,
    `- 证据：${finding.evidence}`,
  ].join("\n");
}

function renderConclusion(findings: Finding[]): string {
  const top = findings[0];
  const priority = top
    ? `[${top.severity}] ${top.title}（\`${top.file}:${top.line}\`）`
    : "无";
  const tests =
    findings.length > 0
      ? `建议为以下位置补充回归测试：${findings.map((finding) => `\`${finding.file}:${finding.line}\``).join("、")}`
      : "无（本次未发现明确问题）";
  const uncertain = findings.filter((finding) => finding.confidence !== "high");
  const manual =
    uncertain.length > 0
      ? `以下问题置信度非高，需人工确认：${uncertain.map((finding) => `[${finding.severity}] ${finding.title}`).join("、")}`
      : "无";

  return [
    "## 3. 总结与后续建议",
    "",
    `- 最需优先处理的问题：${priority}`,
    `- 建议补充的测试：${tests}`,
    `- 需要人工确认的事项：${manual}`,
  ].join("\n");
}

export function renderReport(findings: Finding[], scope: string, limitations: string[]): string {
  const details =
    findings.length > 0 ? findings.map(renderDetail).join("\n\n") : "未发现明确问题。";

  return (
    [
      "# Code Review Report",
      "",
      renderSummary(findings, scope, limitations),
      "",
      "## 2. 问题详情",
      "",
      details,
      "",
      renderConclusion(findings),
    ].join("\n") + "\n"
  );
}

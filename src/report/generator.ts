import type { Finding } from "../llm/schemas.js";

const SEVERITIES = ["P0", "P1", "P2", "P3"] as const;

// 先剔除控制字符与 Unicode 行分隔符（换行/回车/NEL 与 U+2028/U+2029）：模型自由文本
// 若含换行，可注入换行+##/### 伪造报告章节结构；剔除后自由文本退化为单行。反引号/方括号
// 仍保留——suggestion/evidence 合法含代码反引号，转义会破坏代码格式；XSS 向量只依赖尖括号
// 与 &，平台侧也会 sanitize 原始 HTML。
export function escapeHtml(text: string): string {
  return text
    .replace(/[\p{Cc}\p{Zl}\p{Zp}]/gu, " ")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

function countSeverities(findings: Finding[]): Record<(typeof SEVERITIES)[number], number> {
  const counts = { P0: 0, P1: 0, P2: 0, P3: 0 };
  for (const finding of findings) counts[finding.severity] += 1;
  return counts;
}

// incomplete 表示存在「因二进制/属性抑制未文本审查」的变更文件。此时即便其余文件未发现问题，
// 也不能给出「可合并」这类结论——审查并未覆盖全部变更，必须降级为「需要补充信息」。
function overallAdvice(findings: Finding[], incomplete: boolean): string {
  const present = new Set(findings.map((finding) => finding.severity));
  if (present.has("P0")) return "建议阻止合并";
  if (present.has("P1")) return "修复后合并";
  if (incomplete) return "需要补充信息";
  if (present.size > 0) return "可合并但建议改进";
  return "可合并";
}

function renderSummary(
  findings: Finding[],
  scope: string,
  limitations: string[],
  incomplete: boolean,
): string {
  const counts = countSeverities(findings);
  const stats = SEVERITIES.map((severity) => `${severity} ${counts[severity]} 个`).join(" / ");
  const status =
    findings.length > 0 ? "发现问题" : incomplete ? "无法充分审查" : "未发现明确问题";
  const limitationLines =
    limitations.length > 0
      ? limitations.map((item) => `  - ${escapeHtml(item)}`)
      : ["  - 无"];

  return [
    "## 1. 审查摘要",
    "",
    `- 审查状态：${status}`,
    `- 总体建议：${overallAdvice(findings, incomplete)}`,
    `- 问题统计：${stats}（共 ${findings.length} 个）`,
    `- 审查范围：${escapeHtml(scope)}`,
    "- 验证限制：",
    ...limitationLines,
  ].join("\n");
}

function renderDetail(finding: Finding): string {
  return [
    `### [${finding.severity}] ${escapeHtml(finding.title)}`,
    "",
    `- 文件：\`${escapeHtml(finding.file)}\``,
    `- 代码位置：\`${escapeHtml(finding.file)}:${finding.line}\``,
    `- 问题类型：${finding.category}`,
    `- 问题描述：${escapeHtml(finding.description)}`,
    `- 触发条件：${escapeHtml(finding.trigger)}`,
    `- 影响分析：${escapeHtml(finding.impact)}`,
    `- 修复建议：${escapeHtml(finding.suggestion)}`,
    `- 置信度：${finding.confidence}`,
    `- 证据：${escapeHtml(finding.evidence)}`,
  ].join("\n");
}

function renderConclusion(findings: Finding[], incomplete: boolean): string {
  const top = findings[0];
  const priority = top
    ? `[${top.severity}] ${escapeHtml(top.title)}（\`${escapeHtml(top.file)}:${top.line}\`）`
    : "无";
  const tests =
    findings.length > 0
      ? `建议为以下位置补充回归测试：${findings.map((finding) => `\`${escapeHtml(finding.file)}:${finding.line}\``).join("、")}`
      : incomplete
        ? "无（存在未文本审查的变更文件，需先补齐审查再补充测试）"
        : "无（本次未发现明确问题）";
  const uncertain = findings.filter((finding) => finding.confidence !== "high");
  const manual =
    uncertain.length > 0
      ? `以下问题置信度非高，需人工确认：${uncertain.map((finding) => `[${finding.severity}] ${escapeHtml(finding.title)}`).join("、")}`
      : "无";

  return [
    "## 3. 总结与后续建议",
    "",
    `- 最需优先处理的问题：${priority}`,
    `- 建议补充的测试：${tests}`,
    `- 需要人工确认的事项：${manual}`,
  ].join("\n");
}

export function renderReport(
  findings: Finding[],
  scope: string,
  limitations: string[],
  incomplete = false,
): string {
  const details =
    findings.length > 0
      ? findings.map(renderDetail).join("\n\n")
      : incomplete
        ? "无法充分审查：本次变更包含未文本审查的二进制/属性抑制文件（见验证限制）。"
        : "未发现明确问题。";

  return (
    [
      "# Code Review Report",
      "",
      renderSummary(findings, scope, limitations, incomplete),
      "",
      "## 2. 问题详情",
      "",
      details,
      "",
      renderConclusion(findings, incomplete),
    ].join("\n") + "\n"
  );
}

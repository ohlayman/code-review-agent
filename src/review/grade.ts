import type { Candidate, Finding, Severity, VerificationResult } from "../llm/schemas.js";

// 严重性权重：数字越小越严重，用于排序与去重时比较。
const SEVERITY_WEIGHT: Record<Severity, number> = { P0: 0, P1: 1, P2: 2, P3: 3 };

// 按 id 合并候选与复核结果：只保留 confirmed / downgraded，其余一律丢弃。
export function finalizeFindings(
  candidates: Candidate[],
  verifications: VerificationResult[],
): Finding[] {
  const findings: Finding[] = [];
  for (const candidate of candidates) {
    const verification = verifications.find((v) => v.id === candidate.id);
    if (!verification || verification.verdict === "rejected") continue;

    // downgraded 表示复核认为严重性被高估，置信度最高只保留 medium。
    const confidence =
      verification.verdict === "downgraded" && verification.confidence === "high"
        ? "medium"
        : verification.confidence;

    findings.push({
      ...candidate,
      severity: verification.severity,
      confidence,
      evidence: verification.evidence,
    });
  }
  return findings;
}

// 排序：先按严重性升序（P0→P3），同级按文件路径，再按行号。
export function sortFindings(findings: Finding[]): Finding[] {
  return [...findings].sort((a, b) => {
    const bySeverity = SEVERITY_WEIGHT[a.severity] - SEVERITY_WEIGHT[b.severity];
    if (bySeverity !== 0) return bySeverity;
    if (a.file < b.file) return -1;
    if (a.file > b.file) return 1;
    return a.line - b.line;
  });
}

// 去重：同一 file+line+category 视为同一问题，保留严重性更高的一条。
export function dedupeFindings(findings: Finding[]): Finding[] {
  const byKey = new Map<string, Finding>();
  for (const finding of findings) {
    const key = `${finding.file}|${finding.line}|${finding.category}`;
    const existing = byKey.get(key);
    if (!existing || SEVERITY_WEIGHT[finding.severity] < SEVERITY_WEIGHT[existing.severity]) {
      byKey.set(key, finding);
    }
  }
  return [...byKey.values()];
}

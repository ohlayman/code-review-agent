import { StateGraph, START, END } from "@langchain/langgraph";
import type { StructuredTool } from "@langchain/core/tools";
import type { ChatOpenAI } from "@langchain/openai";
import { ReviewState, type ReviewStateType } from "./state.js";
import type { Candidate } from "../llm/schemas.js";
import { parseDiff, type ChangeSet } from "../repository/diff.js";
import type { RepoAccess, RepositoryAdapter } from "../repository/adapter.js";
import type { ReviewTarget } from "../tools/context-tools.js";
import { discoverCandidates, verifyCandidates, type EngineDeps } from "../review/engine.js";
import { finalizeFindings, dedupeFindings, sortFindings } from "../review/grade.js";
import { renderReport, escapeHtml } from "../report/generator.js";

export interface AgentDeps {
  model: ChatOpenAI;
  toolsFactory: (repo: RepoAccess, target: ReviewTarget) => StructuredTool[];
  repoFactory: (repoPath: string) => RepositoryAdapter;
  maxToolSteps: number;
  maxFilesPerBatch: number;
}

// Phase 1 仅本地 diff 审查；如实声明限制，避免读者误以为已接入平台能力。
const LIMITATIONS = ["未接入代码托管平台，仅本地 diff 审查"];

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function describeScope(state: ReviewStateType): string {
  if (state.range === "commit") return state.ref ? `commit ${state.ref}` : "commit（未指定 sha）";
  if (state.range === "branch") return state.ref ? `branch ${state.ref}` : "branch（未指定分支）";
  return "工作区 diff";
}

// 上下文工具必须读取被审版本：diff 模式读工作区，commit/branch 模式读对应 revision。
function targetFor(state: ReviewStateType): ReviewTarget {
  if (state.range === "diff") return { kind: "worktree" };
  if (!state.ref) throw new Error(`${state.range} 范围缺少引用`);
  return { kind: "rev", rev: state.ref };
}

// 失败兜底：必须明确「无法充分审查」，绝不能渲染成「未发现明确问题」。
function renderFailureReport(state: ReviewStateType): string {
  return (
    [
      "# Code Review Report",
      "",
      "## 1. 审查摘要",
      "",
      "- 审查状态：无法充分审查",
      "- 总体建议：需要补充信息",
      "- 问题统计：P0 0 个 / P1 0 个 / P2 0 个 / P3 0 个（共 0 个）",
      `- 审查范围：${escapeHtml(describeScope(state))}`,
      "- 审查范围及验证限制：",
      `  - ${escapeHtml(state.failure ?? "未知错误")}`,
      ...LIMITATIONS.map((item) => `  - ${item}`),
      "",
      "## 2. 问题详情",
      "",
      "无法充分审查：审查流程在完成前中断，未能形成有效结论。",
      "",
      "## 3. 总结与后续建议",
      "",
      "- 最需优先处理的问题：需先修复审查链路故障后重试",
      "- 建议补充的测试：无（审查未完成）",
      "- 需要人工确认的事项：审查未完成，本次结果不可作为合并依据",
    ].join("\n") + "\n"
  );
}

async function parseNode(state: ReviewStateType, deps: AgentDeps): Promise<Partial<ReviewStateType>> {
  try {
    const repo = deps.repoFactory(state.repoPath);
    if (state.range === "commit") {
      if (!state.ref) throw new Error("commit 范围缺少 commit sha");
      return { changeSet: parseDiff(await repo.getCommitDiff(state.ref), undefined, state.ref) };
    }
    if (state.range === "branch") {
      if (!state.ref) throw new Error("branch 范围缺少分支名");
      const base = state.base ?? undefined;
      return { changeSet: parseDiff(await repo.getBranchDiff(state.ref, base), base, state.ref) };
    }
    return { changeSet: parseDiff(await repo.getWorkingTreeDiff(), state.base ?? undefined) };
  } catch (error) {
    return { failure: `审查失败：${errorMessage(error)}` };
  }
}

// 各批次各自从 c1 开始编号，合并时必须加批次前缀，否则复核/定级按 id 匹配会串批、
// 产生错误证据甚至静默丢弃已确认问题。id 不进入报告，可安全重写。
export function prefixBatchIds(batchIndex: number, candidates: Candidate[]): Candidate[] {
  return candidates.map((candidate) => ({ ...candidate, id: `b${batchIndex}-${candidate.id}` }));
}

// 模型返回的候选 id 不可信：同批内可能出现重复 id，令复核按 id 匹配时错配或
// 令覆盖守卫误判「已全覆盖」。确定性重写重复 id，保证全局唯一。
export function ensureUniqueCandidateIds(candidates: Candidate[]): Candidate[] {
  const seen = new Set<string>();
  return candidates.map((c) => {
    let id = c.id;
    let n = 2;
    while (seen.has(id)) id = `${c.id}-${n++}`;
    seen.add(id);
    return id === c.id ? c : { ...c, id };
  });
}

async function discoverNode(state: ReviewStateType, deps: AgentDeps): Promise<Partial<ReviewStateType>> {
  if (state.failure) return {};
  try {
    const changeSet = state.changeSet;
    if (!changeSet) throw new Error("缺少变更集");
    // 空变更直接短路：不调用模型，杜绝空 diff 上臆造候选。
    // 但「有变更、却全被二进制/属性抑制」不能当成空变更——那样会误报「未发现明确问题」，必须 fail-closed。
    if (changeSet.files.length === 0) {
      const skipped = changeSet.skippedFiles ?? [];
      if (skipped.length > 0) {
        return { failure: `无法充分审查：${skipped.length} 个变更文件因二进制或属性抑制无法文本审查` };
      }
      return { candidates: [] };
    }

    const repo = deps.repoFactory(state.repoPath);
    const engineDeps: EngineDeps = {
      model: deps.model,
      tools: deps.toolsFactory(repo, targetFor(state)),
      maxToolSteps: deps.maxToolSteps,
    };

    if (changeSet.files.length > deps.maxFilesPerBatch) {
      const candidates: Candidate[] = [];
      for (let i = 0; i < changeSet.files.length; i += deps.maxFilesPerBatch) {
        const batchIndex = i / deps.maxFilesPerBatch + 1;
        const batch: ChangeSet = {
          ...changeSet,
          files: changeSet.files.slice(i, i + deps.maxFilesPerBatch),
        };
        const batchCandidates = await discoverCandidates(engineDeps, batch);
        candidates.push(...prefixBatchIds(batchIndex, batchCandidates));
      }
      // 先按批次加前缀保证跨批唯一，再去重同批内重复 id。
      return { candidates: ensureUniqueCandidateIds(candidates) };
    }
    return { candidates: ensureUniqueCandidateIds(await discoverCandidates(engineDeps, changeSet)) };
  } catch (error) {
    return { failure: `审查失败：${errorMessage(error)}` };
  }
}

async function verifyNode(state: ReviewStateType, deps: AgentDeps): Promise<Partial<ReviewStateType>> {
  if (state.failure) return {};
  try {
    const changeSet = state.changeSet;
    if (!changeSet) throw new Error("缺少变更集");
    const repo = deps.repoFactory(state.repoPath);
    const engineDeps: EngineDeps = {
      model: deps.model,
      tools: deps.toolsFactory(repo, targetFor(state)),
      maxToolSteps: deps.maxToolSteps,
    };
    const verifications = await verifyCandidates(engineDeps, state.candidates, changeSet);
    // 每个候选必须有一条同 id 的复核；缺失或 id 失配都算链路失败，必须 fail-closed，
    // 否则未复核候选会被 finalizeFindings 静默丢弃，渲染成「未发现明确问题」。
    const verifiedIds = new Set(verifications.map((v) => v.id));
    const uncovered = state.candidates.some((c) => !verifiedIds.has(c.id));
    if (state.candidates.length > 0 && uncovered) {
      return { failure: "复核阶段未覆盖全部候选问题" };
    }
    // 状态里没有 verifications 字段，故在 verify 阶段即完成候选×复核的合并。
    return { findings: finalizeFindings(state.candidates, verifications) };
  } catch (error) {
    return { failure: `审查失败：${errorMessage(error)}` };
  }
}

async function reportNode(state: ReviewStateType): Promise<Partial<ReviewStateType>> {
  if (state.failure) return { report: renderFailureReport(state) };
  const findings = sortFindings(dedupeFindings(state.findings ?? []));
  const limitations = [...LIMITATIONS];
  // 混合情况（有文本文件 + 有被跳过文件）必须列出被跳过文件，不能静默忽略其审查盲区。
  const skipped = state.changeSet?.skippedFiles ?? [];
  if (skipped.length > 0) {
    limitations.push(`${skipped.length} 个变更文件因二进制或属性抑制未文本审查：${skipped.join("、")}`);
  }
  // 存在被跳过文件时，即便其余文件未发现问题也不能给「可合并/未发现明确问题」，必须降级为
  // 「需要补充信息/无法充分审查」，否则审查盲区会伪装成干净结论。
  return {
    findings,
    report: renderReport(findings, describeScope(state), limitations, skipped.length > 0),
  };
}

export function buildReviewGraph(deps: AgentDeps) {
  return new StateGraph(ReviewState)
    .addNode("parse", (state) => parseNode(state, deps))
    .addNode("discover", (state) => discoverNode(state, deps))
    .addNode("verify", (state) => verifyNode(state, deps))
    // 节点名不能与状态字段同名（report 已是 channel），故最终节点命名为 render。
    .addNode("render", (state) => reportNode(state))
    .addEdge(START, "parse")
    .addEdge("parse", "discover")
    .addEdge("discover", "verify")
    .addEdge("verify", "render")
    .addEdge("render", END)
    .compile();
}

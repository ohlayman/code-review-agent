import { Annotation } from "@langchain/langgraph";
import type { Candidate, Finding } from "../llm/schemas.js";
import type { ChangeSet } from "../repository/diff.js";

// 可空字段用 `b ?? a`：后续节点未写入（undefined/null）时保留已有值，避免被意外清空。
export const ReviewState = Annotation.Root({
  repoPath: Annotation<string>,
  range: Annotation<"diff" | "commit" | "branch">,
  ref: Annotation<string | null>({ reducer: (a, b) => b ?? a }),
  base: Annotation<string | null>({ reducer: (a, b) => b ?? a }),
  changeSet: Annotation<ChangeSet | null>({ reducer: (a, b) => b ?? a }),
  candidates: Annotation<Candidate[]>,
  findings: Annotation<Finding[]>,
  report: Annotation<string | null>({ reducer: (a, b) => b ?? a }),
  failure: Annotation<string | null>({ reducer: (a, b) => b ?? a }),
});

export type ReviewStateType = typeof ReviewState.State;

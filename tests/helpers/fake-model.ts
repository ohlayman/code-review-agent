import { AIMessage } from "@langchain/core/messages";
import type { Candidate, VerificationResult } from "../../src/llm/schemas.js";

export interface ScriptedToolCall {
  name: string;
  args: Record<string, unknown>;
  id: string;
  type?: "tool_call";
}

// 测试用假模型：不发起任何网络请求。
// invoke() 依 toolCallScript 队列逐次返回带 tool_calls 的 AIMessage，队列耗尽后返回无 tool_calls，令循环退出；
// withStructuredOutput().invoke() 逐次从 verifications 队列弹出复核结果（供逐条复核断言），或抛 Error 模拟畸形输出。
export function makeFakeModel(
  script: { findings?: Candidate[] } | Error,
  verifications: VerificationResult[],
  toolCallScript: ScriptedToolCall[][] = [],
): any {
  const verificationQueue = [...verifications];
  const callQueue = [...toolCallScript];
  const fake = {
    bindTools: () => fake,
    invoke: async () => {
      const next = callQueue.shift();
      if (next && next.length > 0) {
        return new AIMessage({ content: "", tool_calls: next });
      }
      return new AIMessage({ content: "" });
    },
    withStructuredOutput: () => ({
      invoke: async () => {
        if (script instanceof Error) throw script;
        const next = verificationQueue.shift();
        // 每次调用弹出至多一条复核结果，并保持 schema 要求的数组形态。
        return { findings: script?.findings ?? [], verifications: next ? [next] : [] };
      },
    }),
  };
  return fake;
}

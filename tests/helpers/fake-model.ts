import { AIMessage } from "@langchain/core/messages";
import type { Candidate, VerificationResult } from "../../src/llm/schemas.js";

// 测试用假模型：不发起任何网络请求。
// bindTools/invoke 返回无 tool_calls 的 AIMessage，使工具循环立即退出；
// withStructuredOutput 直接返回注入的脚本结果，或抛出传入的 Error 模拟畸形输出。
export function makeFakeModel(
  script: { findings?: Candidate[] } | Error,
  verifications: VerificationResult[],
): any {
  const fake = {
    bindTools: () => fake,
    invoke: async () => new AIMessage({ content: "" }),
    withStructuredOutput: () => ({
      invoke: async () => {
        if (script instanceof Error) throw script;
        return { findings: script?.findings ?? [], verifications };
      },
    }),
  };
  return fake;
}

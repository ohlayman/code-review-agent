import { ChatOpenAI } from "@langchain/openai";
import type { Config } from "../config.js";

// DeepSeek 兼容 OpenAI 协议：通过 configuration.baseURL 指向自建/官方端点。
export function createReviewModel(config: Config): ChatOpenAI {
  return new ChatOpenAI({
    model: config.model,
    apiKey: config.apiKey,
    configuration: { baseURL: config.baseURL },
    temperature: 0,
  });
}

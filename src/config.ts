import { z } from "zod";

export const ConfigSchema = z.object({
  apiKey: z.string().min(1),
  model: z.string().min(1).default("deepseek-chat"),
  baseURL: z.string().url().default("https://api.deepseek.com"),
  maxToolSteps: z.number().int().positive().default(8),
  maxFilesPerBatch: z.number().int().positive().default(20),
});

export type Config = z.infer<typeof ConfigSchema>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const apiKey = env.DEEPSEEK_API_KEY;
  if (!apiKey) {
    throw new Error("缺少 DEEPSEEK_API_KEY：请在环境变量或 .env 文件中配置 DeepSeek API Key");
  }

  const parsed = ConfigSchema.safeParse({
    apiKey,
    model: env.REVIEW_MODEL,
    baseURL: env.REVIEW_BASE_URL,
    maxToolSteps: env.MAX_TOOL_STEPS ? Number(env.MAX_TOOL_STEPS) : undefined,
    maxFilesPerBatch: env.MAX_FILES_PER_BATCH ? Number(env.MAX_FILES_PER_BATCH) : undefined,
  });

  if (!parsed.success) {
    const details = parsed.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`).join("; ");
    throw new Error(`配置无效：${details}`);
  }

  return parsed.data;
}

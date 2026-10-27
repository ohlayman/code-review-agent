import { fileURLToPath } from "node:url";
import path from "node:path";
import dotenv from "dotenv";
import { loadConfig, type Config } from "./config.js";
import { createReviewModel } from "./llm/adapter.js";
import { GitRepositoryAdapter } from "./repository/adapter.js";
import { createContextTools } from "./tools/context-tools.js";
import { buildReviewGraph } from "./core/graph.js";
import { parseArgs, type CliArgs } from "./cli.js";
import { resolvePullRequest, clonePullRequest, GitHubPlatformAdapter } from "./platform/github.js";

// 只信任 Agent 自身目录下的 .env：--repo 指向的仓库不可信，禁止从 process.cwd() 读取配置，
// 否则恶意仓库可投放 .env 劫持 DEEPSEEK_API_KEY。
const moduleDir = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(moduleDir, "..", ".env"), quiet: true });

async function main(): Promise<void> {
  const args: CliArgs = parseArgs(process.argv.slice(2));

  let config: Config;
  try {
    config = loadConfig();
  } catch (error) {
    console.error(`配置错误：${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  }

  const graph = buildReviewGraph({
    model: createReviewModel(config),
    toolsFactory: createContextTools,
    repoFactory: (repoPath) => new GitRepositoryAdapter(repoPath),
    maxToolSteps: config.maxToolSteps,
    maxFilesPerBatch: config.maxFilesPerBatch,
  });

  let repoPath: string;
  let range: "diff" | "commit" | "branch";
  let ref: string | null;
  let base: string | null;
  let cleanup: (() => Promise<void>) | undefined;

  try {
    if (args.command === "pr") {
      const token = process.env.GITHUB_TOKEN;
      const pr = await resolvePullRequest(args.repo, args.prNumber, token);
      const checkout = await clonePullRequest(pr.cloneUrl, pr.baseSha, pr.headSha, token);
      repoPath = checkout.dir;
      range = "branch";
      ref = checkout.head;
      base = checkout.base;
      cleanup = checkout.cleanup;
    } else {
      repoPath = args.repoPath;
      range = args.command;
      ref = args.command === "diff" ? null : args.ref;
      base = args.base;
    }

    const state = await graph.invoke({ repoPath, range, ref, base });
    if (!state.report) {
      console.error("审查未产出报告");
      process.exit(1);
    }
    console.log(state.report);

    if (args.comment) {
      const token = process.env.GITHUB_TOKEN;
      if (!token) throw new Error("--comment 需要 GITHUB_TOKEN 环境变量（只读权限即可）");
      await new GitHubPlatformAdapter(token).postReviewComment(args.comment, state.report);
      console.error(`已发布审查评论到 ${args.comment}`);
    }
  } finally {
    if (cleanup) await cleanup();
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});

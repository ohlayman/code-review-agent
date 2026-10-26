import { fileURLToPath } from "node:url";
import path from "node:path";
import dotenv from "dotenv";
import { loadConfig, type Config } from "./config.js";
import { createReviewModel } from "./llm/adapter.js";
import { GitRepositoryAdapter } from "./repository/adapter.js";
import { createContextTools } from "./tools/context-tools.js";
import { buildReviewGraph } from "./core/graph.js";

// 只信任 Agent 自身目录下的 .env：--repo 指向的仓库不可信，禁止从 process.cwd() 读取配置，
// 否则恶意仓库可投放 .env 劫持 DEEPSEEK_API_KEY。
const moduleDir = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(moduleDir, "..", ".env"), quiet: true });

interface CliArgs {
  range: "diff" | "commit" | "branch";
  ref: string | null;
  base: string | null;
  repoPath: string;
}

const USAGE = "用法：code-review-agent <diff|commit|branch> [ref] [--base <ref>] [--repo <path>]";

function takeOption(args: string[], name: string): string | null {
  const index = args.indexOf(name);
  if (index === -1) return null;
  const value = args[index + 1];
  if (!value) throw new Error(`${name} 需要指定取值`);
  args.splice(index, 2);
  return value;
}

function parseArgs(argv: string[]): CliArgs {
  const args = [...argv];
  const repoPath = takeOption(args, "--repo");
  const base = takeOption(args, "--base");
  const [command, ref] = args;

  if (command === "diff") {
    return { range: "diff", ref: null, base, repoPath: repoPath ? path.resolve(repoPath) : process.cwd() };
  }
  if (command === "commit" || command === "branch") {
    if (!ref) throw new Error(`${command} 需要指定${command === "commit" ? " commit sha" : "分支名"}`);
    return { range: command, ref, base, repoPath: repoPath ? path.resolve(repoPath) : process.cwd() };
  }
  throw new Error(USAGE);
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));

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

  const state = await graph.invoke({
    repoPath: args.repoPath,
    range: args.range,
    ref: args.ref,
    base: args.base,
  });

  if (!state.report) {
    console.error("审查未产出报告");
    process.exit(1);
  }
  console.log(state.report);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});

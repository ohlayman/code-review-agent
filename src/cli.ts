import path from "node:path";

export interface CommonArgs {
  comment: string | null;
}

export type CliArgs =
  | (CommonArgs & { command: "diff"; base: string | null; repoPath: string })
  | (CommonArgs & { command: "commit" | "branch"; ref: string; base: string | null; repoPath: string })
  | (CommonArgs & { command: "pr"; repo: string; prNumber: number });

const USAGE = "用法：code-review-agent <diff|commit|branch|pr> [ref] [--base <ref>] [--repo <path>] [--comment <owner/repo#pr>]";

function takeOption(args: string[], name: string): string | null {
  const index = args.indexOf(name);
  if (index === -1) return null;
  const value = args[index + 1];
  if (!value) throw new Error(`${name} 需要指定取值`);
  args.splice(index, 2);
  return value;
}

export function parseArgs(argv: string[]): CliArgs {
  const args = [...argv];
  const repoPath = takeOption(args, "--repo");
  const base = takeOption(args, "--base");
  const comment = takeOption(args, "--comment");
  const [command, a, b] = args;

  if (command === "diff") {
    return { command: "diff", base, repoPath: repoPath ? path.resolve(repoPath) : process.cwd(), comment };
  }
  if (command === "commit" || command === "branch") {
    if (!a) throw new Error(`${command} 需要指定${command === "commit" ? " commit sha" : "分支名"}`);
    return { command, ref: a, base, repoPath: repoPath ? path.resolve(repoPath) : process.cwd(), comment };
  }
  if (command === "pr") {
    if (!a || !b) throw new Error("pr 需要指定 owner/repo 与 PR 编号");
    const prNumber = Number(b);
    if (!Number.isInteger(prNumber) || prNumber <= 0) throw new Error("PR 编号必须是正整数");
    return { command: "pr", repo: a, prNumber, comment };
  }
  throw new Error(USAGE);
}

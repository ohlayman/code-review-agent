import { rmSync } from "node:fs";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { simpleGit } from "simple-git";

export interface TempRepo {
  repoPath: string;
  headCommit: string;
  cleanup: () => void;
}

export async function createTempRepo(): Promise<TempRepo> {
  const repoPath = await mkdtemp(join(tmpdir(), "code-review-agent-"));
  await mkdir(join(repoPath, "src"), { recursive: true });
  await writeFile(join(repoPath, "src", "parse.ts"), "export function divide(a, b) { return a / b; }\n", "utf8");

  const git = simpleGit(repoPath);
  await git.init();
  await git.addConfig("user.name", "Test User", false, "local");
  await git.addConfig("user.email", "test@example.com", false, "local");
  await git.addConfig("commit.gpgsign", "false", false, "local");
  await git.add(["-A"]);
  await git.commit("init");

  const headCommit = (await git.revparse(["HEAD"])).trim();
  return {
    repoPath,
    headCommit,
    cleanup: () => {
      rmSync(repoPath, { recursive: true, force: true });
    },
  };
}

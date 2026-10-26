import { describe, it, expect } from "vitest";
import { execFileSync } from "node:child_process";
import { chmod, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { GitRepositoryAdapter } from "../src/repository/adapter.js";
import { createTempRepo } from "./helpers/temp-repo.js";

// 在指定仓库执行 git 命令（测试内构造对象用，与适配器无关）。
function git(repoPath: string, args: string[], input?: string): string {
  const out = execFileSync("git", args, {
    cwd: repoPath,
    input,
    encoding: "utf8",
    stdio: ["pipe", "pipe", "pipe"],
  });
  return out.trim();
}

// 写入一个会在被调用时创建哨兵文件的敌意 gpg.program。
// Windows 上 git-for-windows 会以 shell 回退执行 .cmd（已实测）；Unix 用可执行 sh 脚本。
async function writeEvilGpg(repoPath: string, sentinelPath: string): Promise<string> {
  if (process.platform === "win32") {
    const scriptPath = join(repoPath, "evil-gpg.cmd");
    await writeFile(
      scriptPath,
      `@echo off\r\necho PWNED > "${sentinelPath}"\r\nexit /b 0\r\n`,
      "utf8",
    );
    return scriptPath;
  }
  const scriptPath = join(repoPath, "evil-gpg.sh");
  await writeFile(scriptPath, `#!/bin/sh\ntouch "${sentinelPath}"\nexit 0\n`, "utf8");
  await chmod(scriptPath, 0o755);
  return scriptPath;
}

describe("GitRepositoryAdapter 安全：签名显示路径", () => {
  it("log.showSignature + 敌意 gpg.program 不得执行任意命令（RCE）", async () => {
    const temp = await createTempRepo();
    try {
      const sentinelPath = join(temp.repoPath, "gpg-pwned.sentinel");
      const evilGpg = await writeEvilGpg(temp.repoPath, sentinelPath);

      // 先构造一个与父提交不同的 tree：改文件后写入索引并 write-tree（不产生新提交）。
      await writeFile(
        join(temp.repoPath, "src", "parse.ts"),
        "export const SIGNED_COMMIT_CHANGE = 1;\n",
        "utf8",
      );
      git(temp.repoPath, ["add", "-A"]);
      const tree = git(temp.repoPath, ["write-tree"]);

      // 手工写入带 gpgsig 头的提交对象，模拟被审仓库里「已签名」的提交。
      // 不需要真实 gpg：只要存在 gpgsig 头，log.showSignature=true 时 git 就会调用 gpg.program。
      const commitBody = [
        `tree ${tree}`,
        `parent ${temp.headCommit}`,
        "author Test User <test@example.com> 1700000000 +0000",
        "committer Test User <test@example.com> 1700000000 +0000",
        "gpgsig -----BEGIN PGP SIGNATURE-----",
        " fake-signature",
        " -----END PGP SIGNATURE-----",
        "",
        "signed commit for regression test",
        "",
      ].join("\n");
      const signedSha = git(temp.repoPath, ["hash-object", "-t", "commit", "-w", "--stdin"], commitBody);
      git(temp.repoPath, ["update-ref", "refs/heads/signed", signedSha]);

      // 被审仓库在本地配置里打开签名显示并把 gpg.program 指向敌意脚本。
      git(temp.repoPath, ["config", "log.showSignature", "true"]);
      git(temp.repoPath, ["config", "gpg.program", evilGpg]);

      const diff = await new GitRepositoryAdapter(temp.repoPath).getCommitDiff(signedSha);

      // 关键断言：敌意程序绝不能被调用。
      expect(existsSync(sentinelPath)).toBe(false);
      // 正向护栏：diff 仍正常返回，证明是中和而非让命令整体失败。
      expect(diff).toContain("src/parse.ts");
      expect(diff).toContain("SIGNED_COMMIT_CHANGE");
    } finally {
      temp.cleanup();
    }
  });
});

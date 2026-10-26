import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdir, mkdtemp, symlink, writeFile } from "node:fs/promises";
import { existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { simpleGit } from "simple-git";
import { createContextTools } from "../src/tools/context-tools.js";
import { GitRepositoryAdapter as GitRepo } from "../src/repository/adapter.js";
import { createTempRepo } from "./helpers/temp-repo.js";

let repo: Awaited<ReturnType<typeof createTempRepo>>;

describe("createContextTools", () => {
  beforeAll(async () => { repo = await createTempRepo(); });
  afterAll(() => repo.cleanup());

  it("read_file 返回文件内容", async () => {
    const [readFile] = createContextTools(new GitRepo(repo.repoPath), { kind: "rev", rev: "HEAD" });
    const out = await readFile.invoke({ path: "src/parse.ts" });
    expect(String(out)).toContain("divide");
  });

  it("grep 命中返回行内容", async () => {
    const tools = createContextTools(new GitRepo(repo.repoPath), { kind: "rev", rev: "HEAD" });
    const grep = tools.find((t) => t.name === "grep")!;
    expect(String(await grep.invoke({ pattern: "divide" }))).toContain("src/parse.ts");
  });

  it("read_related_test 找不到测试文件时返回提示串", async () => {
    const tools = createContextTools(new GitRepo(repo.repoPath), { kind: "rev", rev: "HEAD" });
    const rt = tools.find((t) => t.name === "read_related_test")!;
    expect(String(await rt.invoke({ path: "src/parse.ts" }))).toMatch(/未找到|no test/i);
  });

  it("commit 模式按指定 revision 读取历史内容而非 HEAD", async () => {
    const temp = await createTempRepo();
    try {
      const git = simpleGit(temp.repoPath);
      await writeFile(
        join(temp.repoPath, "src", "parse.ts"),
        "export function divide(a, b) { return b === 0 ? 0 : a / b; }\n",
        "utf8",
      );
      await git.add(["-A"]);
      await git.commit("guard zero");

      const [readOld] = createContextTools(new GitRepo(temp.repoPath), {
        kind: "rev",
        rev: temp.headCommit,
      });
      expect(String(await readOld.invoke({ path: "src/parse.ts" }))).not.toContain("b === 0");

      const [readHead] = createContextTools(new GitRepo(temp.repoPath), {
        kind: "rev",
        rev: "HEAD",
      });
      expect(String(await readHead.invoke({ path: "src/parse.ts" }))).toContain("b === 0");
    } finally {
      temp.cleanup();
    }
  });

  it("worktree 模式读取磁盘上的最新内容", async () => {
    const temp = await createTempRepo();
    try {
      await writeFile(
        join(temp.repoPath, "src", "parse.ts"),
        "export function divide(a, b) { return a / b; } // WORKTREE_ONLY\n",
        "utf8",
      );
      const [readFile] = createContextTools(new GitRepo(temp.repoPath), { kind: "worktree" });
      expect(String(await readFile.invoke({ path: "src/parse.ts" }))).toContain("WORKTREE_ONLY");
    } finally {
      temp.cleanup();
    }
  });

  it("worktree 模式拒绝越界路径", async () => {
    const temp = await createTempRepo();
    try {
      const [readFile] = createContextTools(new GitRepo(temp.repoPath), { kind: "worktree" });
      await expect(readFile.invoke({ path: "../escape.ts" })).rejects.toThrow(/非法路径/);
    } finally {
      temp.cleanup();
    }
  });

  it("worktree 模式拒绝指向仓库外的符号链接", async (ctx) => {
    const temp = await createTempRepo();
    const outsideDir = await mkdtemp(join(tmpdir(), "code-review-agent-outside-"));
    try {
      const outsideFile = join(outsideDir, "secret.txt");
      await writeFile(outsideFile, "OUTSIDE_SENTINEL", "utf8");
      const [readFile] = createContextTools(new GitRepo(temp.repoPath), { kind: "worktree" });
      // 优先建文件符号链接；Windows 无开发者模式时退而使用免特权的目录 junction。
      let linkPath: string | null = null;
      let readPath = "";
      try {
        linkPath = join(temp.repoPath, "leak.txt");
        readPath = "leak.txt";
        await symlink(outsideFile, linkPath, "file");
      } catch {
        try {
          linkPath = join(temp.repoPath, "leak-dir");
          readPath = "leak-dir/secret.txt";
          await symlink(outsideDir, linkPath, "junction");
        } catch {
          linkPath = null;
        }
      }
      if (linkPath) {
        await expect(readFile.invoke({ path: readPath })).rejects.toThrow(/非法路径/);
      } else {
        // 两种链接均不可用：退化为验证词法越界拒绝。
        await expect(readFile.invoke({ path: "../escape.ts" })).rejects.toThrow(/非法路径/);
        ctx.skip();
      }
    } finally {
      temp.cleanup();
      rmSync(outsideDir, { recursive: true, force: true });
    }
  });

  it("从子目录启动时以 .git 所在顶层为根读取工作区文件", async () => {
    const temp = await createTempRepo();
    try {
      const nested = join(temp.repoPath, "nested");
      await mkdir(nested, { recursive: true });
      await writeFile(join(temp.repoPath, "root.txt"), "TOP_LEVEL_ONLY\n", "utf8");
      const tools = createContextTools(new GitRepo(nested), { kind: "worktree" });
      const [readFile] = tools;
      // 顶层相对路径（含顶层文件）都能从子目录适配器读到，证明根是包含 .git 的目录。
      expect(String(await readFile.invoke({ path: "src/parse.ts" }))).toContain("divide");
      expect(String(await readFile.invoke({ path: "root.txt" }))).toContain("TOP_LEVEL_ONLY");
      const list = tools.find((t) => t.name === "list_files")!;
      expect(String(await list.invoke({}))).toContain("src/parse.ts");
    } finally {
      temp.cleanup();
    }
  });

  it("从子目录启动时 rev 模式 grep 与 list_files 覆盖顶层", async () => {
    const temp = await createTempRepo();
    try {
      const nested = join(temp.repoPath, "subdir");
      await mkdir(nested, { recursive: true });
      await writeFile(join(temp.repoPath, "root-marker.txt"), "TOP_LEVEL_MARKER\n", "utf8");
      const setupGit = simpleGit(temp.repoPath);
      await setupGit.add(["-A"]);
      await setupGit.commit("add root marker");

      const adapter = new GitRepo(nested);
      // rev 模式必须锚定到文件系统派生的顶层，不能只覆盖子目录。
      expect(await adapter.grep("TOP_LEVEL_MARKER", "HEAD")).toContain("root-marker.txt");
      const files = await adapter.listFiles("HEAD");
      expect(files).toContain("root-marker.txt");
      expect(files).toContain("src/parse.ts");
    } finally {
      temp.cleanup();
    }
  });

  it("普通提交的 HEAD 文件 + objects 目录不得被误判为 bare 导致漏报顶层", async () => {
    const temp = await createTempRepo();
    try {
      // 在子目录提交普通文件 HEAD 与 objects/junk，制造「bare 样目录」。
      const forged = join(temp.repoPath, "sub");
      await mkdir(join(forged, "objects"), { recursive: true });
      await writeFile(join(forged, "HEAD"), "not a real gitdir\n", "utf8");
      await writeFile(join(forged, "objects", "junk"), "x", "utf8");
      await writeFile(join(temp.repoPath, "root-marker.txt"), "TOP_LEVEL_MARKER\n", "utf8");
      const setupGit = simpleGit(temp.repoPath);
      await setupGit.add(["-A"]);
      await setupGit.commit("add forged dir + root marker");

      // 从子目录启动：旧实现用 HEAD+objects 启发式误判为 bare，revRaw 无锚回退，
      // grep/listFiles 只覆盖子目录，静默漏报顶层文件。
      const adapter = new GitRepo(forged);
      expect(await adapter.grep("TOP_LEVEL_MARKER", "HEAD")).toContain("root-marker.txt");
      const files = await adapter.listFiles("HEAD");
      expect(files).toContain("root-marker.txt");
      expect(files).toContain("src/parse.ts");
    } finally {
      temp.cleanup();
    }
  });

  it("工作区 diff 不得执行被审仓库定义的 filter 驱动", async () => {
    const temp = await createTempRepo();
    try {
      const setupGit = simpleGit(temp.repoPath);
      await writeFile(join(temp.repoPath, "data.txt"), "ORIGINAL\n", "utf8");
      await setupGit.add(["-A"]);
      await setupGit.commit("add data");
      await writeFile(join(temp.repoPath, "data.txt"), "CHANGED_BY_REVIEW\n", "utf8");

      // filter 命令由被审仓库的 .gitattributes + .git/config 共同定义；
      // 一旦 diff 比较工作区侧时执行 clean 过滤器，就会在仓库内落下哨兵文件。
      const sentinel = join(temp.repoPath, "filter-pwned.sentinel");
      const sentinelPosix = sentinel.replaceAll("\\", "/");
      await writeFile(join(temp.repoPath, ".gitattributes"), "*.txt filter=evil\n", "utf8");
      await writeFile(
        join(temp.repoPath, ".git", "config"),
        // 用 `写文件 && cat` 而非嵌套 `sh -c '…; cat'`：git 配置值中的 `;` 会被截断。
        `[filter "evil"]\n\tclean = printf PWNED > ${sentinelPosix} && cat\n`,
        { flag: "a" },
      );

      const diff = await new GitRepo(temp.repoPath).getWorkingTreeDiff();
      expect(existsSync(sentinel)).toBe(false);
      expect(diff).toContain("CHANGED_BY_REVIEW");
    } finally {
      temp.cleanup();
    }
  });

  it("filter 驱动名含 = 时必须 fail-closed 而非被 -c 首 = 解析绕过", async () => {
    const temp = await createTempRepo();
    try {
      const setupGit = simpleGit(temp.repoPath);
      await writeFile(join(temp.repoPath, "data.txt"), "ORIGINAL\n", "utf8");
      await setupGit.add(["-A"]);
      await setupGit.commit("add data");
      await writeFile(join(temp.repoPath, "data.txt"), "CHANGED_BY_REVIEW\n", "utf8");

      const sentinel = join(temp.repoPath, "filter-pwned.sentinel");
      const sentinelPosix = sentinel.replaceAll("\\", "/");
      await writeFile(join(temp.repoPath, ".gitattributes"), "*.txt filter=x=y\n", "utf8");
      await writeFile(
        join(temp.repoPath, ".git", "config"),
        `[filter "x=y"]\n\tclean = printf PWNED > ${sentinelPosix} && cat\n`,
        { flag: "a" },
      );

      // 拼成 -c filter.x=y.clean=cat 会被 git 按首个 = 拆成 key=`filter.x`、value=`y.clean=cat`，
      // 真正要覆盖的 filter.x=y.clean 原封不动，敌意命令仍会执行；必须直接拒绝。
      await expect(new GitRepo(temp.repoPath).getWorkingTreeDiff()).rejects.toThrow(
        /不安全的 filter 驱动名/,
      );
      expect(existsSync(sentinel)).toBe(false);
    } finally {
      temp.cleanup();
    }
  });

  it("filter 驱动名为空时必须 fail-closed 而非被枚举正则静默跳过", async () => {
    const temp = await createTempRepo();
    try {
      const setupGit = simpleGit(temp.repoPath);
      await writeFile(join(temp.repoPath, "data.txt"), "ORIGINAL\n", "utf8");
      await setupGit.add(["-A"]);
      await setupGit.commit("add data");
      await writeFile(join(temp.repoPath, "data.txt"), "CHANGED_BY_REVIEW\n", "utf8");

      const sentinel = join(temp.repoPath, "filter-pwned.sentinel");
      const sentinelPosix = sentinel.replaceAll("\\", "/");
      // 空驱动名：[filter ""] 的 clean 键名为 filter..clean；.gitattributes 用 filter=（空值）引用。
      // 旧正则 (.+) 要求驱动名至少 1 字符，会静默跳过该键，敌意 clean 仍执行并落哨兵。
      await writeFile(join(temp.repoPath, ".gitattributes"), "*.txt filter=\n", "utf8");
      await writeFile(
        join(temp.repoPath, ".git", "config"),
        `[filter ""]\n\tclean = printf PWNED > ${sentinelPosix} && cat\n`,
        { flag: "a" },
      );

      await expect(new GitRepo(temp.repoPath).getWorkingTreeDiff()).rejects.toThrow(
        /不安全的 filter 驱动名/,
      );
      expect(existsSync(sentinel)).toBe(false);
    } finally {
      temp.cleanup();
    }
  });

  it("filter 驱动名含空格时必须 fail-closed 而非被空白切分静默跳过", async () => {
    const temp = await createTempRepo();
    try {
      const setupGit = simpleGit(temp.repoPath);
      await writeFile(join(temp.repoPath, "data.txt"), "ORIGINAL\n", "utf8");
      await setupGit.add(["-A"]);
      await setupGit.commit("add data");
      await writeFile(join(temp.repoPath, "data.txt"), "CHANGED_BY_REVIEW\n", "utf8");

      const sentinel = join(temp.repoPath, "filter-pwned.sentinel");
      const sentinelPosix = sentinel.replaceAll("\\", "/");
      await writeFile(join(temp.repoPath, ".gitattributes"), "*.txt filter=evil thing\n", "utf8");
      await writeFile(
        join(temp.repoPath, ".git", "config"),
        `[filter "evil thing"]\n\tclean = printf PWNED > ${sentinelPosix} && cat\n`,
        { flag: "a" },
      );

      // 旧实现按空白切分会得到 filter.evil，正则不匹配后静默跳过；
      // -z 必须精确取到含空格的名字并 fail-closed。
      await expect(new GitRepo(temp.repoPath).getWorkingTreeDiff()).rejects.toThrow(
        /不安全的 filter 驱动名/,
      );
      // .gitattributes 无法引用名字含空格的驱动，过滤器本就不会执行、哨兵本就不会生成，
      // 故断言恒成立、无验证价值，删除。
    } finally {
      temp.cleanup();
    }
  });

  it("嵌套在父工作区内的 bare 仓库不被误锚定到父仓库", async () => {
    const parent = await createTempRepo();
    const workDir = await mkdtemp(join(tmpdir(), "code-review-agent-bare-work-"));
    try {
      const workGit = simpleGit(workDir);
      await workGit.init();
      await workGit.addConfig("user.name", "Test User", false, "local");
      await workGit.addConfig("user.email", "test@example.com", false, "local");
      await workGit.addConfig("commit.gpgsign", "false", false, "local");
      await writeFile(join(workDir, "bare-only.txt"), "BARE_OWN_FILE\n", "utf8");
      await workGit.add(["-A"]);
      await workGit.commit("bare seed");
      const sha = (await workGit.revparse(["HEAD"])).trim();

      // bare 仓库放在父工作区内部：沿祖先找 .git 会命中父仓库，必须识别 bare 并拒绝锚定。
      const bareDir = join(parent.repoPath, "nested.git");
      await simpleGit().raw(["init", "--bare", bareDir]);
      await workGit.push(bareDir, "HEAD:refs/heads/main");

      const adapter = new GitRepo(bareDir);
      await expect(adapter.getWorkingTreeDiff()).rejects.toThrow(/无工作区顶层|未找到 \.git 标记/);

      // rev 模式仍应读 bare 自己的对象库，而不是父仓库。
      const files = await adapter.listFiles(sha);
      expect(files).toContain("bare-only.txt");
      expect(files).not.toContain("src/parse.ts");
    } finally {
      parent.cleanup();
      rmSync(workDir, { recursive: true, force: true });
    }
  });

  it("指向 bare 仓库的子目录时不得越过 bare 祖先锚定到父工作区", async () => {
    const parent = await createTempRepo();
    const workDir = await mkdtemp(join(tmpdir(), "code-review-agent-bare-work-"));
    try {
      const workGit = simpleGit(workDir);
      await workGit.init();
      await workGit.addConfig("user.name", "Test User", false, "local");
      await workGit.addConfig("user.email", "test@example.com", false, "local");
      await workGit.addConfig("commit.gpgsign", "false", false, "local");
      await writeFile(join(workDir, "bare-only.txt"), "BARE_OWN_FILE\n", "utf8");
      await workGit.add(["-A"]);
      await workGit.commit("bare seed");
      const sha = (await workGit.revparse(["HEAD"])).trim();

      // bare 仓库放在父工作区内部；适配器指向 bare 仓库的子目录（不是 bare 根）。
      const bareDir = join(parent.repoPath, "nested.git");
      await simpleGit().raw(["init", "--bare", bareDir]);
      await workGit.push(bareDir, "HEAD:refs/heads/main");

      const subdir = join(bareDir, "refs");
      const adapter = new GitRepo(subdir);
      // 未修复时：越过 bare 祖先、命中父工作区 .git，diff 返回跨仓库字符串而非拒绝。
      await expect(adapter.getWorkingTreeDiff()).rejects.toThrow(/无工作区顶层|未找到 \.git 标记/);
      // rev 模式仍读 bare 自身的对象库，而不是父工作区。
      const files = await adapter.listFiles(sha);
      expect(files).toContain("bare-only.txt");
      expect(files).not.toContain("src/parse.ts");
    } finally {
      parent.cleanup();
      rmSync(workDir, { recursive: true, force: true });
    }
  });

  it("core.worktree 不能改变工作区限制根", async () => {
    const temp = await createTempRepo();
    const fakeWorktree = await mkdtemp(join(tmpdir(), "code-review-agent-fake-worktree-"));
    try {
      await writeFile(join(fakeWorktree, "fake-only.ts"), "FAKE_ROOT_SENTINEL\n", "utf8");
      // git 会遵循 core.worktree（非 bare 仓库同样生效），能把工作区指向仓库外；
      // 本用例只验证工作区文件读取根来自文件系统遍历，diff/grep 的重定向见下一用例。
      const fakePath = fakeWorktree.replaceAll("\\", "/");
      await writeFile(
        join(temp.repoPath, ".git", "config"),
        `[core]\n\tworktree = ${fakePath}\n`,
        { flag: "a" },
      );

      const [readFile] = createContextTools(new GitRepo(join(temp.repoPath, "src")), {
        kind: "worktree",
      });
      expect(String(await readFile.invoke({ path: "src/parse.ts" }))).toContain("divide");
      // 仅存在于伪 worktree 的文件不在真实根内，读取必须失败。
      await expect(readFile.invoke({ path: "fake-only.ts" })).rejects.toThrow();
    } finally {
      temp.cleanup();
      rmSync(fakeWorktree, { recursive: true, force: true });
    }
  });

  it("core.worktree 不能把工作区 diff 与 grep 重定向到仓库外", async () => {
    const temp = await createTempRepo();
    const outsideDir = await mkdtemp(join(tmpdir(), "code-review-agent-outside-worktree-"));
    try {
      await writeFile(join(temp.repoPath, "src", "config.ts"), "IN_REPO\n", "utf8");
      const setupGit = simpleGit(temp.repoPath);
      await setupGit.add(["-A"]);
      await setupGit.commit("add config");

      // 仓库外目录：同路径文件带唯一哨兵，另有一个仅存在于该目录的文件。
      await mkdir(join(outsideDir, "src"), { recursive: true });
      await writeFile(join(outsideDir, "src", "config.ts"), "OUTSIDE_CONFIG_SENTINEL\n", "utf8");
      await writeFile(join(outsideDir, "outside-only.txt"), "OUTSIDE_SENTINEL\n", "utf8");

      const outsidePath = outsideDir.replaceAll("\\", "/");
      await writeFile(
        join(temp.repoPath, ".git", "config"),
        `[core]\n\tworktree = ${outsidePath}\n`,
        { flag: "a" },
      );

      // 未修复时 git diff/grep 会读取被重定向的工作区，从而泄露仓库外文件内容。
      const adapter = new GitRepo(temp.repoPath);
      const diff = await adapter.getWorkingTreeDiff();
      expect(diff).not.toContain("OUTSIDE_CONFIG_SENTINEL");
      expect(diff).not.toContain("OUTSIDE_SENTINEL");
      const grepOut = await adapter.grepWorktree("OUTSIDE_CONFIG_SENTINEL");
      expect(grepOut).not.toContain("OUTSIDE_CONFIG_SENTINEL");

      // 正向护栏：真实工作区的未提交改动仍能被 diff 出来，证明 diff 读的是真实根而非伪 worktree。
      await writeFile(join(temp.repoPath, "src", "config.ts"), "REAL_UNCOMMITTED_CHANGE\n", "utf8");
      const realDiff = await adapter.getWorkingTreeDiff();
      expect(realDiff).toContain("REAL_UNCOMMITTED_CHANGE");
      expect(realDiff).not.toContain("OUTSIDE_CONFIG_SENTINEL");
    } finally {
      temp.cleanup();
      rmSync(outsideDir, { recursive: true, force: true });
    }
  });

  it("worktree 模式拒绝 .env 与 .git 敏感路径", async () => {
    const temp = await createTempRepo();
    try {
      await writeFile(join(temp.repoPath, ".env"), "SECRET=1\n", "utf8");
      const [readFile] = createContextTools(new GitRepo(temp.repoPath), { kind: "worktree" });
      await expect(readFile.invoke({ path: ".env" })).rejects.toThrow(/敏感路径/);
      await expect(readFile.invoke({ path: ".env.local" })).rejects.toThrow(/敏感路径/);
      await expect(readFile.invoke({ path: ".git/config" })).rejects.toThrow(/敏感路径/);
      // `./` 前缀不得绕过首段检查。
      await expect(readFile.invoke({ path: "./.git/config" })).rejects.toThrow(/敏感路径/);
    } finally {
      temp.cleanup();
    }
  });

  it("worktree 模式拒绝任意路径段的 .git 与 .env", async () => {
    const temp = await createTempRepo();
    try {
      const [readFile] = createContextTools(new GitRepo(temp.repoPath), { kind: "worktree" });
      // .git / .env 出现在中间段或作为目录段时，旧的首段/末段检查会漏过。
      await expect(readFile.invoke({ path: "vendor/x/.git/config" })).rejects.toThrow(/敏感路径/);
      await expect(readFile.invoke({ path: ".env/local" })).rejects.toThrow(/敏感路径/);
      await expect(readFile.invoke({ path: "a/.env.local/x" })).rejects.toThrow(/敏感路径/);
    } finally {
      temp.cleanup();
    }
  });

  it("worktree 模式按真实路径复查敏感目标", async (ctx) => {
    const temp = await createTempRepo();
    try {
      await writeFile(join(temp.repoPath, ".env"), "ENV_SENTINEL\n", "utf8");
      const [readFile] = createContextTools(new GitRepo(temp.repoPath), { kind: "worktree" });
      // 优先让普通文件名指向 .env；Windows 无文件符号链接权限时退回指向 .git 目录的 junction。
      let readPath: string | null = null;
      try {
        await symlink(join(temp.repoPath, ".env"), join(temp.repoPath, "alias.txt"), "file");
        readPath = "alias.txt";
      } catch {
        try {
          await symlink(join(temp.repoPath, ".git"), join(temp.repoPath, "alias-git"), "junction");
          readPath = "alias-git/config";
        } catch {
          readPath = null;
        }
      }
      if (readPath) {
        await expect(readFile.invoke({ path: readPath })).rejects.toThrow(/敏感路径/);
      } else {
        // 两种链接均不可用：退化为验证 `./` 前缀拒绝。
        await expect(readFile.invoke({ path: "./.git/config" })).rejects.toThrow(/敏感路径/);
        ctx.skip();
      }
    } finally {
      temp.cleanup();
    }
  });
});

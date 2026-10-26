# Code Review Agent 实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 构建一个可运行的 TypeScript + LangGraph 代码审查 Agent，从本地 git 变更出发，经「候选发现→逐条复核→分级→报告」产出规范 Markdown 审查报告。

**Architecture:** LangGraph `StateGraph` 编排 4 个节点（parse → discover → verify → report）。discover/verify 是带工具调用的 LLM 环节（候选发现与复核两阶段），模型通过 `@langchain/openai` 指向 DeepSeek。核心逻辑只依赖通用 LangChain 类型（`ChatModel`/`StructuredTool`）与平台无关的 `ChangeSet` 模型，与供应商/平台解耦。

**Tech Stack:** Node 22 · pnpm · TypeScript 5.9（ESM）· `@langchain/langgraph@^1.5` · `@langchain/core@^1.3` · `@langchain/openai@^1.7` · `zod@^3.25` · `simple-git@^4` · `vitest@^5` · `tsx@^4` · `dotenv@^18`

**Spec:** `docs/superpowers/specs/2026-10-26-code-review-agent-design.md`

## Global Constraints

- 依赖版本下限：`@langchain/langgraph@^1.5.2`、`@langchain/core@^1.3.0`、`@langchain/openai@^1.7.0`、`zod@^3.25.76`、`simple-git@^4.0.2`、`vitest@^5.0.5`、`tsx@^4.23.15`、`typescript@^5.9.3`、`dotenv@^18.0.9`。
- `"type": "module"`（ESM）。所有源码用 `import`/`export`。
- API key 只从环境变量 `DEEPSEEK_API_KEY` 读取，绝不硬编码、绝不写入仓库。
- 默认模型 `deepseek-chat`，默认 `baseURL = "https://api.deepseek.com"`。
- 核心审查逻辑不得出现 GitHub/GitLab/Gitea 专有字段；平台数据先转成 `ChangeSet`。
- 误报为底线：证据不足标「待确认」，绝不编造问题。
- 每个 commit 消息以 `Co-Authored-By: Claude Code <noreply@anthropic.com>` 结尾。

## Review Focus

以下 5 类输入/失败模式最可能在真实使用中咬人，逐一在对应任务加测试钉死：

1. **空/纯空白 diff** → 报告「未发现明确问题」而非崩溃或输出空报告。→ Task 2（`parseDiff("")` 返回 `files: []`）+ Task 7（空 ChangeSet 跑图 → `no_issues`）。
2. **二进制文件进入 diff** → 跳过该文件，不当作文本解析。→ Task 2（`parseDiff` 遇 `GIT binary patch` 跳过）。
3. **删除文件的行号** → 删除行 `newLine` 为 `null`，不得产出非法 `line`。→ Task 2。
4. **模型输出解析失败（畸形 JSON）** → 捕获并降级为「无法充分审查」状态，不抛异常。→ Task 4（FakeModel 返回畸形输出 → 引擎返回空列表或抛出可捕获错误，图仍完成）。
5. **缺少 API key** → 在发起任何网络调用前抛出清晰中文错误。→ Task 1（`loadConfig` 对缺失 key 抛错）。

---

## File Structure

```
code-review-agent/
  package.json / tsconfig.json / vitest.config.ts / .gitignore / .env.example
  src/
    config.ts                 # 配置加载（zod + env）
    index.ts                  # CLI 入口
    core/
      state.ts                # ReviewState（Annotation.Root）
      graph.ts                # buildReviewGraph + 4 个节点
    llm/
      adapter.ts              # createReviewModel（ChatOpenAI→DeepSeek）
      schemas.ts              # Severity/Category/Candidate/Verification/Finding
    repository/
      adapter.ts              # RepoAccess/RepositoryAdapter/GitRepositoryAdapter
      diff.ts                 # ChangeSet 模型 + parseDiff
    tools/
      context-tools.ts        # createContextTools（read_file/grep/…）
    review/
      engine.ts               # discoverCandidates / verifyCandidates + 工具循环
      grade.ts                # finalizeFindings / dedupeFindings / sortFindings
    report/
      generator.ts            # renderReport
    platform/
      types.ts                # PlatformAdapter 接口（Phase 1 仅类型）
  tests/
    helpers/
      temp-repo.ts            # 生成临时 git 仓库（含预埋 bug）
      fake-model.ts           # 确定性假模型
    config.test.ts / diff.test.ts / adapter.test.ts / context-tools.test.ts /
    engine.test.ts / grade.test.ts / report.test.ts / graph.test.ts
```

---

### Task 1: 脚手架 + 配置模块

**Files:**
- Create: `package.json`、`tsconfig.json`、`vitest.config.ts`、`.gitignore`、`.env.example`、`src/config.ts`
- Test: `tests/config.test.ts`

**Interfaces:**
- Produces: `Config`、`ConfigSchema`、`loadConfig(env?: NodeJS.ProcessEnv): Config`

- [ ] **Step 1: 写失败测试 `tests/config.test.ts`**

```ts
import { describe, it, expect } from "vitest";
import { loadConfig, ConfigSchema } from "../src/config.js";

describe("loadConfig", () => {
  it("用默认值填充 model 和 baseURL", () => {
    const cfg = loadConfig({ DEEPSEEK_API_KEY: "sk-test" });
    expect(cfg.model).toBe("deepseek-chat");
    expect(cfg.baseURL).toBe("https://api.deepseek.com");
    expect(cfg.maxToolSteps).toBe(8);
    expect(cfg.maxFilesPerBatch).toBe(20);
  });

  it("允许覆盖 model 与 baseURL", () => {
    const cfg = loadConfig({ DEEPSEEK_API_KEY: "sk-test", REVIEW_MODEL: "deepseek-reasoner", REVIEW_BASE_URL: "https://x" });
    expect(cfg.model).toBe("deepseek-reasoner");
    expect(cfg.baseURL).toBe("https://x");
  });

  it("缺少 DEEPSEEK_API_KEY 时抛出含提示的错误", () => {
    expect(() => loadConfig({})).toThrow(/DEEPSEEK_API_KEY/);
  });

  it("非法 maxToolSteps 被拒绝", () => {
    expect(() => ConfigSchema.parse({ apiKey: "k", maxToolSteps: 0 })).toThrow();
  });
});
```

- [ ] **Step 2: 运行确认失败**

Run: `pnpm vitest run tests/config.test.ts`
Expected: FAIL（`loadConfig` 未定义 / 模块不存在）

- [ ] **Step 3: 创建脚手架文件并实现 `src/config.ts`**

`package.json` scripts：`test=vitest run`、`test:watch=vitest`、`typecheck=tsc --noEmit`、`dev=tsx src/index.ts`、`build=tsc`。`"type":"module"`。devDeps 装 `typescript@^5.9.3`、`vitest@^5.0.5`、`tsx@^4.23.15`、`@types/node@^22`；deps 装 `@langchain/langgraph@^1.5.2`、`@langchain/core@^1.3.0`、`@langchain/openai@^1.7.0`、`zod@^3.25.76`、`simple-git@^4.0.2`、`dotenv@^18.0.9`。

`loadConfig`：`apiKey = env.DEEPSEEK_API_KEY`（缺失即抛错），`model = env.REVIEW_MODEL ?? "deepseek-chat"`，`baseURL = env.REVIEW_BASE_URL ?? "https://api.deepseek.com"`，`maxToolSteps`/`maxFilesPerBatch` 从 `env` 解析、默认 8/20。`tsconfig.json` 用 `module=NodeNext`、`target=ES2022`、`strict=true`。`.gitignore` 忽略 `node_modules/`、`dist/`、`.env`。`.env.example` 写三个键名。

- [ ] **Step 4: 运行确认通过**

Run: `pnpm vitest run tests/config.test.ts`
Expected: PASS（4 个用例全绿）

- [ ] **Step 5: 初始化 git 并提交**

```bash
cd code-review-agent && git init
git add -A
git commit -m "chore: scaffold project and config module" -m "Co-Authored-By: Claude Code <noreply@anthropic.com>"
```

---

### Task 2: Repository Adapter + Diff 解析

**Files:**
- Create: `src/repository/diff.ts`、`src/repository/adapter.ts`、`tests/helpers/temp-repo.ts`
- Test: `tests/diff.test.ts`、`tests/adapter.test.ts`

**Interfaces:**
- Consumes: `zod`（Task 1）
- Produces: `ChangeSet`、`FileChange`、`Hunk`、`DiffLine`、`parseDiff(diffText, base?, head?): ChangeSet`；`RepoAccess`、`RepositoryAdapter`、`GitRepositoryAdapter`（`constructor(repoPath: string)`）

- [ ] **Step 1: 写失败测试 `tests/diff.test.ts`**

```ts
import { describe, it, expect } from "vitest";
import { parseDiff } from "../src/repository/diff.js";

const SAMPLE = `diff --git a/src/parse.ts b/src/parse.ts
index 111..222 100644
--- a/src/parse.ts
+++ b/src/parse.ts
@@ -1,4 +1,4 @@
 export function divide(a, b) {
-  return a / b;
+  if (b === 0) throw new Error("div by zero");
+  return a / b;
 }
`;

describe("parseDiff", () => {
  it("解析新增/删除行及其行号", () => {
    const cs = parseDiff(SAMPLE);
    expect(cs.files).toHaveLength(1);
    const f = cs.files[0];
    expect(f.path).toBe("src/parse.ts");
    expect(f.status).toBe("modified");
    const del = f.hunks[0].lines.find((l) => l.type === "del");
    const add = f.hunks[0].lines.find((l) => l.type === "add");
    expect(del!.oldLine).toBe(2);
    expect(del!.newLine).toBeNull();
    expect(add!.newLine).toBe(3);
  });

  it("空 diff 返回空 files", () => {
    expect(parseDiff("").files).toEqual([]);
  });

  it("跳过二进制文件", () => {
    const cs = parseDiff(`diff --git a/x.png b/x.png\nGIT binary patch\nliteral 10\n`);
    expect(cs.files).toHaveLength(0);
  });

  it("识别重命名（a/old b/new 且 oldPath≠path）", () => {
    const cs = parseDiff(`diff --git a/a.ts b/b.ts\nsimilarity index 100%\nrename from a.ts\nrename to b.ts\n`);
    expect(cs.files[0].status).toBe("renamed");
    expect(cs.files[0].oldPath).toBe("a.ts");
  });

  it("删除文件 status=deleted", () => {
    const cs = parseDiff(`diff --git a/gone.ts b/gone.ts\ndeleted file mode 100644\n--- a/gone.ts\n+++ /dev/null\n@@ -1 +0,0 @@\n-old\n`);
    expect(cs.files[0].status).toBe("deleted");
  });
});
```

- [ ] **Step 2: 写失败测试 `tests/adapter.test.ts`**（含 `tests/helpers/temp-repo.ts` 辅助）

`temp-repo.ts` 用 `simple-git` 在 `os.tmpdir()` 下建临时目录，写入一个含预埋 bug 的 `src/parse.ts`（`return a / b` 未判零）并 `git init` + `commit`，返回 `{ repoPath, headCommit, cleanup }`。

```ts
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { GitRepositoryAdapter } from "../src/repository/adapter.js";
import { createTempRepo } from "./helpers/temp-repo.js";

let repo: { repoPath: string; headCommit: string; cleanup: () => void };

describe("GitRepositoryAdapter", () => {
  beforeAll(async () => { repo = await createTempRepo(); });
  afterAll(() => repo.cleanup());

  it("getCommitDiff 返回首个提交的 diff 且含 src/parse.ts", async () => {
    const a = new GitRepositoryAdapter(repo.repoPath);
    const diff = await a.getCommitDiff(repo.headCommit);
    expect(diff).toContain("src/parse.ts");
  });

  it("readFile 能按 rev 读历史文件，grep 能命中", async () => {
    const a = new GitRepositoryAdapter(repo.repoPath);
    const text = await a.readFile("src/parse.ts");
    expect(text).toContain("divide");
    expect(await a.grep("divide")).toContain("src/parse.ts");
    expect(await a.listFiles()).toContain("src/parse.ts");
  });
});
```

- [ ] **Step 3: 运行确认失败**

Run: `pnpm vitest run tests/diff.test.ts tests/adapter.test.ts`
Expected: FAIL（模块不存在）

- [ ] **Step 4: 实现 `src/repository/diff.ts` 与 `src/repository/adapter.ts`**

`diff.ts`：`DiffLine`/`Hunk`/`FileChange`/`ChangeSet` 的 zod schema + 纯函数 `parseDiff`。解析规则：`diff --git a/X b/Y` 开始一个新文件；`X !== Y` 且出现 `rename` 头 → `renamed`；`deleted file mode` → `deleted`；`new file mode` → `added`；`@@ -a,b +c,d @@` 取 `c` 作为 `newStartLine`；行前缀 `+`→add、`-`→del、` `→context，`oldLine`/`newLine` 分别按 hunk 递增，删除行 `newLine=null`、新增行 `oldLine=null`；遇 `GIT binary patch`/`Binary files ... differ` 跳过整个文件。

`adapter.ts`：`RepoAccess`（`readFile(path,rev?)`、`grep(pattern,rev?)`、`listFiles(rev?)`）、`RepositoryAdapter extends RepoAccess`（`getWorkingTreeDiff()`、`getCommitDiff(sha)`、`getBranchDiff(branch, base?)`、`gitLog()`）。`GitRepositoryAdapter` 用 `simple-git(repoPath)`：`readFile` → `git show rev:path`（缺省 `HEAD`）；`grep` → `git grep -n pattern rev --`（缺省 `HEAD`）；`listFiles` → `git ls-files`；`getWorkingTreeDiff` → `git diff HEAD`；`getCommitDiff` → `git show --format= sha`；`getBranchDiff` → 先 `merge-base(base ?? "main", branch)` 再 `git diff mergeBase..branch`。

- [ ] **Step 5: 运行确认通过**

Run: `pnpm vitest run tests/diff.test.ts tests/adapter.test.ts`
Expected: PASS

- [ ] **Step 6: 提交**

```bash
git add -A && git commit -m "feat: repository adapter and diff parser" -m "Co-Authored-By: Claude Code <noreply@anthropic.com>"
```

---

### Task 3: Context Tools（函数调用工具）

**Files:**
- Create: `src/tools/context-tools.ts`
- Test: `tests/context-tools.test.ts`

**Interfaces:**
- Consumes: `RepoAccess`（Task 2）、`tool` from `@langchain/core/tools`
- Produces: `createContextTools(repo: RepoAccess): StructuredTool[]`，工具名：`read_file`、`read_file_range`、`grep`、`list_files`、`read_related_test`

- [ ] **Step 1: 写失败测试 `tests/context-tools.test.ts`**

```ts
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createContextTools } from "../src/tools/context-tools.js";
import { createTempRepo } from "./helpers/temp-repo.js";

let repo: Awaited<ReturnType<typeof createTempRepo>>;

describe("createContextTools", () => {
  beforeAll(async () => { repo = await createTempRepo(); });
  afterAll(() => repo.cleanup());

  it("read_file 返回文件内容", async () => {
    const [readFile] = createContextTools(new GitRepo(repo.repoPath));
    const out = await readFile.invoke({ path: "src/parse.ts" });
    expect(String(out)).toContain("divide");
  });

  it("grep 命中返回行内容", async () => {
    const tools = createContextTools(new GitRepo(repo.repoPath));
    const grep = tools.find((t) => t.name === "grep")!;
    expect(String(await grep.invoke({ pattern: "divide" }))).toContain("src/parse.ts");
  });

  it("read_related_test 找不到测试文件时返回提示串", async () => {
    const tools = createContextTools(new GitRepo(repo.repoPath));
    const rt = tools.find((t) => t.name === "read_related_test")!;
    expect(String(await rt.invoke({ path: "src/parse.ts" }))).toMatch(/未找到|no test/i);
  });
});
```

（`GitRepo` 即 Task 2 的 `GitRepositoryAdapter`，测试里用别名 import。）

- [ ] **Step 2: 运行确认失败**

Run: `pnpm vitest run tests/context-tools.test.ts`
Expected: FAIL

- [ ] **Step 3: 实现 `src/tools/context-tools.ts`**

用 `tool(fn, { name, description, schema })` 建 5 个工具：`read_file({path})` → `repo.readFile(path)`；`read_file_range({path,startLine,endLine})` → 读后按行切片；`grep({pattern})` → `repo.grep(pattern)`；`list_files()` → `repo.listFiles().join("\n")`；`read_related_test({path})` → 在同目录找 `*.test.ts`/`*.spec.ts` 或 `__tests__/`，命中则读，否则返回「未找到对应测试文件」。

- [ ] **Step 4: 运行确认通过**

Run: `pnpm vitest run tests/context-tools.test.ts`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add -A && git commit -m "feat: context tools for on-demand source reading" -m "Co-Authored-By: Claude Code <noreply@anthropic.com>"
```

---

### Task 4: LLM Adapter + Review Engine（两阶段）

**Files:**
- Create: `src/llm/adapter.ts`、`src/llm/schemas.ts`、`src/review/engine.ts`、`tests/helpers/fake-model.ts`
- Test: `tests/engine.test.ts`

**Interfaces:**
- Consumes: `Config`（Task 1）、`ChangeSet`（Task 2）、`tool`/`StructuredTool`（Task 3）
- Produces: `Severity`、`Category`、`Candidate`、`VerificationResult`、`Finding`、`CandidateListSchema`、`VerificationListSchema`；`createReviewModel(config: Config): ChatOpenAI`；`EngineDeps = { model; tools; maxToolSteps }`；`discoverCandidates(deps, changeSet): Promise<Candidate[]>`；`verifyCandidates(deps, candidates, changeSet): Promise<VerificationResult[]>`；`DISCOVER_PROMPT`、`VERIFY_PROMPT`

- [ ] **Step 1: 写失败测试 `tests/engine.test.ts`**

`tests/helpers/fake-model.ts` 提供一个假模型：`bindTools()` 返回自身；`invoke()` 返回无 `tool_calls` 的 `AIMessage`；`withStructuredOutput(schema)` 返回 `{ invoke: async () => 脚本结果 }`，脚本由测试构造时注入（发现阶段返回 `{ findings: [candidate] }`，复核阶段返回 `{ verifications: [...] }`）。假模型构造时不发起任何网络。

```ts
import { describe, it, expect } from "vitest";
import { discoverCandidates, verifyCandidates } from "../src/review/engine.js";
import { makeFakeModel } from "./helpers/fake-model.js";
import { parseDiff } from "../src/repository/diff.js";
import type { Candidate, VerificationResult } from "../src/llm/schemas.js";

const diff = parseDiff(`diff --git a/src/parse.ts b/src/parse.ts
--- a/src/parse.ts
+++ b/src/parse.ts
@@ -1,2 +1,2 @@
 export function divide(a, b) {
-  return a / b;
+  return a / b;
 }
`);

const candidate: Candidate = { id: "c1", title: "除零未检查", severity: "P2", file: "src/parse.ts", line: 2, category: "correctness", description: "…", trigger: "…", impact: "…", suggestion: "…" };
const verification: VerificationResult = { id: "c1", verdict: "confirmed", severity: "P2", confidence: "high", evidence: "diff 显示 / b", reason: "…" };

describe("engine", () => {
  it("discoverCandidates 返回结构化候选", async () => {
    const model = makeFakeModel({ findings: [candidate] }, []);
    const out = await discoverCandidates({ model: model as any, tools: [], maxToolSteps: 2 }, diff);
    expect(out).toEqual([candidate]);
  });

  it("verifyCandidates 返回复核结果", async () => {
    const model = makeFakeModel({}, [{ ...verification }]);
    const out = await verifyCandidates({ model: model as any, tools: [], maxToolSteps: 2 }, [candidate], diff);
    expect(out).toEqual([verification]);
  });

  it("模型返回畸形输出时降级为空列表而非抛异常", async () => {
    const model = makeFakeModel(new Error("bad json"), []);
    const out = await discoverCandidates({ model: model as any, tools: [], maxToolSteps: 2 }, diff);
    expect(out).toEqual([]);
  });
});
```

- [ ] **Step 2: 运行确认失败**

Run: `pnpm vitest run tests/engine.test.ts`
Expected: FAIL

- [ ] **Step 3: 实现 `src/llm/schemas.ts`、`src/llm/adapter.ts`、`src/review/engine.ts`**

`schemas.ts`：`Severity = z.enum(["P0","P1","P2","P3"])`、`Category = z.enum(["correctness","security","performance","concurrency","compatibility","testing"])`、`Candidate`（id/title/severity/file/line/category/description/trigger/impact/suggestion）、`CandidateListSchema = { findings: z.array(Candidate) }`、`VerificationResult`（id/verdict∈{confirmed,downgraded,rejected}/severity/confidence∈{high,medium,low}/evidence/reason）、`VerificationListSchema = { verifications: z.array(VerificationResult) }`、`Finding = Candidate.extend({ confidence, evidence })`。

`adapter.ts`：`createReviewModel(config)` 返回 `new ChatOpenAI({ model: config.model, apiKey: config.apiKey, configuration: { baseURL: config.baseURL }, temperature: 0 })`。

`engine.ts` 核心是「工具调用循环 + 结构化抽取」，算法如下（发现与复核共用，仅 schema/prompt 不同）：

```ts
async function runWithTools(model, tools, systemPrompt, userPrompt, maxSteps, outSchema, outKey) {
  const bound = model.bindTools(tools);
  const messages = [new SystemMessage(systemPrompt), new HumanMessage(userPrompt)];
  let current = messages;
  for (let i = 0; i < maxSteps; i++) {
    const resp = await bound.invoke(current);
    if (!resp.tool_calls || resp.tool_calls.length === 0) { current = [...current, resp]; break; }
    const toolMessages = await executeToolCalls(resp.tool_calls, tools);
    current = [...current, resp, ...toolMessages];
  }
  try {
    const out = await model.withStructuredOutput(outSchema).invoke([...current, new HumanMessage("请输出结构化结果")]);
    return out[outKey] ?? [];
  } catch {
    return [];   // 畸形输出：降级为空，不抛异常
  }
}
```

`executeToolCalls` 按 `tool_calls[].name` 匹配 `tools`，调用 `.invoke(args)`，返回 `ToolMessage[]`（`tool_call_id` 对应）。`discoverCandidates` 用 `DISCOVER_PROMPT`（TS/JS 优先的审查者角色 + 变更范围 + 需按需调用工具）+ `CandidateListSchema`；`verifyCandidates` 对每个 candidate 用 `VERIFY_PROMPT`（给定候选 + 取证要求）逐条调用 `runWithTools`，收集 `verifications`。

- [ ] **Step 4: 运行确认通过**

Run: `pnpm vitest run tests/engine.test.ts`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add -A && git commit -m "feat: review engine with two-phase tool-calling" -m "Co-Authored-By: Claude Code <noreply@anthropic.com>"
```

---

### Task 5: 分级 + 去重

**Files:**
- Create: `src/review/grade.ts`
- Test: `tests/grade.test.ts`

**Interfaces:**
- Consumes: `Candidate`、`VerificationResult`、`Finding`（Task 4）
- Produces: `finalizeFindings(candidates, verifications): Finding[]`、`dedupeFindings(findings): Finding[]`、`sortFindings(findings): Finding[]`

- [ ] **Step 1: 写失败测试 `tests/grade.test.ts`**

```ts
import { describe, it, expect } from "vitest";
import { finalizeFindings, dedupeFindings, sortFindings } from "../src/review/grade.js";

const c = (id: string, severity: string, file = "a.ts", line = 1) => ({ id, title: id, severity, file, line, category: "correctness", description: "d", trigger: "t", impact: "i", suggestion: "s" }) as any;

describe("finalizeFindings", () => {
  it("confirmed 保留并带 evidence；rejected 丢弃；downgraded 降级", () => {
    const cands = [c("a", "P1"), c("b", "P2"), c("c", "P3")];
    const vers = [
      { id: "a", verdict: "confirmed", severity: "P1", confidence: "high", evidence: "e1", reason: "r" },
      { id: "b", verdict: "rejected", severity: "P2", confidence: "low", evidence: "e2", reason: "r" },
      { id: "c", verdict: "downgraded", severity: "P3", confidence: "medium", evidence: "e3", reason: "r" },
    ];
    const out = finalizeFindings(cands, vers as any);
    expect(out.map((f) => f.id).sort()).toEqual(["a", "c"]);
    expect(out.find((f) => f.id === "a")!.evidence).toBe("e1");
  });

  it("无对应 verification 的 candidate 被丢弃", () => {
    expect(finalizeFindings([c("x", "P1")], [])).toEqual([]);
  });
});

describe("sortFindings", () => {
  it("按 P0→P3 排序，同级按 file 再 line", () => {
    const out = sortFindings([c("a", "P3", "a.ts", 2), c("b", "P0", "b.ts", 1), c("d", "P3", "a.ts", 1)]);
    expect(out.map((f) => f.id)).toEqual(["b", "d", "a"]);
  });
});

describe("dedupeFindings", () => {
  it("同 file+line+category 只留一条", () => {
    const out = dedupeFindings([c("a", "P2", "x.ts", 3), c("b", "P1", "x.ts", 3)]);
    expect(out).toHaveLength(1);
  });
});
```

- [ ] **Step 2: 运行确认失败**

Run: `pnpm vitest run tests/grade.test.ts`
Expected: FAIL

- [ ] **Step 3: 实现 `src/review/grade.ts`**

`finalizeFindings`：按 id 匹配；`confirmed`→保留 verification 的 severity/confidence/evidence；`downgraded`→保留 verification 的 severity，confidence 上限 medium；`rejected`→丢弃；无匹配→丢弃。`sortFindings`：severity 权重 P0=0…P3=3 升序，再 `file`、再 `line`。`dedupeFindings`：按 `file|line|category` 去重，保留 severity 更高者。

- [ ] **Step 4: 运行确认通过**

Run: `pnpm vitest run tests/grade.test.ts`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add -A && git commit -m "feat: severity grading and dedup" -m "Co-Authored-By: Claude Code <noreply@anthropic.com>"
```

---

### Task 6: Report Generator

**Files:**
- Create: `src/report/generator.ts`
- Test: `tests/report.test.ts`

**Interfaces:**
- Consumes: `Finding`（Task 4）
- Produces: `renderReport(findings: Finding[], scope: string, limitations: string[]): string`

- [ ] **Step 1: 写失败测试 `tests/report.test.ts`**

```ts
import { describe, it, expect } from "vitest";
import { renderReport } from "../src/report/generator.js";

const f = (over = {}) => ({ id: "c1", title: "除零", severity: "P2", file: "src/parse.ts", line: 2, category: "correctness", description: "d", trigger: "t", impact: "i", suggestion: "s", confidence: "high", evidence: "e", ...over }) as any;

describe("renderReport", () => {
  it("含标题、摘要、问题详情三段", () => {
    const md = renderReport([f()], "commit abc", ["未接真实平台"]);
    expect(md).toContain("# Code Review Report");
    expect(md).toContain("## 1. 审查摘要");
    expect(md).toContain("## 2. 问题详情");
    expect(md).toContain("## 3. 总结与后续建议");
    expect(md).toContain("### [P2] 除零");
    expect(md).toContain("`src/parse.ts`");
  });

  it("无问题时如实报告未发现", () => {
    const md = renderReport([], "commit abc", []);
    expect(md).toContain("未发现明确问题");
    expect(md).not.toContain("### [P");
  });

  it("P0/P1 给出阻止/修复后合并结论", () => {
    const md = renderReport([f({ severity: "P1" })], "s", []);
    expect(md).toContain("修复后合并");
  });
});
```

- [ ] **Step 2: 运行确认失败**

Run: `pnpm vitest run tests/report.test.ts`
Expected: FAIL

- [ ] **Step 3: 实现 `src/report/generator.ts`**

`renderReport` 生成 Markdown：摘要段（状态=发现问题/未发现明确问题；总体建议=有 P0→「建议阻止合并」、有 P1→「修复后合并」、仅有 P2/P3→「可合并但建议改进」、无问题→「可合并」；P0-P3 统计；范围 + 限制列表）；问题详情段（每个 finding 一条 `### [Px] 标题`，含 文件/代码位置/问题类型/描述/触发条件/影响分析/修复建议/置信度）；总结段（优先项、建议测试、人工确认）。文件路径用反引号包裹。

- [ ] **Step 4: 运行确认通过**

Run: `pnpm vitest run tests/report.test.ts`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add -A && git commit -m "feat: markdown report generator" -m "Co-Authored-By: Claude Code <noreply@anthropic.com>"
```

---

### Task 7: Agent Core（StateGraph）+ CLI

**Files:**
- Create: `src/core/state.ts`、`src/core/graph.ts`、`src/index.ts`、`src/platform/types.ts`
- Test: `tests/graph.test.ts`

**Interfaces:**
- Consumes: 全部 Task 2–6 产物
- Produces: `ReviewState`、`buildReviewGraph(deps: AgentDeps): CompiledStateGraph<...>`、`AgentDeps = { model; toolsFactory; repoFactory; maxToolSteps; maxFilesPerBatch }`、`PlatformAdapter`（类型）

- [ ] **Step 1: 写失败测试 `tests/graph.test.ts`**

```ts
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { buildReviewGraph } from "../src/core/graph.js";
import { GitRepositoryAdapter } from "../src/repository/adapter.js";
import { createContextTools } from "../src/tools/context-tools.js";
import { makeFakeModel } from "./helpers/fake-model.js";
import { createTempRepo } from "./helpers/temp-repo.js";

let repo: Awaited<ReturnType<typeof createTempRepo>>;

describe("buildReviewGraph", () => {
  beforeAll(async () => { repo = await createTempRepo(); });
  afterAll(() => repo.cleanup());

  it("空变更产出未发现问题的报告", async () => {
    const model = makeFakeModel({ findings: [] }, []);
    const graph = buildReviewGraph({ model: model as any, toolsFactory: createContextTools, repoFactory: (p) => new GitRepositoryAdapter(p), maxToolSteps: 2, maxFilesPerBatch: 20 });
    // repo 无未提交变更 → changeSet.files 为空
    const out = await graph.invoke({ repoPath: repo.repoPath, range: "diff", ref: null, base: null });
    expect(out.report).toContain("未发现明确问题");
  });

  it("发现的问题进入报告并带分级", async () => {
    const model = makeFakeModel({ findings: [candidate] }, [verification]);
    const graph = buildReviewGraph({ model: model as any, toolsFactory: createContextTools, repoFactory: (p) => new GitRepositoryAdapter(p), maxToolSteps: 2, maxFilesPerBatch: 20 });
    const out = await graph.invoke({ repoPath: repo.repoPath, range: "commit", ref: repo.headCommit, base: null });
    expect(out.report).toContain("### [P2]");
    expect(out.report).toContain("src/parse.ts");
  });
});
```

（`candidate`/`verification` 与 Task 4 相同，测试里内联定义。）

- [ ] **Step 2: 运行确认失败**

Run: `pnpm vitest run tests/graph.test.ts`
Expected: FAIL

- [ ] **Step 3: 实现 `src/core/state.ts`、`src/core/graph.ts`、`src/index.ts`、`src/platform/types.ts`**

`state.ts`：`ReviewState = Annotation.Root({ repoPath, range: Annotation<"diff"|"commit"|"branch">, ref, base, changeSet: Annotation<ChangeSet|null>, candidates: Annotation<Candidate[]>, findings: Annotation<Finding[]>, report: Annotation<string|null> })`，各字段用 last-write-wins（默认 reducer，可空字段 `reducer: (a,b) => b ?? a`）。

`graph.ts`：`parse` 节点按 `range` 调 `repo.getWorkingTreeDiff()/getCommitDiff(ref)/getBranchDiff(ref, base)`，`parseDiff` 得 `changeSet`；`discover` 节点建 `repo = repoFactory(repoPath)` + `tools = toolsFactory(repo)`，若 `changeSet.files.length > maxFilesPerBatch` 则分批调 `discoverCandidates` 后合并，否则整体调用；`verify` 节点逐条 `verifyCandidates`；`report` 节点调 `finalizeFindings`→`dedupeFindings`→`sortFindings`→`renderReport`。边：`START→parse→discover→verify→report→END`。

`index.ts`：`dotenv.config()` 后解析 argv（`diff [--base]`、`commit <sha>`、`branch <name> [--base]`，`--repo` 默认 `process.cwd()`），`loadConfig`（缺失 key 时打印中文错误并 `exit(1)`），组装 model/toolsFactory/repoFactory，`buildReviewGraph`，`invoke`，打印 `state.report`。

`platform/types.ts`：`interface PlatformAdapter { postReviewComment(reviewId: string, body: string): Promise<void> }`，仅类型，附注释「Phase 1 不实现；GitHub/GitLab/Gitea 适配器后续在此扩展」。

- [ ] **Step 4: 运行确认通过**

Run: `pnpm vitest run tests/graph.test.ts`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add -A && git commit -m "feat: assemble langgraph agent and CLI" -m "Co-Authored-By: Claude Code <noreply@anthropic.com>"
```

---

### Task 8: README + 全量验证

**Files:**
- Create: `README.md`
- Modify: `package.json`（无需，若漏则补）

**Interfaces:**
- Consumes: 全部
- Produces: 使用文档

- [ ] **Step 1: 写 README（启动、配置、示例、扩展点、限制）**

包含：安装（`pnpm install`）、配置（`cp .env.example .env` 填 `DEEPSEEK_API_KEY`）、三种入口用法与示例、报告示例、架构模块表（对应设计文档 7 模块）、扩展 GitHub/GitLab/Gitea 的接口位置、当前限制（未接真实平台写评论、mock 测试不触发真实模型）。

- [ ] **Step 2: 运行全量测试与类型检查**

Run: `pnpm test && pnpm typecheck`
Expected: 全部 PASS，`tsc --noEmit` 无错误

- [ ] **Step 3: 提交**

```bash
git add -A && git commit -m "docs: usage and extension points" -m "Co-Authored-By: Claude Code <noreply@anthropic.com>"
```

---

### Task 9: 真实端到端验证（需 DeepSeek key，人工核对）

**Files:** 无新增

- [ ] **Step 1: 准备真实仓库**：在 `code-review-agent` 之外的临时目录 clone 或新建一个 TS 仓库，制造一次未提交变更（引入一个真实缺陷，例如去掉一个空值判断）。

- [ ] **Step 2: 运行**：`DEEPSEEK_API_KEY=<key> pnpm dev -- diff --repo <path>`

- [ ] **Step 3: 人工核对**：报告是否命中该缺陷、分级是否合理、有无编造。若 key 不可用，本任务标记「待验证」，不得声称已完成真实环境验证。

- [ ] **Step 4: 记录结果**：把输出与结论追加到 README 的「验证记录」小节，注明日期与是否通过。

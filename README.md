# Code Review Agent

一个面向本地 git 仓库的 AI 代码审查 Agent：读取变更 diff，先用 LLM 发现候选问题，再对每条候选逐一复核取证，最终输出 P0–P3 分级的 Markdown 审查报告。

审查不是「模型一次回答即结束」，而是**两阶段**：

```mermaid
flowchart LR
    A[解析变更<br/>parse] --> B[候选发现<br/>discover]
    B --> C[逐条复核<br/>verify]
    C --> D[渲染报告<br/>render]
    B -.->|按需调用| T[Context Tools<br/>read_file / grep / list_files ...]
    C -.->|按需调用| T
```

- **候选发现**：模型阅读 diff，按需调用工具补足上下文，产出可定位的候选问题（文件、行号、严重性、触发条件、修复建议）。
- **逐条复核**：模型对每条候选重新取证，判定 `confirmed` / `downgraded` / `rejected`，重新给出严重性与置信度。只有成立的问题进入报告。

## 安装

要求 Node 22 与 pnpm（项目使用 ESM）。

```bash
pnpm install
```

开发与验证命令：

```bash
pnpm dev        # 以 tsx 直接运行 CLI
pnpm test       # vitest 全量测试（确定性 fake 模型，不访问网络）
pnpm typecheck  # tsc --noEmit
pnpm build      # 编译到 dist/
```

## 配置

```bash
cp .env.example .env
```

在 `.env` 中填入 DeepSeek API Key：

```dotenv
DEEPSEEK_API_KEY=sk-xxxxxxxx
```

可选项（均有默认值，通常无需设置）：

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `DEEPSEEK_API_KEY` | 无（必填） | DeepSeek API Key；缺失时直接报配置错误退出 |
| `REVIEW_MODEL` | `deepseek-chat` | 模型名 |
| `REVIEW_BASE_URL` | `https://api.deepseek.com` | OpenAI 兼容端点；必须是 https 且不能内嵌用户名/密码 |
| `MAX_TOOL_STEPS` | `8` | 单个阶段（发现/每条复核）允许的工具调用轮数上限 |
| `MAX_FILES_PER_BATCH` | `20` | 单次送入模型的文件数上限，超出则按文件分批发现候选 |

**关于 `.env` 的读取位置（安全设计）**：`.env` 只从 **Agent 自身目录**（由 `src/index.ts` 所在位置经 `import.meta.url` 推导出的项目根目录）加载，**不会**从 `process.cwd()` 或 `--repo` 指向的被审仓库读取。这样即使被审仓库里投放了恶意 `.env`，也无法劫持 `DEEPSEEK_API_KEY` 或把请求改写到攻击者端点。因此请在 Agent 项目根目录放置 `.env`，而不是在被审仓库里。

## 使用

```text
用法：code-review-agent <diff|commit|branch> [ref] [--base <ref>] [--repo <path>]
```

| 命令 | 审查范围 | 说明 |
| --- | --- | --- |
| `diff` | 工作区未提交变更（`git diff HEAD`） | `--base` 仅作为元数据记录，不改变实际 diff 范围 |
| `commit <sha>` | 单个提交相对其父提交（`git show <sha>`） | 必须提供 commit sha；`--base` 对该命令无效 |
| `branch <name>` | `merge-base(base, name)..name` | `--base` 指定基准分支，默认 `main` |

`--repo <path>` 指定被审仓库路径，默认 `process.cwd()`。

### 示例

```bash
# 输入：在项目目录直接运行，审查当前工作区相对 HEAD 的未提交改动
pnpm dev diff
```

```bash
# 输入：审查另一个仓库的工作区改动
pnpm dev diff --repo ../my-app
```

```bash
# 输入：审查某个提交引入的改动（相对其父提交）
pnpm dev commit 3f2a9c1 --repo ../my-app
```

```bash
# 输入：审查 feature/login 分支相对 main 的改动
pnpm dev branch feature/login --base main --repo ../my-app
```

> 本项目脚本用 pnpm 调用：参数直接写在脚本名后（`pnpm dev diff`）。不要额外加 `--`——pnpm 8 会把 `--` 原样传给脚本，CLI 会把它当成未知命令并打印用法。若改用 npm，则需写成 `npm run dev -- diff`。

审查结果直接打印到标准输出。空 diff 会短路、不调用模型，报告为「未发现明确问题」。

### 失败兜底（fail-closed）

如果审查链路无法完成（网络、鉴权、模型输出无法解析等），报告会明确写明**「无法充分审查」**、总体建议为「需要补充信息」，并在问题详情中说明「审查未完成，本次结果不可作为合并依据」。它**不会**把失败渲染成「未发现明确问题」。

## 报告示例

```markdown
# Code Review Report

## 1. 审查摘要

- 审查状态：发现问题
- 总体建议：可合并但建议改进
- 问题统计：P0 0 个 / P1 0 个 / P2 1 个 / P3 0 个（共 1 个）
- 审查范围：工作区 diff
- 验证限制：
  - 未接入代码托管平台，仅本地 diff 审查

## 2. 问题详情

### [P2] divide 未处理除数为 0 的情况

- 文件：`src/parse.ts`
- 代码位置：`src/parse.ts:1`
- 问题类型：correctness
- 问题描述：divide() 在 b 为 0 时返回 Infinity，调用方未做校验。
- 触发条件：b === 0 时调用 divide
- 影响分析：下游计算得到 Infinity，可能导致展示或存储异常。
- 修复建议：在函数入口显式抛出错误或返回 Result 类型。
- 置信度：high
- 证据：src/parse.ts:1 `return a / b`，无除零分支。

## 3. 总结与后续建议

- 最需优先处理的问题：[P2] divide 未处理除数为 0 的情况（`src/parse.ts:1`）
- 建议补充的测试：建议为以下位置补充回归测试：`src/parse.ts:1`
- 需要人工确认的事项：无
```

严重性含义：P0 阻断、P1 严重、P2 一般、P3 轻微。报告总是包含「审查摘要 / 问题详情 / 总结与后续建议」三节；没有问题时如实输出「未发现明确问题」，不填充模板。

## 架构

| 模块 | 文件 | 职责 |
| --- | --- | --- |
| Agent Core | `src/core/graph.ts`、`src/core/state.ts` | LangGraph `StateGraph` 编排 `parse → discover → verify → render`，维护审查状态与失败兜底 |
| LLM Adapter | `src/llm/adapter.ts`（配套 `src/llm/schemas.ts`） | 用 `ChatOpenAI` 以 OpenAI 兼容协议调用 DeepSeek，温度 0；Zod schema 定义候选/复核/最终问题结构 |
| Repository Adapter | `src/repository/adapter.ts`、`src/repository/diff.ts` | `simple-git` 读取工作区/提交/分支 diff 与文件内容；把 unified diff 解析为平台无关的 `ChangeSet` |
| Context Tools | `src/tools/context-tools.ts` | 向模型暴露 `read_file`、`read_file_range`、`grep`、`list_files`、`read_related_test` 五个按需取证工具 |
| Review Engine | `src/review/engine.ts`（配套 `src/review/grade.ts`） | 两阶段提示词与工具调用循环；合并候选与复核结果、丢弃 rejected、去重与排序 |
| Report Generator | `src/report/generator.ts` | 把结构化结果渲染为三节式 Markdown 报告，转义自由文本中的 HTML 字符 |
| Platform Integration | `src/platform/types.ts` | 预留 `PlatformAdapter` 接口（`postReviewComment`），Phase 1 无实现 |

变更文件数超过 `MAX_FILES_PER_BATCH` 时会按批发现候选，并为每批候选 id 加 `b<批次>-` 前缀，避免跨批 id 冲突导致复核错配。

## 扩展点

### 接入 GitHub / GitLab / Gitea

- 在 `src/platform/types.ts` 的 `PlatformAdapter` 上实现 `postReviewComment(reviewId, body)`，各平台各自一个适配器。
- 平台侧数据（PR/MR 的变更）在适配器内转换为核心统一的 `ChangeSet`（定义见 `src/repository/diff.ts`），再交给 Agent Core；核心审查逻辑不应感知任何平台专有字段。
- 当前 `Phase 1` 只读、不发布评论，接口仅用于占位与解耦。

### 替换模型

- 修改 `src/llm/adapter.ts` 中的 `createReviewModel`，或通过 `REVIEW_MODEL` / `REVIEW_BASE_URL` 指向任意 OpenAI 兼容端点。
- 不更换供应商时只需改环境变量；更换协议时替换 `createReviewModel` 即可，`Review Engine` 只依赖 LangChain 的 `ChatOpenAI` 接口。

## 当前限制

- **只读**：不向任何代码托管平台写评论，不自动合并、不自动修改源码（无 auto-merge / auto-fix）。
- **仅本地 diff 审查**：未接入 GitHub/GitLab/Gitea 的 PR/MR 数据，报告中的「验证限制」会固定声明这一点。
- **测试不触发真实模型**：`pnpm test` 使用确定性的 fake 模型，覆盖流程、解析、复核合并与报告渲染，但不验证真实 LLM 的审查质量与网络行为。
- **语言范围**：提示词优先针对 TypeScript/JavaScript；其他语言可运行但效果未经验证。
- **diff 解析边界**：二进制文件会被跳过；路径含字面 ` b/` 子串等极端情况受 unified diff 格式固有歧义影响。

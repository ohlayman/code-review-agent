import { tool, type StructuredTool } from "@langchain/core/tools";
import { z } from "zod";
import type { RepoAccess } from "../repository/adapter.js";

// 在仓库文件列表中按优先级查找与源文件对应的测试文件。
function findRelatedTest(path: string, files: string[]): string | undefined {
  const normalized = path.replace(/^\.\//, "");
  const lastSlash = normalized.lastIndexOf("/");
  const dir = lastSlash === -1 ? "" : normalized.slice(0, lastSlash);
  const base = lastSlash === -1 ? normalized : normalized.slice(lastSlash + 1);
  const stem = base.replace(/\.[^.]+$/, "");
  const inDir = (name: string) => (dir ? `${dir}/${name}` : name);

  const candidates = [
    inDir(`${stem}.test.ts`),
    inDir(`${stem}.spec.ts`),
    inDir(`__tests__/${base}`),
    inDir(`__tests__/${stem}.test.ts`),
    inDir(`__tests__/${stem}.spec.ts`),
  ];

  return candidates.find((candidate) => files.includes(candidate));
}

export function createContextTools(repo: RepoAccess): StructuredTool[] {
  const readFile = tool(
    async ({ path }: { path: string }) => repo.readFile(path),
    {
      name: "read_file",
      description: "读取指定文件的完整内容。参数 path 为仓库内相对路径，例如 src/parse.ts。",
      schema: z.object({ path: z.string() }),
    }
  );

  const readFileRange = tool(
    async ({ path, startLine, endLine }: { path: string; startLine: number; endLine: number }) => {
      const content = await repo.readFile(path);
      return content.split("\n").slice(startLine - 1, endLine).join("\n");
    },
    {
      name: "read_file_range",
      description:
        "按行读取文件片段（1-based，包含首尾行）。参数 path 为文件路径，startLine 为起始行，endLine 为结束行。",
      schema: z.object({
        path: z.string(),
        startLine: z.number().int().positive(),
        endLine: z.number().int().positive(),
      }),
    }
  );

  const grepTool = tool(
    async ({ pattern }: { pattern: string }) => repo.grep(pattern),
    {
      name: "grep",
      description: "在仓库中搜索匹配的文本行，返回包含文件名与行号的结果。参数 pattern 为正则表达式。",
      schema: z.object({ pattern: z.string() }),
    }
  );

  const listFiles = tool(
    async () => (await repo.listFiles()).join("\n"),
    {
      name: "list_files",
      description: "列出仓库中的全部文件路径，每行一个。无需参数。",
      schema: z.object({}),
    }
  );

  const readRelatedTest = tool(
    async ({ path }: { path: string }) => {
      const testPath = findRelatedTest(path, await repo.listFiles());
      return testPath ? repo.readFile(testPath) : "未找到对应测试文件";
    },
    {
      name: "read_related_test",
      description:
        "查找并读取与指定源文件对应的测试文件，支持同目录 *.test.ts/*.spec.ts 及 __tests__/ 目录。参数 path 为源文件路径。",
      schema: z.object({ path: z.string() }),
    }
  );

  return [readFile, readFileRange, grepTool, listFiles, readRelatedTest];
}

import { z } from "zod";

export const DiffLineSchema = z.object({
  type: z.enum(["add", "del", "context"]),
  content: z.string(),
  oldLine: z.number().int().nullable(),
  newLine: z.number().int().nullable(),
});

export const HunkSchema = z.object({
  header: z.string(),
  newStartLine: z.number().int(),
  lines: z.array(DiffLineSchema),
});

export const FileChangeSchema = z.object({
  path: z.string(),
  oldPath: z.string().nullable(),
  status: z.enum(["added", "modified", "deleted", "renamed"]),
  hunks: z.array(HunkSchema),
});

export const ChangeSetSchema = z.object({
  base: z.string().nullable(),
  head: z.string().nullable(),
  files: z.array(FileChangeSchema),
});

export type DiffLine = z.infer<typeof DiffLineSchema>;
export type Hunk = z.infer<typeof HunkSchema>;
export type FileChange = z.infer<typeof FileChangeSchema>;
export type ChangeSet = z.infer<typeof ChangeSetSchema>;

const HUNK_HEADER = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;

// git 默认 core.quotePath=true 时，含非 ASCII/控制字符/引号/反斜杠的路径会被双引号包裹并做
// C 风格转义（八进制表示 UTF-8 字节）；空格不会被引号包裹。这里解码转义、还原真实路径。
function unescapeGitPath(raw: string): string {
  const simple: Record<string, number> = {
    n: 0x0a, t: 0x09, '"': 0x22, "\\": 0x5c,
    a: 0x07, b: 0x08, f: 0x0c, v: 0x0b, r: 0x0d,
  };
  const bytes: number[] = [];
  for (let i = 0; i < raw.length; i++) {
    if (raw[i] !== "\\") {
      bytes.push(raw.charCodeAt(i));
      continue;
    }
    const next = raw[i + 1];
    if (next !== undefined && next in simple) {
      bytes.push(simple[next]);
      i++;
    } else if (next !== undefined && /[0-7]/.test(next)) {
      let j = i + 1;
      let val = 0;
      let n = 0;
      while (j < raw.length && n < 3 && /[0-7]/.test(raw[j])) {
        val = val * 8 + (raw.charCodeAt(j) - 48);
        j++;
        n++;
      }
      bytes.push(val);
      i = j - 1;
    } else {
      bytes.push(0x5c);
    }
  }
  return Buffer.from(bytes).toString("utf8");
}

// 解码单个路径 token：带双引号包裹则解转义，否则原样返回（未引号路径已是正确 UTF-8）。
function decodeGitPath(raw: string): string {
  if (raw.length >= 2 && raw[0] === '"' && raw[raw.length - 1] === '"') {
    return unescapeGitPath(raw.slice(1, -1));
  }
  return raw;
}

// 剥离 git 在路径前加的 a/ b/ 前缀。
function stripGitPrefix(path: string, prefix: "a/" | "b/"): string {
  return path.startsWith(prefix) ? path.slice(2) : path;
}

// 解析 `diff --git ` 后的 `<old> <new>`。新路径以 `b/`（或 `"b/`）开头，其前空格为分界；
// 用 lastIndexOf 与旧贪婪正则语义一致。注意：文件名若含字面 ` b/` 子串，unified diff 头部
// 存在格式固有歧义（git 限制），需 NUL 分隔的 raw 输出才能根治，属已知限制。
function parseDiffHeader(rest: string): { oldPath: string; newPath: string } | null {
  const plain = rest.lastIndexOf(" b/");
  const quoted = rest.lastIndexOf(' "b/');
  const newStart = Math.max(plain, quoted);
  if (newStart < 0) return null;
  const oldPath = stripGitPrefix(decodeGitPath(rest.slice(0, newStart)), "a/");
  const newPath = stripGitPrefix(decodeGitPath(rest.slice(newStart + 1)), "b/");
  return { oldPath, newPath };
}

export function parseDiff(diffText: string, base?: string, head?: string): ChangeSet {
  const files: FileChange[] = [];
  let current: FileChange | null = null;
  let hunk: Hunk | null = null;
  let binary = false;
  let oldLine = 0;
  let newLine = 0;

  const flush = (): void => {
    if (current && !binary) files.push(current);
    current = null;
    hunk = null;
    binary = false;
  };

  for (const rawLine of diffText.split("\n")) {
    const line = rawLine.endsWith("\r") ? rawLine.slice(0, -1) : rawLine;

    if (line.startsWith("diff --git ")) {
      flush();
      const parsed = parseDiffHeader(line.slice("diff --git ".length));
      if (!parsed) continue;
      const { oldPath, newPath } = parsed;
      const renamed = oldPath !== newPath;
      current = {
        path: newPath,
        oldPath: renamed ? oldPath : null,
        status: renamed ? "renamed" : "modified",
        hunks: [],
      };
      continue;
    }

    if (!current) continue;

    const hunkMatch = HUNK_HEADER.exec(line);
    if (hunkMatch) {
      oldLine = Number(hunkMatch[1]);
      newLine = Number(hunkMatch[3]);
      hunk = { header: line, newStartLine: newLine, lines: [] };
      current.hunks.push(hunk);
      continue;
    }

    if (!hunk) {
      if (line === "GIT binary patch" || /^Binary files .* differ$/.test(line)) {
        binary = true;
      } else if (line.startsWith("new file mode ")) {
        current.status = "added";
        current.oldPath = null;
      } else if (line.startsWith("deleted file mode ")) {
        current.status = "deleted";
      } else if (line.startsWith("rename from ")) {
        current.status = "renamed";
        current.oldPath = decodeGitPath(line.slice("rename from ".length));
      } else if (line.startsWith("rename to ")) {
        current.status = "renamed";
        current.path = decodeGitPath(line.slice("rename to ".length));
      } else if (line.startsWith("--- /dev/null")) {
        current.status = "added";
      } else if (line.startsWith("+++ /dev/null")) {
        current.status = "deleted";
      }
      continue;
    }

    const prefix = line[0];
    const content = line.slice(1);
    if (prefix === "+") {
      hunk.lines.push({ type: "add", content, oldLine: null, newLine });
      newLine++;
    } else if (prefix === "-") {
      hunk.lines.push({ type: "del", content, oldLine, newLine: null });
      oldLine++;
    } else if (prefix === " ") {
      hunk.lines.push({ type: "context", content, oldLine, newLine });
      oldLine++;
      newLine++;
    }
  }

  flush();
  return { base: base ?? null, head: head ?? null, files };
}

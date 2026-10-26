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

// git 默认 core.quotePath=true 时，含非 ASCII/特殊字符的路径会被双引号包裹并做 C 风格转义；
// 不处理会导致这类文件整段被静默丢弃。这里解码转义、还原真实路径。
function unescapeGitPath(raw: string): string {
  const bytes: number[] = [];
  for (let i = 0; i < raw.length; i++) {
    if (raw[i] !== "\\") {
      bytes.push(raw.charCodeAt(i));
      continue;
    }
    const next = raw[i + 1];
    if (next === "n") { bytes.push(0x0a); i++; }
    else if (next === "t") { bytes.push(0x09); i++; }
    else if (next === '"') { bytes.push(0x22); i++; }
    else if (next === "\\") { bytes.push(0x5c); i++; }
    else if (next !== undefined && /[0-7]/.test(next)) {
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

// 读取 `diff --git ` 后的一个路径 token（裸 token 或双引号包裹），并剥离 a/ b/ 前缀。
function readDiffPath(raw: string, start: number): { path: string; end: number } | null {
  if (start >= raw.length) return null;
  let body: string;
  let end: number;
  if (raw[start] === '"') {
    const close = raw.indexOf('"', start + 1);
    if (close === -1) return null;
    body = raw.slice(start + 1, close);
    end = close + 1;
  } else {
    const space = raw.indexOf(" ", start);
    end = space === -1 ? raw.length : space;
    body = raw.slice(start, end);
  }
  const path = body.startsWith("a/") ? body.slice(2) : body.startsWith("b/") ? body.slice(2) : body;
  return { path: unescapeGitPath(path), end };
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
      const first = readDiffPath(line, "diff --git ".length);
      if (!first) continue;
      const second = readDiffPath(line, first.end + 1);
      if (!second) continue;
      const oldPath = first.path;
      const path = second.path;
      const renamed = oldPath !== path;
      current = {
        path,
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
        current.oldPath = line.slice("rename from ".length);
      } else if (line.startsWith("rename to ")) {
        current.status = "renamed";
        current.path = line.slice("rename to ".length);
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

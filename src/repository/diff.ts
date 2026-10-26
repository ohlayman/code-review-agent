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

const DIFF_HEADER = /^diff --git a\/(.+) b\/(.+)$/;
const HUNK_HEADER = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;

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
      const match = DIFF_HEADER.exec(line);
      if (!match) continue;
      const oldPath = match[1];
      const path = match[2];
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

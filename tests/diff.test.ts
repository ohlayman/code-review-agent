import { describe, it, expect } from "vitest";
import { parseDiff } from "../src/repository/diff.js";

const SAMPLE = `diff --git a/src/parse.ts b/src/parse.ts
index 111..222 100644
--- a/src/parse.ts
+++ b/src/parse.ts
@@ -1,3 +1,4 @@
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
    const adds = f.hunks[0].lines.filter((l) => l.type === "add");
    expect(del!.oldLine).toBe(2);
    expect(del!.newLine).toBeNull();
    expect(adds[0].newLine).toBe(2);
    expect(adds[1].newLine).toBe(3);
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

  it("不丢弃含非 ASCII（引号+八进制转义）路径的文件", () => {
    const cs = parseDiff(
      `diff --git "a/\\346\\226\\207\\346\\241\\243.ts" "b/\\346\\226\\207\\346\\241\\243.ts"\n--- "a/\\346\\226\\207\\346\\241\\243.ts"\n+++ "b/\\346\\226\\207\\346\\241\\243.ts"\n@@ -1 +1 @@\n-old\n+new\n`
    );
    expect(cs.files).toHaveLength(1);
    expect(cs.files[0].path).toBe("文档.ts");
    expect(cs.files[0].status).toBe("modified");
  });

  it("含空格文件名不被截断（git 对空格不加引号）", () => {
    const cs = parseDiff(
      `diff --git a/doc file.txt b/doc file.txt\n--- a/doc file.txt\n+++ b/doc file.txt\n@@ -1 +1 @@\n-old\n+new\n`
    );
    expect(cs.files).toHaveLength(1);
    expect(cs.files[0].path).toBe("doc file.txt");
    expect(cs.files[0].status).toBe("modified");
  });

  it("未引号的非 ASCII 路径（core.quotePath=false）不被损坏", () => {
    const cs = parseDiff(
      `diff --git a/文档.ts b/文档.ts\n--- a/文档.ts\n+++ b/文档.ts\n@@ -1 +1 @@\n-old\n+new\n`
    );
    expect(cs.files[0].path).toBe("文档.ts");
    expect(cs.files[0].status).toBe("modified");
  });

  it("路径含转义引号时正确解码", () => {
    const cs = parseDiff(
      `diff --git "a/q\\"uote.txt" "b/q\\"uote.txt"\n--- "a/q\\"uote.txt"\n+++ "b/q\\"uote.txt"\n@@ -1 +1 @@\n-old\n+new\n`
    );
    expect(cs.files[0].path).toBe('q"uote.txt');
  });

  it("重命名的非 ASCII 路径被正确解码", () => {
    const cs = parseDiff(
      `diff --git "a/\\346\\227\\247.ts" "b/\\346\\226\\260.ts"\nsimilarity index 100%\nrename from "\\346\\227\\247.ts"\nrename to "\\346\\226\\260.ts"\n`
    );
    expect(cs.files[0].status).toBe("renamed");
    expect(cs.files[0].oldPath).toBe("旧.ts");
    expect(cs.files[0].path).toBe("新.ts");
  });

  it("引号路径含字面 ` b/` 时不误判分界", () => {
    const cs = parseDiff(
      `diff --git "a/\\346\\226\\260 b/y.txt" "b/\\346\\226\\260 b/y.txt"\n--- "a/\\346\\226\\260 b/y.txt"\n+++ "b/\\346\\226\\260 b/y.txt"\n@@ -1 +1 @@\n-old\n+new\n`
    );
    expect(cs.files).toHaveLength(1);
    expect(cs.files[0].path).toBe("新 b/y.txt");
    expect(cs.files[0].status).toBe("modified");
  });
});

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
});

import { describe, it, expect } from "vitest";
import path from "node:path";
import { parseArgs } from "../src/cli.js";

describe("parseArgs", () => {
  it("解析 pr 命令", () => {
    expect(parseArgs(["pr", "owner/repo", "123"])).toEqual({
      command: "pr",
      repo: "owner/repo",
      prNumber: 123,
      comment: null,
    });
  });

  it("diff 命令解析 --comment", () => {
    expect(parseArgs(["diff", "--comment", "owner/repo#5"])).toEqual({
      command: "diff",
      base: null,
      repoPath: process.cwd(),
      comment: "owner/repo#5",
    });
  });

  it("branch 命令解析 ref/base/repoPath", () => {
    expect(parseArgs(["branch", "feature/login", "--base", "main", "--repo", "../x"])).toEqual({
      command: "branch",
      ref: "feature/login",
      base: "main",
      repoPath: path.resolve("../x"),
      comment: null,
    });
  });

  it("pr 编号非整数时抛错", () => {
    expect(() => parseArgs(["pr", "o/r", "abc"])).toThrow(/PR 编号必须是正整数/);
  });

  it("pr 缺少 PR 编号时抛错", () => {
    expect(() => parseArgs(["pr", "o/r"])).toThrow(/pr 需要指定 owner\/repo 与 PR 编号/);
  });

  it("未知命令抛 USAGE", () => {
    expect(() => parseArgs(["nope"])).toThrow(/用法：code-review-agent/);
  });
});

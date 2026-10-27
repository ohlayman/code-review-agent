import { describe, it, expect, vi, afterEach } from "vitest";
import { existsSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { simpleGit } from "simple-git";
import {
  resolvePullRequest,
  clonePullRequest,
  gitEnv,
  GitHubPlatformAdapter,
} from "../src/platform/github.js";
import { GitRepositoryAdapter } from "../src/repository/adapter.js";
import { createTempRepo } from "./helpers/temp-repo.js";

afterEach(() => {
  vi.unstubAllGlobals();
});

function jsonResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

describe("resolvePullRequest", () => {
  it("请求正确的 API、无 token 时无 Authorization，并返回 base/head 信息", async () => {
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit): Promise<Response> =>
      jsonResponse({
        base: { sha: "base-sha", repo: { clone_url: "https://github.com/o/r.git" } },
        head: { sha: "head-sha" },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const ref = await resolvePullRequest("o/r", 7);
    expect(ref).toEqual({
      cloneUrl: "https://github.com/o/r.git",
      baseSha: "base-sha",
      headSha: "head-sha",
    });

    const [url, init] = fetchMock.mock.calls[0];
    expect(String(url)).toBe("https://api.github.com/repos/o/r/pulls/7");
    const headers = new Headers(init?.headers);
    expect(headers.get("Accept")).toBe("application/vnd.github+json");
    expect(headers.get("User-Agent")).toBe("code-review-agent");
    expect(headers.get("Authorization")).toBeNull();
  });

  it("有 token 时带 Bearer 授权头", async () => {
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit): Promise<Response> =>
      jsonResponse({ base: { sha: "b", repo: { clone_url: "u" } }, head: { sha: "h" } }),
    );
    vi.stubGlobal("fetch", fetchMock);

    await resolvePullRequest("o/r", 7, "t");
    const [, init] = fetchMock.mock.calls[0];
    expect(new Headers(init?.headers).get("Authorization")).toBe("Bearer t");
  });

  it("非 2xx 时 reject（fail-closed）", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (): Promise<Response> => new Response("not found", { status: 404 })),
    );
    await expect(resolvePullRequest("o/r", 7)).rejects.toThrow(/解析 PR 失败/);
  });

  it("缺失 head.sha 时 reject（fail-closed）", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (): Promise<Response> =>
        jsonResponse({ base: { sha: "b", repo: { clone_url: "u" } } }),
      ),
    );
    await expect(resolvePullRequest("o/r", 7)).rejects.toThrow();
  });

  it("非法仓库名（无斜杠）时 reject", async () => {
    await expect(resolvePullRequest("bad", 1)).rejects.toThrow(/非法仓库名/);
  });
});

describe("GitHubPlatformAdapter.postReviewComment", () => {
  it("POST 到 issue 评论接口、带授权头与 JSON 正文", async () => {
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit): Promise<Response> =>
      jsonResponse({ id: 1 }),
    );
    vi.stubGlobal("fetch", fetchMock);

    await new GitHubPlatformAdapter("tok").postReviewComment("o/r#7", "报告");

    const [url, init] = fetchMock.mock.calls[0];
    expect(String(url)).toBe("https://api.github.com/repos/o/r/issues/7/comments");
    expect(init?.method).toBe("POST");
    const headers = new Headers(init?.headers);
    expect(headers.get("Authorization")).toBe("Bearer tok");
    expect(headers.get("Content-Type")).toContain("application/json");
    expect(init?.body).toBe(JSON.stringify({ body: "报告" }));
  });

  it("非 2xx 时 reject", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (): Promise<Response> => new Response("denied", { status: 403 })),
    );
    await expect(
      new GitHubPlatformAdapter("tok").postReviewComment("o/r#7", "x"),
    ).rejects.toThrow(/评论发布失败/);
  });

  it("非法 reviewId（无 #）时 reject", async () => {
    await expect(
      new GitHubPlatformAdapter("tok").postReviewComment("bad", "x"),
    ).rejects.toThrow(/非法 reviewId/);
  });
});

describe("gitEnv", () => {
  it("token 只经 GIT_CONFIG_* 环境变量注入，不进入 argv", () => {
    const env = gitEnv("sekret");
    expect(env.GIT_CONFIG_COUNT).toBe("1");
    expect(env.GIT_CONFIG_KEY_0).toBe("http.extraHeader");
    expect(env.GIT_CONFIG_VALUE_0).toBe("Authorization: Basic eC1hY2Nlc3MtdG9rZW46c2VrcmV0");
    // 白名单不包含密钥类变量，避免 DEEPSEEK_API_KEY/GITHUB_TOKEN 泄露给子进程。
    expect(env.DEEPSEEK_API_KEY).toBeUndefined();
    expect(env.GITHUB_TOKEN).toBeUndefined();
  });

  it("无 token 时不注入 GIT_CONFIG_*", () => {
    const env = gitEnv();
    expect(env.GIT_CONFIG_COUNT).toBeUndefined();
    expect(env.GIT_CONFIG_KEY_0).toBeUndefined();
    expect(env.GIT_CONFIG_VALUE_0).toBeUndefined();
  });
});

async function prepareTwoCommitRepo() {
  const repo = await createTempRepo();
  await writeFile(
    join(repo.repoPath, "src", "parse.ts"),
    "export function divide(a, b) { if (b === 0) throw new Error('除数为 0'); return a / b; }\n",
    "utf8",
  );
  const git = simpleGit(repo.repoPath);
  await git.add(["-A"]);
  await git.commit("head");
  const head = (await git.revparse(["HEAD"])).trim();
  return { repo, base: repo.headCommit, head };
}

describe("clonePullRequest", () => {
  it("克隆本地仓库并按 sha 拉取 base/head，可用 GitRepositoryAdapter 读取 diff", async () => {
    const { repo, base, head } = await prepareTwoCommitRepo();
    try {
      const r = await clonePullRequest(repo.repoPath, base, head);
      try {
        expect(existsSync(r.dir)).toBe(true);
        const adapter = new GitRepositoryAdapter(r.dir);
        const diff = await adapter.getBranchDiff(r.head, r.base);
        expect(diff).not.toBe("");
        expect(diff).toContain("除数为 0");
      } finally {
        await r.cleanup();
        expect(existsSync(r.dir)).toBe(false);
      }
    } finally {
      repo.cleanup();
    }
  });

  it("带 token 时经 GIT_CONFIG_* 环境变量注入仍可克隆", async () => {
    const { repo, base, head } = await prepareTwoCommitRepo();
    try {
      const r = await clonePullRequest(repo.repoPath, base, head, "dummy-token");
      try {
        const diff = await new GitRepositoryAdapter(r.dir).getBranchDiff(r.head, r.base);
        expect(diff).toContain("除数为 0");
      } finally {
        await r.cleanup();
      }
    } finally {
      repo.cleanup();
    }
  });
});

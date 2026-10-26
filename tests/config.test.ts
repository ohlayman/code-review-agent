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

  it("拒绝非 https 或含 userinfo 的 baseURL", () => {
    expect(() => loadConfig({ DEEPSEEK_API_KEY: "k", REVIEW_BASE_URL: "http://evil.com" })).toThrow(/https/);
    expect(() => loadConfig({ DEEPSEEK_API_KEY: "k", REVIEW_BASE_URL: "ftp://x" })).toThrow();
    expect(() => loadConfig({ DEEPSEEK_API_KEY: "k", REVIEW_BASE_URL: "https://user:pass@x" })).toThrow(/userinfo/);
    expect(() => loadConfig({ DEEPSEEK_API_KEY: "k", REVIEW_BASE_URL: "https://api.other.com" })).not.toThrow();
  });
});

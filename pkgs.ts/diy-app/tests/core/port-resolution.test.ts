// tests/core/port-resolution.test.ts
// 端口裁决 `resolvePort`（##328：端口不再承载身份，但**怎么选**仍是核心决策）。
//
// 为什么单测：这段逻辑原内联在 Electron 启动函数（main/index.ts::startRpcPort）里，起不来实例就测不到，
// 而它恰是最容易回归、又最没有保护的一处（「非生产不沿用记录里的 18888」这条规则一旦写反，
// dev 就又把生产门牌占住 → 回到 ##328 的现场）。抽成纯函数后在此锁死。
import { describe, it, expect } from "vitest";
import { PROD_DEFAULT_PORT, defaultPort, resolvePort } from "../../src/runtime";

describe("defaultPort —— 缺省里只有生产占 18888", () => {
  it("production = 18888 门牌", () => {
    expect(defaultPort("production")).toBe(PROD_DEFAULT_PORT);
  });

  it("development / test = 0（内核分配随机空闲端口）", () => {
    expect(defaultPort("development")).toBe(0);
    expect(defaultPort("test")).toBe(0);
  });
});

describe("resolvePort —— DIY_PORT > app.port 记录 > 环境缺省", () => {
  it("production：无记录 → 18888 门牌", () => {
    expect(resolvePort({ env: "production", recordedPort: null })).toEqual({
      port: PROD_DEFAULT_PORT,
      source: "default",
    });
  });

  it("production：有记录 → 沿用记录（端口稳定，便于人肉访问）", () => {
    expect(resolvePort({ env: "production", recordedPort: 19001 })).toEqual({
      port: 19001,
      source: "recorded",
    });
    // 记录恰好是门牌也照常沿用（生产自己占 18888 天经地义）
    expect(resolvePort({ env: "production", recordedPort: PROD_DEFAULT_PORT }).port).toBe(
      PROD_DEFAULT_PORT,
    );
  });

  it("development：记录是 18888（旧版遗留的生产门牌）→ 忽略，回落随机 0", () => {
    expect(resolvePort({ env: "development", recordedPort: PROD_DEFAULT_PORT })).toEqual({
      port: 0,
      source: "default",
    });
    expect(resolvePort({ env: "test", recordedPort: PROD_DEFAULT_PORT }).port).toBe(0);
  });

  it("development：记录是别的端口 → 照常沿用（只拦门牌，不拦正常记录）", () => {
    expect(resolvePort({ env: "development", recordedPort: 19002 })).toEqual({
      port: 19002,
      source: "recorded",
    });
  });

  it("DIY_PORT（入口注入）压过记录与缺省（含 0 = 显式要随机）", () => {
    expect(resolvePort({ env: "production", cliPort: 19100, recordedPort: 19003 })).toEqual({
      port: 19100,
      source: "cli",
    });
    expect(resolvePort({ env: "development", cliPort: 0, recordedPort: 19004 })).toEqual({
      port: 0,
      source: "cli",
    });
  });

  it("无记录（undefined）与 null 等价", () => {
    expect(resolvePort({ env: "production" })).toEqual({
      port: PROD_DEFAULT_PORT,
      source: "default",
    });
  });
});

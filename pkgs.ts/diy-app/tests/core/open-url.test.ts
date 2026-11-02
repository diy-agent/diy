// tests/core/open-url.test.ts
// 🎯 「在系统浏览器打开 URL」（##507 web 远程访问）的校验与调用语义。
//
// 用**注入端口**（手写假 openExternal）而不是模块级 mock —— 后者在
// `--no-isolate` 下会静默失效（##402，见 scripts/check-no-vi-mock.sh）。
// 判据 3 的服务端一半就在这：假 URL 进来，断言端口被调、且只接受 http(s)。
import { describe, it, expect } from "vitest";
import { openUrlWith, type OpenExternalPort } from "../../src/main/core/open-url";

function fakePort(behaviour: (url: string) => Promise<void> = async () => undefined) {
  const calls: string[] = [];
  const port: OpenExternalPort = {
    openExternal: async (url) => {
      calls.push(url);
      return behaviour(url);
    },
  };
  return { port, calls };
}

describe("openUrlWith", () => {
  it("https URL → 调 openExternal 并 ok", async () => {
    const { port, calls } = fakePort();
    const r = await openUrlWith(port, "https://192.168.1.5:9400/");
    expect(r).toEqual({ ok: true, message: null });
    expect(calls).toEqual(["https://192.168.1.5:9400/"]);
  });

  it("http URL 也接受（判据 3 用假 URL 断言调用了 openExternal）", async () => {
    const { port, calls } = fakePort();
    const r = await openUrlWith(port, "http://example.test:8080/");
    expect(r.ok).toBe(true);
    expect(calls).toEqual(["http://example.test:8080/"]);
  });

  it("首尾空白被去掉后再调", async () => {
    const { port, calls } = fakePort();
    await openUrlWith(port, "  https://x.test/  ");
    expect(calls).toEqual(["https://x.test/"]);
  });

  it("非 http(s) 拒绝，且**不**调 openExternal", async () => {
    const { port, calls } = fakePort();
    const r = await openUrlWith(port, "file:///etc/passwd");
    expect(r.ok).toBe(false);
    expect(r.message).toContain("只接受 http(s)");
    expect(calls).toEqual([]);
  });

  it("空串拒绝", async () => {
    const { port, calls } = fakePort();
    const r = await openUrlWith(port, "  ");
    expect(r.ok).toBe(false);
    expect(calls).toEqual([]);
  });

  it("端口抛错 → ok:false + 原文", async () => {
    const { port } = fakePort(async () => {
      throw new Error("no browser");
    });
    const r = await openUrlWith(port, "https://x.test/");
    expect(r).toEqual({ ok: false, message: "no browser" });
  });
});

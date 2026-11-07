/**
 * fast.bind-once.test.ts — `bindAppHandlers` 的**装配期**自检（毫秒级，不起 Electron / 不发请求）
 *
 * ## 为什么要有这条
 *
 * `ServerBinding.on` 的 `_assertNotRegistered` 只在**注册时**才发现冲突 —— 同一方法绑两次
 * 直接抛 `diy.task.create 已注册`。但 `tsc` 查不到：2026-11-06 拆 impl 时脚本按 handler
 * 条数插入 `bindXxx(binding)`，`bindTask` 插了 2 次、`bindContext` 插了 6 次 ——
 * **整个应用起不来**，而 `tsc --noEmit` 是绿的。
 *
 * ## 为什么不 import harness/rpc
 *
 * `harness/rpc.ts` 顶层 import 了 `electron-test.ts`，后者会去加载 Electron 二进制 ——
 * 只是想验「装配」，没必要把 Electron 拖进来。这里只用 `createMemTransportPair()`
 * （进程内一对管道，无 socket）。
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ChannelServerBinding, createMemTransportPair } from "@diy-agent/rpc";
import { bindAppHandlers } from "../src/main/services/api-impl";

let home: string;
beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "bind-once-"));
    process.env["DIY_HOME"] = home;
});
afterEach(() => {
    rmSync(home, { recursive: true, force: true });
});

describe("bindAppHandlers 装配", () => {
    it("不重复注册任何方法（同一 api 方法绑两次会抛）", () => {
        const { serverTx } = createMemTransportPair();
        expect(() => bindAppHandlers(new ChannelServerBinding(serverTx))).not.toThrow();
    });

    it("两次装配互不污染（不同 binding 各自一套）", () => {
        const a = createMemTransportPair().serverTx;
        const b = createMemTransportPair().serverTx;
        expect(() => bindAppHandlers(new ChannelServerBinding(a))).not.toThrow();
        expect(() => bindAppHandlers(new ChannelServerBinding(b))).not.toThrow();
    });
});

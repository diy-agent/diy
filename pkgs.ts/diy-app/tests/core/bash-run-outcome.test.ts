// tests/core/bash-run-outcome.test.ts
// 🎯 ##408 刀 5 —— `runBash` 的**结局映射**（真跑 /bin/bash，不 sleep 长命令）
//
// 为什么值得单独测：job 账本里的 `outcome / exitCode / signal` 全部来自这一处映射，
// 一旦`failed`（工具行 ✓/✗）与 `outcome`（job 账）串了口径，面板的失败率就会长期骗人。
// 这里钉的四个结局：ok / fail / timeout / canceled —— 与 `RunOutcome` 四值一一对应。
//
// 注意：**不改**既有的 bash 行为判据（##332/##353）：`failed` 仍只看「命令跑起来了没有 + 有没有错误输出」。

import { describe, it, expect } from "vitest";
import { runBash } from "../../src/main/services/local-agent";
import type { LocalAgentLimits } from "../../src/main/services/local-agent";

/** 只需要 bashTimeoutMs 一个字段；其余字段本测试不触发。 */
const limits = { bashTimeoutMs: 2_000 } as unknown as LocalAgentLimits;

describe("runBash 的结局映射（job 账本的唯一来源）", () => {
    it("exit 0 ⇒ outcome ok + exitCode 0（输出与 pid 通过 hooks 交出去）", async () => {
        const chunks: Buffer[] = [];
        let pid = 0;
        const run = await runBash("echo hello-job", process.cwd(), limits, undefined, {
            onSpawn: (p) => {
                pid = p;
            },
            onChunk: (c) => chunks.push(c),
        });
        expect(run.outcome).toBe("ok");
        expect(run.exitCode).toBe(0);
        expect(run.failed).toBe(false);
        expect(run.text).toContain("hello-job");
        expect(pid).toBeGreaterThan(0);
        expect(Buffer.concat(chunks).toString()).toContain("hello-job");
    });

    it("非零退出 ⇒ outcome fail + exitCode N（failed 仍按 ##353：有 stderr 才 ✗）", async () => {
        const run = await runBash("exit 3", process.cwd(), limits);
        expect(run.outcome).toBe("fail");
        expect(run.exitCode).toBe(3);
        expect(run.failed).toBe(false); // 无 stderr = 查询未命中（##353），不画 ✗

        const loud = await runBash("echo boom >&2; exit 7", process.cwd(), limits);
        expect(loud.outcome).toBe("fail");
        expect(loud.exitCode).toBe(7);
        expect(loud.failed).toBe(true); // 有错误输出 = 真失败
    });

    it("命令跑不起来（cwd 是普通文件）⇒ outcome fail，且没有 exitCode（不拿 -1 冒充）", async () => {
        // 同步抛路径：cwd 为普通文件时 Node 在 spawn 内直接 throw（ENOTDIR）
        const run = await runBash("echo hi", "/etc/hosts", limits);
        expect(run.outcome).toBe("fail");
        expect(run.exitCode).toBeUndefined();
        expect(run.failed).toBe(true);
        expect(run.text).toContain("命令未能启动");
    });

    it("超时 ⇒ outcome timeout + signal（**不是** fail：跑太久不是缺陷）", async () => {
        const run = await runBash("sleep 10", process.cwd(), { bashTimeoutMs: 300 } as unknown as LocalAgentLimits);
        expect(run.outcome).toBe("timeout");
        expect(run.signal).toBe("SIGKILL");
        expect(run.failed).toBe(false); // 超时仍当数据回喂（##332 ②）
    }, 10_000);

    it("取消 ⇒ outcome canceled（failed 仍为 false：取消不是命令报错）", async () => {
        const ac = new AbortController();
        const pending = runBash("sleep 10", process.cwd(), limits, ac.signal);
        setTimeout(() => ac.abort(), 100);
        const run = await pending;
        expect(run.outcome).toBe("canceled");
        expect(run.failed).toBe(false);
        expect(run.text.endsWith("\n---\n[已取消]")).toBe(true); // ##419 起带头，正文仍是原文
    }, 10_000);
});

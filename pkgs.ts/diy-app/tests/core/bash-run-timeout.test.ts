// tests/core/bash-run-timeout.test.ts
// 🎯 ##419 —— 超时 / 取消必须**先钉结局再杀**，后台作业不得把工具挂死
//
// 现象（铁证 `~/.diy/log/agent-bash.jsonl`，同一台机同一个 bash 工具）：
//   `nohup ./sha.sh lab … & disown` 实测 **1814527ms（30.2 分钟）**、另一条 **4945677ms（82.4 分钟）**，
//   都**没有** `[命令超时被杀]` 文案 —— 也就是说 300s 超时压根没生效，工具一直挂着。
//
// 根因（改前）：收尾只认 `'close'`（stdio 全关之后），而超时那条路**只杀不收尾**：
//     timeoutId = setTimeout(() => { killed = true; killProcessGroup(child); }, …)
//   一旦杀不到（后台作业换了 session/pgid ⇒ `kill(-pgid)` 打空），持管道的那一支还活着 ⇒
//   `'close'` 永远不到 ⇒ Promise 永不 resolve。对照 `onAbort` 里「先 finish 再杀」是对的。
//
// 本文件钉六条（真跑 /bin/bash，不 sleep 长命令）：
//   ① 正常命令走 'close'（输出不截尾）     ② 超时到点**立即**返回且带超时文案
//   ③ 超时后 'close' 迟到不重复收尾        ④ 后台作业持管道时按超时返回（不永挂）
//   ⑤ 结果头的字段齐全（YAML 头由 zod 派生）⑥ 取消路径仍先返回
//
// ⚠️ ④ 的姿势：必须让孙进程**离开 bash 的进程组**（`POSIX::setsid`）—— 同组的后台作业会被
//    `killProcessGroup` 连带打死，根本压不出这个 bug（生产里挂住的是自己 setsid 的 Electron）。

import { describe, it, expect } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { markBashTruncated, runBash } from "../../src/main/services/local-agent";
import type { LocalAgentLimits } from "../../src/main/services/local-agent";

const limits = (ms: number) => ({ bashTimeoutMs: ms }) as unknown as LocalAgentLimits;

/** 拆开「YAML 头 + 正文」：头 = 两个 `---` 之间；正文逐字返回（格式判据见 local-agent.ts::renderBashHead） */
function splitHead(text: string): { head: Record<string, string>; body: string } {
    expect(text.startsWith("---\n"), `缺 YAML 头：${text.slice(0, 80)}`).toBe(true);
    const end = text.indexOf("\n---\n", 4);
    expect(end, `头没有闭合：${text.slice(0, 200)}`).toBeGreaterThan(0);
    const head: Record<string, string> = {};
    for (const line of text.slice(4, end).split("\n")) {
        const i = line.indexOf(": ");
        expect(i, `头部行不是 key: value 形状：${line}`).toBeGreaterThan(0);
        head[line.slice(0, i)] = line.slice(i + 2);
    }
    return { head, body: text.slice(end + 5) };
}

describe("runBash 的收尾（##419）", () => {
    it("① 正常命令仍走 'close'：输出完整 + 头字段齐全", async () => {
        const cwd = mkdtempSync(join(tmpdir(), "t419-close-")); // 无空格的临时目录：cwd 可直接逐字比对
        const run = await runBash('printf "a\\nb\\n"', cwd, limits(1_500));
        rmSync(cwd, { recursive: true, force: true });
        const { head, body } = splitHead(run.text);

        expect(run.outcome).toBe("ok");
        expect(run.failed).toBe(false);
        expect(run.exitCode).toBe(0);
        expect(body).toBe("a\nb\n"); // 正文逐字不动
        // ⑤ 头字段（顺序 = zod 定义序，见 BASH_RESULT_HEAD_SCHEMA）
        expect(Object.keys(head)).toEqual([
            "ok",
            "exit_code",
            "duration_ms",
            "timeout_ms",
            "timed_out",
            "killed",
            "truncated",
            "stdout_bytes",
            "stderr_bytes",
            "cwd",
        ]);
        expect(head["ok"]).toBe("true");
        expect(head["exit_code"]).toBe("0");
        expect(head["timeout_ms"]).toBe("1500");
        expect(head["timed_out"]).toBe("false");
        expect(head["killed"]).toBe("false");
        expect(head["truncated"]).toBe("false"); // 投递层真截断才改 true（markBashTruncated）
        expect(head["stdout_bytes"]).toBe("4");
        expect(head["stderr_bytes"]).toBe("0");
        expect(head["cwd"]).toBe(cwd);
        expect(Number(head["duration_ms"])).toBeGreaterThanOrEqual(0);
    });

    it("② 超时到点立即返回（不等 close）+ 超时文案 + timed_out/killed", async () => {
        const t0 = Date.now();
        const run = await runBash("sleep 10", process.cwd(), limits(300));
        const ms = Date.now() - t0;
        const { head, body } = splitHead(run.text);

        expect(run.outcome).toBe("timeout");
        expect(run.failed).toBe(false); // 超时是数据，不是 ✗（##332 ②）
        expect(ms).toBeLessThan(2_000); // 改前这里靠 close 兜底（杀到组才返回）；改后 300ms 即回
        expect(body).toContain("[命令超时被杀]");
        expect(head["timed_out"]).toBe("true");
        expect(head["killed"]).toBe("true");
        expect(head["exit_code"]).toBeUndefined(); // 没有退出码可言，不拿 -1 冒充
        expect(head["signal"]).toBe("SIGKILL"); // 与 run.signal 同源
        expect(run.signal).toBe("SIGKILL");
    });

    it("③ 'close' 迟到：不重复收尾、不改写已定的结局", async () => {
        // sleep 0.6 自然结束会触发 close —— 但超时（200ms）先落，close 迟到约 400ms
        const run = await runBash("sleep 0.6", process.cwd(), limits(200));
        const first = run.text;
        expect(run.outcome).toBe("timeout");
        expect(splitHead(first).head["timed_out"]).toBe("true");

        await new Promise((r) => setTimeout(r, 800)); // 等 close 迟到（改前多杀 / 二次 finish 的点）
        expect(run.text).toBe(first); // 结局对象已冻结：迟到的事件不得再写一次
        expect(run.outcome).toBe("timeout");
    });

    it("④ 后台作业持管道（离开进程组）时按超时返回，不永挂", async () => {
        const t0 = Date.now();
        // POSIX::setsid：孙进程换 session/pgid ⇒ killProcessGroup 打空、且它继承着 stdout 管道
        const cmd = `perl -e 'use POSIX; POSIX::setsid(); sleep 20' & echo started`;
        const run = await runBash(cmd, process.cwd(), limits(500));
        const ms = Date.now() - t0;
        const { head, body } = splitHead(run.text);

        expect(ms).toBeLessThan(5_000); // 改前：永不返回（close 要等 20s 的孙进程放手）
        expect(run.outcome).toBe("timeout");
        expect(head["timed_out"]).toBe("true");
        expect(body).toContain("started"); // 已经收到的输出不许丢
        expect(body).toContain("[命令超时被杀]");
    }, 15_000);

    it("⑤b 投递层截断只改头里 truncated 位，正文逐字不碰", () => {
        const text = "---\nok: true\ntruncated: false\n---\n正文里的 truncated: false 不许被改";
        const marked = markBashTruncated(text);
        expect(marked.startsWith("---\nok: true\ntruncated: true\n---\n")).toBe(true);
        expect(marked.endsWith("正文里的 truncated: false 不许被改")).toBe(true);
        // 没有头（不该发生）→ 原样返回，绝不改正文
        expect(markBashTruncated("裸文本")).toBe("裸文本");
    });

    it("⑥ 取消仍先返回（先钉 AbortError 结局，再杀组）", async () => {
        const ac = new AbortController();
        const pending = runBash("sleep 10", process.cwd(), limits(5_000), ac.signal);
        setTimeout(() => ac.abort(), 100);
        const t0 = Date.now();
        const run = await pending;
        const ms = Date.now() - t0;
        const { head, body } = splitHead(run.text);

        expect(run.outcome).toBe("canceled");
        expect(run.failed).toBe(false);
        expect(ms).toBeLessThan(2_000);
        expect(body).toBe("[已取消]");
        expect(head["timed_out"]).toBe("false");
        expect(head["killed"]).toBe("true"); // 取消也真的发了 SIGKILL（头如实记）
        expect(head["ok"]).toBe("false");
    });
});

// tests/shell-run.test.ts
// 🎯 ##515 第 1 步：`runBash` 搬进 `@diy-agent/tools` 之后**行为一条都不许变**。
//
// 这里钉的是搬包时最容易走形的那几条（原判据见 run.ts 头注 / ##332 ##353 ##418 ##454 ##419）：
//   ① 正常命令：YAML 头 + 正文逐字、exit_code 0、outcome ok
//   ② 非零退出：有 stderr = 失败（✗）；无 stderr = 查询未命中（数据，不画 ✗）
//   ③ 超时：照样返回**已收到的输出**，头里 timed_out: true，不抛错
//   ④ stdin 接 /dev/null：`cat` 立刻 EOF（不许挂住）
//   ⑤ cwd 不存在：命令没跑起来（③ 档）⇒ failed，不 reject
//   ⑥ 能力缺失（`missing`）：spawn 之前收口，给能照着办的文案
//
// ⚠️ 这些用例真跑 `bash`（走 PATH），不依赖 diy-app。

import { describe, it, expect } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FALLBACK_SHELL, runBash, type ShellLimits } from "../src/index.js";

const limits = (ms: number): ShellLimits => ({ bashTimeoutMs: ms });

/** 拆开「YAML 头 + 正文」：头 = 两个 `---` 之间；正文逐字返回（格式见 result.ts::renderBashHead） */
function splitHead(text: string): { head: Record<string, string>; body: string } {
    expect(text.startsWith("---\n"), `缺 YAML 头：${text.slice(0, 80)}`).toBe(true);
    const end = text.indexOf("\n---\n", 4);
    expect(end).toBeGreaterThan(0);
    const head: Record<string, string> = {};
    for (const line of text.slice(4, end).split("\n")) {
        const i = line.indexOf(": ");
        head[line.slice(0, i)] = line.slice(i + 2);
    }
    return { head, body: text.slice(end + 5) };
}

describe("runBash（搬包后的行为，##515）", () => {
    it("① 正常命令：头字段齐全 + 正文逐字 + outcome ok", async () => {
        const cwd = mkdtempSync(join(tmpdir(), "t515-ok-"));
        const run = await runBash('printf "a\\nb\\n"', cwd, limits(2_000));
        rmSync(cwd, { recursive: true, force: true });
        const { head, body } = splitHead(run.text);

        expect(run.outcome).toBe("ok");
        expect(run.failed).toBe(false);
        expect(run.exitCode).toBe(0);
        expect(body).toBe("a\nb\n");
        expect(head["ok"]).toBe("true");
        expect(head["exit_code"]).toBe("0");
        expect(head["timeout_ms"]).toBe("2000");
        expect(head["timed_out"]).toBe("false");
        expect(head["killed"]).toBe("false");
        expect(head["truncated"]).toBe("false");
        expect(head["cwd"]).toBe(cwd);
    });

    it("② 非零退出：有 stderr 才 ✗（无 stderr = 查询未命中，仍是数据）", async () => {
        const quiet = await runBash("exit 3", process.cwd(), limits(2_000));
        expect(quiet.outcome).toBe("fail");
        expect(quiet.exitCode).toBe(3);
        expect(quiet.failed).toBe(false); // ##353

        const loud = await runBash("echo boom >&2; exit 7", process.cwd(), limits(2_000));
        expect(loud.outcome).toBe("fail");
        expect(loud.exitCode).toBe(7);
        expect(loud.failed).toBe(true);
        expect(loud.text).toContain("boom");
    });

    it("③ 超时：已收到的输出照样返回，不抛错", async () => {
        const run = await runBash("echo started; sleep 30", process.cwd(), limits(300));
        const { head, body } = splitHead(run.text);
        expect(run.outcome).toBe("timeout");
        expect(run.failed).toBe(false); // 超时当数据（##332 ②）
        expect(head["timed_out"]).toBe("true");
        expect(head["killed"]).toBe("true");
        expect(body).toContain("started");
        expect(body).toContain("[命令超时被杀]");
    });

    it("④ stdin 是 /dev/null：`cat` 立刻 EOF，不挂住", async () => {
        const t0 = Date.now();
        const run = await runBash("cat; echo after-cat", process.cwd(), limits(5_000));
        expect(Date.now() - t0).toBeLessThan(3_000);
        expect(run.outcome).toBe("ok");
        expect(run.text).toContain("after-cat");
    });

    it("⑤ cwd 进不去：命令没跑起来 ⇒ failed，且不 reject", async () => {
        const run = await runBash("echo hi", "/etc/hosts", limits(2_000));
        expect(run.outcome).toBe("fail");
        expect(run.failed).toBe(true);
        expect(run.text).toContain("[命令未能启动");
    });

    it("⑥ 能力缺失：spawn 之前收口（不把 ENOENT 丢给模型）", async () => {
        const run = await runBash("echo hi", process.cwd(), limits(2_000), undefined, undefined, undefined, {
            ...FALLBACK_SHELL,
            missing: true,
            tried: ["/bin/bash"],
        });
        expect(run.failed).toBe(true);
        expect(run.outcome).toBe("fail");
        expect(run.text).toContain("[命令未能启动]");
        expect(run.text).toContain("已尝试：/bin/bash");
    });
});

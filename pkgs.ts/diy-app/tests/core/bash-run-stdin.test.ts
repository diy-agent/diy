// tests/core/bash-run-stdin.test.ts
// 🎯 ##418 —— `runBash` 的**子进程 stdin 必须隔离**（/dev/null），否则「读 stdin 的命令」全部挂到超时
//
// 现象：不带路径参数的 `rg` 在 bash 工具里 100% 跑满 `bashTimeoutMs`（缺省 300s）被杀，
//   与目录大小、排除规则无关；审计侧同一批命令 user CPU 只有几毫秒。
//
// 根因：`spawn("/bin/bash", ["-c", cmd], { cwd, detached: true })` 没给 `stdio` ⇒ Node 缺省
//   `['pipe','pipe','pipe']` ⇒ 子进程 fd0 是 **socketpair**（不是 tty、也不是 /dev/null）。
//   ripgrep 的启发式（`is_file / is_fifo / is_socket`，可用 `rg --debug` 直接看到）据此判
//   「stdin 可读」⇒ 放弃搜 `./`、改读 stdin ⇒ 没人写 ⇒ 阻塞到超时。
//
// 本文件钉的三条（都是真跑 /bin/bash，不 mock）：
//   ① `read` 立刻拿到 EOF（stdio 隔离的**直接**判据，不依赖 rg 装没装）；
//   ② `cat`（无参）立刻返回空输出、`outcome: "ok"`；
//   ③ `rg <模式>`（**不带路径**）在超时时间内正常搜 cwd 并命中，`outcome: "ok"`（不是 timeout）。
// 超时 / 取消 / 输出溢出三条原有判据由 bash-run-outcome.test.ts 覆盖，本文件不重复。

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runBash } from "../../src/main/services/local-agent";
import type { LocalAgentLimits } from "../../src/main/services/local-agent";

/** 只需要 bashTimeoutMs 一个字段；其余字段本测试不触发。 */
const limits = { bashTimeoutMs: 5_000 } as unknown as LocalAgentLimits;

const NEEDLE = "NEEDLE_T418_STDIN";
/** 命中目录：**故意很小**（一个文件一条命中）—— 大目录会被无关因素拖慢，掩盖真正的判据 */
let dir = "";
/** rg 不一定装（CI / 别的机器）：装了才跑 ③，缺了跳过而不是让整文件变红 */
const hasRg = spawnSync("rg", ["--version"], { stdio: "ignore" }).status === 0;

beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), "t418-stdin-"));
    writeFileSync(join(dir, "hit.txt"), `${NEEDLE}\n`, "utf-8");
});

afterAll(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
});

describe("runBash 的 stdin 隔离（##418）", () => {
    it("`read` 立刻拿到 EOF（fd0 不是 socketpair）", async () => {
        const t0 = Date.now();
        const run = await runBash('read x; echo "rc=$?"', dir, limits);
        const ms = Date.now() - t0;
        expect(run.outcome).toBe("ok");
        // /dev/null ⇒ read 立即 EOF 返回非零；socketpair 无人写 ⇒ 一直阻塞到超时
        expect(run.text).toContain("rc=1");
        expect(ms).toBeLessThan(limits.bashTimeoutMs);
    });

    it("`cat`（无参）立即返回空输出，而不是挂到超时", async () => {
        const t0 = Date.now();
        const run = await runBash("cat", dir, limits);
        const ms = Date.now() - t0;
        expect(run.outcome).toBe("ok");
        expect(run.failed).toBe(false);
        expect(run.text).toBe("(无输出)");
        expect(ms).toBeLessThan(limits.bashTimeoutMs);
    });

    it.skipIf(!hasRg)("`rg <模式>`（不带路径）搜 cwd 并命中，不读 stdin 不超时", async () => {
        const t0 = Date.now();
        const run = await runBash(`rg -n '${NEEDLE}'`, dir, limits);
        const ms = Date.now() - t0;
        expect(run.outcome).toBe("ok");
        expect(run.failed, run.text).toBe(false);
        expect(run.text).toContain("hit.txt:1:");
        expect(run.text).toContain(NEEDLE);
        expect(ms).toBeLessThan(limits.bashTimeoutMs);
    });
});

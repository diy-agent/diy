import { describe, expect, it } from "vitest";
import { runBash } from "../../src/main/services/local-agent";
import { effectiveBashArgs } from "../../src/shared/tool-args";
import type { LocalAgentLimits } from "../../src/main/services/local-agent";

/**
 * ##454 判据 ①/②/④：命令退出后不许再等孙进程（'close' 可能永远不来）。
 *
 * 复现（修前实测 999s 挂死）：`bash -c "sleep 999 &"` —— 内层 sleep 继承了 stdout 写端，
 * 外层 bash 退出后它还在写，Node 的 'close'（stdio 全关之后）永远不到。修法是挂 'exit'：
 * 命令退出 = 结局已定，最多等 EXIT_GRACE_MS（200ms）就收尾。
 */
const limits = { bashTimeoutMs: 300_000 } as unknown as LocalAgentLimits;

const elapsed = async <T>(p: Promise<T>): Promise<[T, number]> => {
    const t0 = Date.now();
    const r = await p;
    return [r, Date.now() - t0];
};

describe("runBash 退出宽限（##454）", () => {
    it("`bash -c 'sleep 999 &'`（无显式 timeout）⇒ ≤1s 返回，不再挂 999s", async () => {
        const [run, ms] = await elapsed(runBash(`bash -c 'sleep 999 &'`, process.cwd(), limits, undefined, undefined, 0));
        expect(ms).toBeLessThan(1000);
        expect(run.outcome).toBe("ok");
        expect(run.text).toContain("timeout_ms: 0");
    }, 10_000);

    it("显式 timeout 被尊重：sleep 30 + timeout 800 ⇒ ~0.8s 返回 timed_out", async () => {
        const [run, ms] = await elapsed(runBash("sleep 30", process.cwd(), limits, undefined, undefined, 800));
        expect(ms).toBeGreaterThan(600);
        expect(ms).toBeLessThan(3_000);
        expect(run.text).toContain("timed_out: true");
        expect(run.outcome).toBe("timeout");
    }, 10_000);

    it("同步语义不变：sleep 1 && echo done ⇒ 等到 done，约 1s", async () => {
        const [run, ms] = await elapsed(runBash("sleep 1 && echo done", process.cwd(), limits, undefined, undefined, 0));
        expect(ms).toBeGreaterThan(700);
        expect(run.text).toContain("done");
        expect(run.outcome).toBe("ok");
    }, 10_000);

    it("判据③ 默认不超时：sleep 5 跑满 5s 且 ok（timeout 由 effectiveBashArgs 补的 0 传入，与工具路径同源）", async () => {
        const timeoutMs = effectiveBashArgs({ command: "sleep 5" }).args.timeout as number;
        expect(timeoutMs).toBe(0);
        const [run, ms] = await elapsed(runBash("sleep 5", process.cwd(), limits, undefined, undefined, timeoutMs));
        expect(ms).toBeGreaterThan(4_500);
        expect(run.outcome).toBe("ok");
        expect(run.text).toContain("timed_out: false");
    }, 20_000);

    it("退出前的输出仍在：echo + 后台孙进程 ⇒ 文本含 echo 的内容", async () => {
        const [run] = await elapsed(runBash(`echo hello-t454; bash -c 'sleep 999 &'`, process.cwd(), limits, undefined, undefined, 0));
        expect(run.text).toContain("hello-t454");
        expect(run.outcome).toBe("ok");
    }, 10_000);
});

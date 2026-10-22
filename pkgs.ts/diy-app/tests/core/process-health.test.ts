// tests/core/process-health.test.ts
// 🎯 ##401 L1 —— 后台进程「死了还是在干活」的本地判据（`shared/process-health.ts`）
//
// 钉住的四条（缺一条就等于没判据）：
//   ① **口径**：停滞倍数 = 距末次输出时长 / 该命令历史 p50（不是绝对时长）；
//   ② **无总超时的网络命令 = stuck**（`curl` / `git fetch` / `ssh` 默认没有总超时，DNS/TLS 半死即永久挂起）——
//      这是历史上 1849 条 `nohup` 绕开超时的成因，模型会误以为「默认超时会自己失败」；
//   ③ **有界等待不打扰**（`sleep` / 带 `--max-time` 的网络客户端 ⇒ passive-wait）；
//   ④ **证据不足不下结论**（无历史 p50 且未超绝对静默下限 ⇒ unknown，不许猜 stuck）。

import { describe, it, expect } from "vitest";
import {
    DEFAULT_HEALTH_POLICY,
    judgeHealth,
    medianDuration,
    probeNetworkWait,
    type ProcessSample,
} from "../../src/shared/process-health";

function sample(over: Partial<ProcessSample> = {}): ProcessSample {
    return {
        command: "node build.js",
        runMs: 600_000,
        outputBytes: 0,
        silentMs: 600_000,
        cpuPercent: 0,
        childCount: 1,
        connections: [],
        historicalP50Ms: 5_000,
        ...over,
    };
}

describe("probeNetworkWait —— 有没有总超时上限", () => {
    it("curl 无 --max-time / --connect-timeout ⇒ 无界（默认没有总超时，会永久挂起）", () => {
        expect(probeNetworkWait("curl -s https://api.example.com/v1/models")).toEqual({
            network: true,
            bounded: false,
            client: "curl",
        });
    });

    it("curl 带 --max-time / -m / --connect-timeout ⇒ 有界", () => {
        for (const cmd of [
            "curl --max-time 30 -s https://x/y",
            "curl -m 10 -s https://x/y",
            "curl --connect-timeout 5 -s https://x/y",
        ]) {
            expect(probeNetworkWait(cmd)).toMatchObject({ network: true, bounded: true });
        }
    });

    it("git fetch / clone / pull 无 http.lowSpeedLimit ⇒ 无界；git status 不算网络", () => {
        expect(probeNetworkWait("git fetch origin main")).toMatchObject({ network: true, bounded: false });
        expect(probeNetworkWait("git clone https://x/y.git")).toMatchObject({ network: true, bounded: false });
        expect(probeNetworkWait("git status --porcelain")).toMatchObject({ network: false });
    });

    it("ssh 无 -o ConnectTimeout ⇒ 无界；带了 ⇒ 有界", () => {
        expect(probeNetworkWait("ssh user@host uptime")).toMatchObject({ network: true, bounded: false });
        expect(probeNetworkWait("ssh -o ConnectTimeout=5 user@host uptime")).toMatchObject({
            network: true,
            bounded: true,
        });
    });

    it("wget / npm 自带默认超时 ⇒ 有界（不进 stuck 判据）", () => {
        expect(probeNetworkWait("wget https://x/y.tgz")).toMatchObject({ network: true, bounded: true });
        expect(probeNetworkWait("npm i --workspaces")).toMatchObject({ network: true, bounded: true });
    });

    it("前缀词（nohup / env / sudo）不影响识别", () => {
        expect(probeNetworkWait("nohup curl -s https://x/y")).toMatchObject({ network: true, bounded: false });
    });

    it("非网络命令 ⇒ network:false", () => {
        expect(probeNetworkWait("rg -n foo src")).toMatchObject({ network: false });
        expect(probeNetworkWait("npx vitest run tests/a.test.ts")).toMatchObject({ network: false });
    });
});

describe("judgeHealth —— 三态判据", () => {
    it("R1 刚有输出（≤15s）⇒ progressing", () => {
        const d = judgeHealth(sample({ silentMs: 3_000 }));
        expect(d.verdict).toBe("progressing");
        expect(d.rule).toBe("R1:output-growing");
    });

    it("R3 curl 无总超时 + 600s 静默 + 有连接 ⇒ stuck（模型最容易漏的一条）", () => {
        const d = judgeHealth(
            sample({
                command: "curl -s https://api.example.com/provider/v1/models",
                silentMs: 600_000,
                cpuPercent: 0,
                historicalP50Ms: 400,
                connections: [{ remote: "1.2.3.4:443", state: "ESTABLISHED" }],
            }),
        );
        expect(d.verdict).toBe("stuck");
        expect(d.rule).toBe("R3:unbounded-network-wait");
        expect(d.reason).toContain("无总超时上限");
    });

    it("R3 只按「无界」成立，不在乎 p50 是否可用（无历史也要判死）", () => {
        const d = judgeHealth(
            sample({
                command: "git fetch origin",
                silentMs: 120_000,
                connections: [{ remote: "5.6.7.8:443", state: "ESTABLISHED" }],
                historicalP50Ms: null,
            }),
        );
        expect(d.verdict).toBe("stuck");
        expect(d.confidence).toBeLessThan(0.7); // 无 p50 支撑 ⇒ 置信度打折
    });

    it("R5 带 --max-time 的网络等待 ⇒ passive-wait（不打扰）", () => {
        const d = judgeHealth(
            sample({
                command: "curl --max-time 30 -s https://x/y",
                silentMs: 120_000,
                historicalP50Ms: 1_000,
                connections: [{ remote: "1.2.3.4:443", state: "ESTABLISHED" }],
            }),
        );
        expect(d.verdict).toBe("passive-wait");
        expect(d.rule).toBe("R5:bounded-passive-wait");
    });

    it("R5 sleep 到点自己会醒 ⇒ passive-wait", () => {
        const d = judgeHealth(sample({ command: "sleep 45", silentMs: 30_000, historicalP50Ms: 45_000 }));
        expect(d.verdict).toBe("passive-wait");
    });

    it("口径：停滞倍数 = 静默时长 / 历史 p50 —— 同样静默 60s，p50 5s 判死、p50 300s 不算", () => {
        const fast = judgeHealth(sample({ silentMs: 60_000, historicalP50Ms: 5_000 }));
        expect(fast.stallFactor).toBe(12); // 60_000 / 5_000
        expect(fast.verdict).toBe("stuck");
        expect(fast.rule).toBe("R4:stalled-vs-p50");

        const slow = judgeHealth(sample({ silentMs: 60_000, historicalP50Ms: 300_000 }));
        expect(slow.stallFactor).toBeLessThan(1);
        expect(slow.verdict).not.toBe("stuck");
    });

    it("R2 CPU 高 + 静默但未超倍数 ⇒ progressing（编译期不误杀）", () => {
        const d = judgeHealth(sample({ silentMs: 60_000, cpuPercent: 180, historicalP50Ms: 300_000 }));
        expect(d.verdict).toBe("progressing");
        expect(d.rule).toBe("R2:cpu-active");
    });

    it("R6 无历史 p50 且静默未到绝对下限 ⇒ unknown（不猜 stuck）", () => {
        const d = judgeHealth(sample({ silentMs: 20_000, historicalP50Ms: null, command: "some-tool --x" }));
        expect(d.verdict).toBe("unknown");
        expect(d.rule).toBe("R6:insufficient-evidence");
    });

    it("绝对静默下限生效：p50 极小也至少 60s 才可疑", () => {
        const d = judgeHealth(sample({ silentMs: 30_000, historicalP50Ms: 10 }));
        expect(d.verdict).not.toBe("stuck");
    });

    it("阈值可从外部注入（policy 不写死在判据里）", () => {
        // 静默 20s / p50 1s = 20×（≥ 阈值 10×），且静默 20s ≥ 注入的绝对下限 10s
        const d = judgeHealth(sample({ silentMs: 20_000, historicalP50Ms: 1_000 }), {
            ...DEFAULT_HEALTH_POLICY,
            stallFloorMs: 10_000,
        });
        expect(d.verdict).toBe("stuck");
    });
});

describe("medianDuration —— 历史 p50", () => {
    it("不足 3 条 ⇒ null（噪声太大不做判据）", () => {
        expect(medianDuration([1_000, 2_000])).toBeNull();
    });

    it("奇数条取中位、偶数条取中间两数均值", () => {
        expect(medianDuration([3_000, 1_000, 2_000])).toBe(2_000);
        expect(medianDuration([1_000, 2_000, 3_000, 4_000])).toBe(2_500);
    });
});

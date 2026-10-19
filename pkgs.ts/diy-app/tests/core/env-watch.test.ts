// tests/core/env-watch.test.ts
// ═══════════════════════════════════════════════════════════════
// ##384「环境感知」判据 —— 表驱动，**穷举边界**。
//
// 为什么必须纯函数 + 表驱动：判据若埋在服务里，"磁盘剩 500Mi 算不算满"这件事就只能靠
// 真把盘填满来验（2026-10-18 已经因此毁过 ##166 正文一次）。纯函数让阈值与错误码族
// 变成**可断言的常量**，注入假 statfs / 假异常就能覆盖所有边界。
//
// 覆盖三块：
//   ① 磁盘水位（ok / low / full + 阈值两侧各 1 字节）
//   ② 网络错误码族（6 个码 + 非网络错误 + 无码）
//   ③ 通知组装（形状符合 `rule.discriminated-union`、写失败被动升级不看水位）
// ═══════════════════════════════════════════════════════════════

import { describe, it, expect } from "vitest";
import {
    classifyDisk,
    classifyNetworkError,
    envNoticeFromDisk,
    envNoticeFromNetwork,
    envNoticeFromWriteError,
    fmtDiskBytes,
    networkStreakVerdict,
    probeNetworkError,
    slotOf,
    DISK_FULL_MAX_AVAIL_BYTES,
    DISK_LOW_MAX_AVAIL_BYTES,
    NETWORK_ERROR_CODES,
    NETWORK_FAIL_STREAK,
    EnvNoticeSchema,
    type DiskSample,
} from "../../src/shared/env-watch";

const GiB = 1024 ** 3;
const MiB = 1024 ** 2;
const sample = (availBytes: number, totalBytes = 500 * GiB, mount = "/"): DiskSample => ({
    mount,
    availBytes,
    totalBytes,
});

describe("磁盘水位判据（阈值定死在纯函数里）", () => {
    // 表驱动：每一行都是"这个数字该判成什么"的**断言**（含阈值两侧各 1 字节）
    const cases: Array<{ name: string; avail: number; level: "ok" | "low" | "full" }> = [
        { name: "完全写满（0 字节）", avail: 0, level: "full" },
        { name: "可用 1 字节", avail: 1, level: "full" },
        { name: "满阈值 −1（512Mi−1）", avail: DISK_FULL_MAX_AVAIL_BYTES - 1, level: "full" },
        { name: "满阈值本身（512Mi）→ 不算满", avail: DISK_FULL_MAX_AVAIL_BYTES, level: "low" },
        { name: "低阈值 −1（2Gi−1）", avail: DISK_LOW_MAX_AVAIL_BYTES - 1, level: "low" },
        { name: "低阈值本身（2Gi）→ 正常", avail: DISK_LOW_MAX_AVAIL_BYTES, level: "ok" },
        { name: "充裕（166G）", avail: 166 * GiB, level: "ok" },
    ];
    for (const c of cases) {
        it(`${c.name} → ${c.level}`, () => {
            expect(classifyDisk(sample(c.avail)).level).toBe(c.level);
        });
    }

    it("阈值是导出的常量（单测锁住数值，改阈值必须同时改这里）", () => {
        expect(DISK_FULL_MAX_AVAIL_BYTES).toBe(512 * MiB);
        expect(DISK_LOW_MAX_AVAIL_BYTES).toBe(2 * GiB);
    });

    it("ok 也给理由（日志里能看到「为什么没报」）", () => {
        expect(classifyDisk(sample(100 * GiB)).reason).toContain("充足");
    });
});

describe("网络错误码族", () => {
    it("六个码全部命中（判据表即事实清单）", () => {
        expect([...NETWORK_ERROR_CODES]).toEqual([
            "ENOTFOUND",
            "EAI_AGAIN",
            "ECONNREFUSED",
            "ENETUNREACH",
            "ETIMEDOUT",
            "ECONNRESET",
        ]);
        for (const code of NETWORK_ERROR_CODES) {
            const v = classifyNetworkError({ code, message: "x" });
            expect(v.hit, code).toBe(true);
            expect(v.code).toBe(code);
        }
    });

    it("非网络错误码不算（上游有响应 = 网络通着）", () => {
        for (const code of ["ENOSPC", "EACCES", "HTTP_500", "ERR_BAD_REQUEST"]) {
            const v = classifyNetworkError({ code, message: "x" });
            expect(v.hit, code).toBe(false);
            expect(v.reason).toContain(code);
        }
    });

    it("没有错误码不算，且理由说清「无法判定」", () => {
        const v = classifyNetworkError({ code: null, message: "boom" });
        expect(v.hit).toBe(false);
        expect(v.reason).toContain("无法判定");
    });
});

describe("连败阈值", () => {
    it(`连续 ${NETWORK_FAIL_STREAK} 次才算断网（阈值两侧）`, () => {
        expect(networkStreakVerdict(NETWORK_FAIL_STREAK - 1).down).toBe(false);
        expect(networkStreakVerdict(NETWORK_FAIL_STREAK).down).toBe(true);
        expect(networkStreakVerdict(NETWORK_FAIL_STREAK + 5).down).toBe(true);
        expect(NETWORK_FAIL_STREAK).toBe(3);
    });
});

describe("异常探测（结构化读取，不依赖具体错误类）", () => {
    it("从 Error 上取 code / message", () => {
        const e = Object.assign(new Error("getaddrinfo ENOTFOUND api.example.com"), { code: "ENOTFOUND" });
        expect(probeNetworkError(e)).toEqual({ code: "ENOTFOUND", message: "getaddrinfo ENOTFOUND api.example.com" });
    });

    it("顺着 cause / lastError 往下一层找（SDK 会包一层）", () => {
        const inner = Object.assign(new Error("connect ETIMEDOUT"), { code: "ETIMEDOUT" });
        expect(probeNetworkError({ message: "RetryError", lastError: inner }).code).toBe("ETIMEDOUT");
        expect(probeNetworkError({ message: "wrapped", cause: inner }).code).toBe("ETIMEDOUT");
    });

    it("压缩空白 + 截断（bar 上放不下长正文）", () => {
        const long = "x".repeat(500);
        const p = probeNetworkError(Object.assign(new Error(`  a\n\n  b  ${long}`), { code: "ETIMEDOUT" }));
        expect(p.message.startsWith("a b ")).toBe(true);
        expect(p.message.length).toBe(200);
    });

    it("非对象也能探（字符串抛出的历史代码）", () => {
        expect(probeNetworkError("plain failure").message).toBe("plain failure");
    });
});

describe("通知组装（rule.discriminated-union：type 同级 = 公共字段，私有数据全进 data）", () => {
    it("disk-full：level=error，数字进 data，形状过 schema", () => {
        const n = envNoticeFromDisk(sample(100 * MiB), "poll", new Date("2026-10-19T00:00:00Z"));
        expect(n?.type).toBe("disk-full");
        expect(n?.level).toBe("error");
        expect(n?.id).toMatch(/^env-disk-full-/);
        expect(n?.data).toMatchObject({ mount: "/", availBytes: 100 * MiB, totalBytes: 500 * GiB, source: "poll" });
        expect(EnvNoticeSchema.safeParse(n).success).toBe(true);
    });

    it("disk-low：level=warn（提醒，不是硬失败）", () => {
        const n = envNoticeFromDisk(sample(1 * GiB), "poll");
        expect(n?.type).toBe("disk-low");
        expect(n?.level).toBe("warn");
    });

    it("水位 ok → null（调用方据此决定要不要报警）", () => {
        expect(envNoticeFromDisk(sample(100 * GiB), "poll")).toBeNull();
    });

    it("网络未达阈值 → null；达阈值 → network-down / error / 带连败次数", () => {
        const probe = { code: "ETIMEDOUT", message: "connect ETIMEDOUT" };
        expect(envNoticeFromNetwork(probe, NETWORK_FAIL_STREAK - 1)).toBeNull();
        const n = envNoticeFromNetwork(probe, NETWORK_FAIL_STREAK);
        expect(n?.type).toBe("network-down");
        expect(n?.level).toBe("error");
        expect(n?.data).toMatchObject({ code: "ETIMEDOUT", streak: NETWORK_FAIL_STREAK });
        expect(EnvNoticeSchema.safeParse(n).success).toBe(true);
    });

    it("写失败被动升级：即使水位已经 ok（刚腾出来）也照样亮 disk-full", () => {
        // 这是本判据最容易写错的一处：走 envNoticeFromDisk 会被 ok→null 吞掉
        expect(envNoticeFromDisk(sample(100 * GiB), "write-error")).toBeNull();
        const n = envNoticeFromWriteError(sample(100 * GiB), new Date("2026-10-19T00:00:00Z"));
        expect(n.type).toBe("disk-full");
        expect(n.level).toBe("error");
        // 判别联合：收窄到磁盘分支才读 data 的私有字段
        expect(n.type === "disk-full" || n.type === "disk-low" ? n.data.source : null).toBe("write-error");
        expect(n.data.reason).toContain("ENOSPC");
        expect(EnvNoticeSchema.safeParse(n).success).toBe(true);
    });

    it("写失败 + 连水位都读不到：照发，且理由说明「读不到」（不编数字）", () => {
        const n = envNoticeFromWriteError(null);
        expect(n.type).toBe("disk-full");
        expect(n.type === "disk-full" || n.type === "disk-low" ? n.data.availBytes : null).toBe(-1); // 哨兵：bar 侧据此显示"读不到"
        expect(n.data.reason).toContain("读不到");
    });

    it("id 唯一（同一毫秒多条也不撞）", () => {
        const now = new Date("2026-10-19T00:00:00Z");
        const ids = new Set(
            Array.from({ length: 5 }, () => envNoticeFromDisk(sample(10 * MiB), "poll", now)?.id),
        );
        expect(ids.size).toBe(5);
    });
});

describe("slotOf（去重键 —— main 与 renderer **同源**，##384 review1 R1）", () => {
    const disk = (mount: string, avail = 10 * MiB) => envNoticeFromDisk(sample(avail, 500 * GiB, mount), "poll")!;
    const net = () => envNoticeFromNetwork({ code: "ENOTFOUND", message: "dns fail" }, NETWORK_FAIL_STREAK)!;

    it("磁盘按**挂载点**分槽：两个卷各占一槽（多卷时界面不会把两条合成一条）", () => {
        expect(slotOf(disk("/"))).toBe("disk:/");
        expect(slotOf(disk("/Volumes/probe"))).toBe("disk:/Volumes/probe");
        expect(slotOf(disk("/"))).not.toBe(slotOf(disk("/Volumes/probe")));
    });

    it("同一卷的 disk-full 与 disk-low **同槽**（同一件事的两种水位，互相替换而非并存）", () => {
        const full = envNoticeFromDisk(sample(10 * MiB), "poll")!;
        const low = envNoticeFromDisk(sample(1 * GiB), "poll")!;
        expect(full.type).toBe("disk-full");
        expect(low.type).toBe("disk-low");
        expect(slotOf(full)).toBe(slotOf(low));
    });

    it("网络通知各占一槽（network-down 是全局事实，与卷无关）", () => {
        expect(slotOf(net())).toBe("network-down");
    });
});

describe("fmtDiskBytes（bar 上的数字证据）", () => {
    const cases: Array<[number, string]> = [
        [0, "0 B"],
        [512, "512 B"],
        [1024, "1 K"],
        [512 * MiB, "512.0 M"],
        [322_122_547, "307.2 M"], // 0.3 GiB 量级：精确到 M 比"0.3 G"更有用
        [166 * GiB, "166.0 G"],
        [2 * 1024 ** 4, "2.0 T"],
    ];
    for (const [n, want] of cases) {
        it(`${n} → ${want}`, () => expect(fmtDiskBytes(n)).toBe(want));
    }
});

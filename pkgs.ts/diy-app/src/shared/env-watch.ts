/**
 * env-watch.ts — 「机器环境坏了」的**唯一判据**（纯函数；main 与 renderer 同源，##384）。
 *
 * 为什么要有这一份：2026-10-18 / 10-19 两次**磁盘满**，症状都是「卡住」而不是「报错」——
 * `diy task edit` 报 ENOSPC 后正文被写成 0 字节（##166）、源码编辑「脚本说成功、文件里却没有」
 * （##377 会话两次）。agent 与用户都只能靠 `du` / `lsof` 猜。**环境坏了必须自己出声，且带数字**。
 *
 * 与 ##369（模型不可用）的分工：那次解决「上游/模型坏了没人知道」，这里解决「**机器环境**
 * 坏了没人知道」。两者都是「沉默的失败」→ 顶栏 bar，但判据来源完全不同（那边看上游语义，
 * 这边看本地水位与错误码），故判据各自独立、通知通道共用一个形状。
 *
 * 边界（刻意只判两类，**不多不少**）：
 *   · 磁盘 —— 可用字节数水位（`statfs` 的 `bavail * bsize`），阈值**定死在本文件**
 *   · 网络 —— 错误码族（DNS / 连接被拒 / 网络不可达 / 超时 / 连接重置）**连续 N 次**
 *
 * `navigator.onLine` 只能当辅助、不能当判据：Electron 里它只反映网卡状态，不反映上游可达
 * （本仓已有前例：`src/main/index.ts` 记的 IPv6 ENETUNREACH 事故，网卡好着但上游连不上）。
 *
 * 纯函数：不碰 fs / 网络 / Date，输入即事实 —— 表驱动单测因此能穷举边界
 * （tests/core/env-watch.test.ts）。
 */

import { z } from "zod";

// ═══════════════════════════════════════════════
//  磁盘水位判据
// ═══════════════════════════════════════════════

/** `full` 阈值：可用 < 512 MiB —— 这个量级下「写一个任务 body」都可能 ENOSPC */
export const DISK_FULL_MAX_AVAIL_BYTES = 512 * 1024 * 1024;
/** `low` 阈值：可用 < 2 GiB —— 该腾空间了，但还没到写失败 */
export const DISK_LOW_MAX_AVAIL_BYTES = 2 * 1024 * 1024 * 1024;

export type DiskLevel = "ok" | "low" | "full";

/** 一次磁盘水位采样（`statfs` 的可用/总量 + 挂载点，都是事实，不含判断） */
export interface DiskSample {
    /** 挂载点（bar 上要写「哪个卷」） */
    mount: string;
    /** 可用字节数（`bavail * bsize`） */
    availBytes: number;
    /** 总字节数（`blocks * bsize`） */
    totalBytes: number;
}

export interface DiskVerdict {
    level: DiskLevel;
    /** 人读理由（bar 的小字 / 单测断言用）；`ok` 也给一句，便于日志里看到"为什么没报" */
    reason: string;
}

/**
 * 判据表：**顺序即优先级**（第一条命中即返回）。表驱动而非 if 链：加一档只加一行，
 * 单测也能逐行对照"这条为什么算/不算"。
 */
const DISK_RULES: ReadonlyArray<{ level: Exclude<DiskLevel, "ok">; reason: string; test: (s: DiskSample) => boolean }> = [
    {
        level: "full",
        reason: `可用空间不足 ${DISK_FULL_MAX_AVAIL_BYTES / 1024 / 1024} MiB：写入随时会失败（ENOSPC）`,
        test: (s) => s.availBytes < DISK_FULL_MAX_AVAIL_BYTES,
    },
    {
        level: "low",
        reason: `可用空间不足 ${DISK_LOW_MAX_AVAIL_BYTES / 1024 / 1024 / 1024} GiB：接近满盘，该腾空间了`,
        test: (s) => s.availBytes < DISK_LOW_MAX_AVAIL_BYTES,
    },
];

/** 判「这个卷现在什么水位」。 */
export function classifyDisk(s: DiskSample): DiskVerdict {
    for (const rule of DISK_RULES) {
        if (rule.test(s)) return { level: rule.level, reason: rule.reason };
    }
    return { level: "ok", reason: "可用空间充足" };
}

// ═══════════════════════════════════════════════
//  网络可达判据
// ═══════════════════════════════════════════════

/**
 * 「网络断了」的错误码族（Node 的 `err.code`）。
 *
 * 只收**连接层**失败：上游回了 HTTP 状态码（哪怕 5xx）说明网络通着，那是另一类问题
 * （##369 已单独处理模型不可用）。混进来会让 bar 天天亮（告警疲劳）。
 */
export const NETWORK_ERROR_CODES = [
    "ENOTFOUND", // DNS 解析不到（断网 / DNS 黑洞）
    "EAI_AGAIN", // DNS 临时失败
    "ECONNREFUSED", // 连接被拒（上游没起 / 端口错）
    "ENETUNREACH", // 网络不可达（本仓 IPv6 事故的码）
    "ETIMEDOUT", // 连接超时
    "ECONNRESET", // 连接被重置
] as const;
export type NetworkErrorCode = (typeof NETWORK_ERROR_CODES)[number];

/** 连续失败多少次才认「网络断了」：一次失败可能只是偶发抖动 */
export const NETWORK_FAIL_STREAK = 3;

/** 从异常里取到的事实（各字段可缺：错误链上形状不止一种） */
export interface NetworkProbe {
    /** Node 错误码（拿不到 = null） */
    code: string | null;
    /** 错误消息（压缩空白后截断，给用户看） */
    message: string;
}

/** 错误消息展示上限（bar 上放不下长正文） */
export const MAX_NETWORK_MESSAGE_CHARS = 200;

/** 探测深度上限：SDK 会把底层错误包在 `cause` / `lastError` 里 */
const MAX_PROBE_DEPTH = 4;

function asRecord(v: unknown): Record<string, unknown> | null {
    return typeof v === "object" && v !== null ? (v as Record<string, unknown>) : null;
}

/**
 * 从任意抛出的值里抽出 {@link NetworkProbe}：按名字读 `code` / `message`，
 * 顺着 `cause` / `lastError` 往下一层找（结构化读取，不依赖具体错误类）。
 */
export function probeNetworkError(e: unknown): NetworkProbe {
    let code: string | null = null;
    let message = "";
    let cur: unknown = e;
    for (let depth = 0; depth < MAX_PROBE_DEPTH && cur != null; depth++) {
        const o = asRecord(cur);
        if (!o) {
            if (typeof cur === "string" && !message) message = cur;
            break;
        }
        if (code === null && typeof o["code"] === "string" && o["code"]) code = o["code"];
        if (!message && typeof o["message"] === "string" && o["message"]) message = o["message"];
        cur = o["cause"] ?? o["lastError"] ?? null;
    }
    return { code, message: message.replace(/\s+/g, " ").trim().slice(0, MAX_NETWORK_MESSAGE_CHARS) };
}

export interface NetworkVerdict {
    /** 这条错误算不算「网络层失败」（计入连败） */
    hit: boolean;
    /** 命中的错误码（不命中 = null） */
    code: NetworkErrorCode | null;
    /** 人读理由（为什么算 / 为什么不算） */
    reason: string;
}

/** 判「这一次失败是不是网络层失败」。命中才计入连败。 */
export function classifyNetworkError(p: NetworkProbe): NetworkVerdict {
    const code = p.code as NetworkErrorCode | null;
    if (code && (NETWORK_ERROR_CODES as readonly string[]).includes(code)) {
        return { hit: true, code, reason: `网络层失败（${code}）` };
    }
    if (!p.code) {
        return { hit: false, code: null, reason: "没有错误码：无法判定是网络层失败" };
    }
    return { hit: false, code: null, reason: `${p.code}：不是网络层失败（上游有响应或本地其它错误）` };
}

export interface NetworkStreakVerdict {
    /** 是否已达「网络断了」的判定线 */
    down: boolean;
    reason: string;
}

/**
 * 连败计数 → 判定。`NETWORK_FAIL_STREAK` 次连续网络层失败才算断网：
 * 单次失败可能只是抖动，而一旦亮 bar 就必须是可信信号（否则用户学会无视它）。
 */
export function networkStreakVerdict(streak: number): NetworkStreakVerdict {
    if (streak >= NETWORK_FAIL_STREAK) {
        return { down: true, reason: `连续 ${streak} 次网络层失败（阈值 ${NETWORK_FAIL_STREAK} 次）` };
    }
    return { down: false, reason: `连续失败 ${streak} 次，未达阈值 ${NETWORK_FAIL_STREAK} 次` };
}

// ═══════════════════════════════════════════════
//  通知契约（RPC 输出 / renderer 消费 / CLI 打印共用同一份 zod）
// ═══════════════════════════════════════════════

/**
 * 一条环境通知的形状：`{ id, ts, type, level, data }`（`rule.discriminated-union`）。
 *   · `type` 是判别键，与它同级的 `id` / `ts` / `level` = **所有分支共有**；
 *   · 分支私有数据（哪个卷 / 剩多少 / 连败几次 / 探测时刻来源）**全进 `data`**。
 *
 * 这样「环境感知模块」的骨架就定死了：将来加 CPU / 内存 / 上游整体不可达，只加一个 `type`
 * 分支 + 它自己的 `data`，bar 与 RPC 一行不用改。
 */
export const EnvNoticeTypeSchema = z.enum(["disk-full", "disk-low", "network-down"]);
export type EnvNoticeType = z.infer<typeof EnvNoticeTypeSchema>;

/** 磁盘分支的私有数据：**必须带数字**（"更明确的识别"= 给数字，不是给形容词） */
export const EnvDiskDataSchema = z.object({
    /** 哪个卷（挂载点） */
    mount: z.string(),
    /** 可用字节数 */
    availBytes: z.number(),
    /** 总字节数 */
    totalBytes: z.number(),
    /** 这条事实从哪来：主动轮询 / 写失败被动升级（用户据此知道要不要怀疑丢数据） */
    source: z.enum(["poll", "write-error"]),
    /** 判据理由（人读） */
    reason: z.string(),
});

/** 网络分支的私有数据 */
export const EnvNetworkDataSchema = z.object({
    /** 最后一次失败的错误码（无码 = null） */
    code: z.string().nullable(),
    /** 连续失败次数 */
    streak: z.number(),
    /** 最后一次失败的错误消息（截断） */
    message: z.string(),
    /** 判据理由（人读） */
    reason: z.string(),
});

const NoticeBase = { id: z.string(), ts: z.string() };

export const EnvNoticeSchema = z.discriminatedUnion("type", [
    z.object({ ...NoticeBase, type: z.literal("disk-full"), level: z.literal("error"), data: EnvDiskDataSchema }),
    z.object({ ...NoticeBase, type: z.literal("disk-low"), level: z.literal("warn"), data: EnvDiskDataSchema }),
    z.object({ ...NoticeBase, type: z.literal("network-down"), level: z.literal("error"), data: EnvNetworkDataSchema }),
]);
export type EnvNotice = z.infer<typeof EnvNoticeSchema>;

let seq = 0;
/** 幂等 id（dismiss 用它）：`env-<type>-<ms>-<seq>` —— 同一毫秒内多条也不撞 */
function nextId(type: EnvNoticeType, now: Date): string {
    return `env-${type}-${now.getTime()}-${++seq}`;
}

/** 磁盘采样 + 判据 → 通知。**只在水位不是 ok 时返回**（调用方据此决定要不要报警）。 */
export function envNoticeFromDisk(
    sample: DiskSample,
    source: "poll" | "write-error",
    now = new Date(),
): EnvNotice | null {
    const v = classifyDisk(sample);
    if (v.level === "ok") return null;
    const data = { mount: sample.mount, availBytes: sample.availBytes, totalBytes: sample.totalBytes, source, reason: v.reason };
    // 两个分支各自成字面量（判别联合要求 `type` 与 `level` 同时收窄，不能拼一个变量）
    if (v.level === "full") {
        return { id: nextId("disk-full", now), ts: now.toISOString(), type: "disk-full", level: "error", data };
    }
    return { id: nextId("disk-low", now), ts: now.toISOString(), type: "disk-low", level: "warn", data };
}

/** 连败事实 → 通知。**未达阈值返回 null**（偶发抖动不该亮 bar）。 */
export function envNoticeFromNetwork(probe: NetworkProbe, streak: number, now = new Date()): EnvNotice | null {
    const v = networkStreakVerdict(streak);
    if (!v.down) return null;
    return {
        id: nextId("network-down", now),
        ts: now.toISOString(),
        type: "network-down",
        level: "error",
        data: { code: probe.code, streak, message: probe.message, reason: v.reason },
    };
}



/**
 * 订阅事件（`env.watch` 的 chunk 形状）：**显式两态**，而不是"用负 id 表示撤销"。
 *
 * 为什么需要 `resolve` 这一态：环境通知与「模型不可用」不同 —— 条件是**持续的**
 * （满盘 / 网断），所以必须能**自动消**（空间腾出来、网恢复了，红条自己消失），
 * 不要用户手动关。若只推增量，bar 侧就无从知道"它已经好了"（只能靠再拉一次全量猜）。
 */
export const EnvNoticeEventSchema = z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("upsert"), data: EnvNoticeSchema }),
    z.object({ kind: z.literal("resolve"), data: z.object({ id: z.string() }) }),
]);
export type EnvNoticeEvent = z.infer<typeof EnvNoticeEventSchema>;

/**
 * 写失败（`err.code === "ENOSPC"`）**被动升级**成 `disk-full`：不等下一轮轮询。
 *
 * 为什么单独一个入口：这条事实来自**已经发生**的写失败（##382 之后数据不会再丢，但"这次
 * 为什么写失败"必须立刻可见），而水位可能刚被腾出来（`statfs` 已经 ok）—— 若走
 * {@link envNoticeFromDisk} 的 `ok → null` 规则，最该亮的那一次反而会被吞掉。
 * `sample` 为 null = 连水位都读不到（极端情况），通知照发，理由里说明"读不到"。
 */
export function envNoticeFromWriteError(sample: DiskSample | null, now = new Date()): EnvNotice {
    return {
        id: nextId("disk-full", now),
        ts: now.toISOString(),
        type: "disk-full",
        level: "error",
        data: {
            mount: sample?.mount ?? "",
            availBytes: sample?.availBytes ?? -1,
            totalBytes: sample?.totalBytes ?? -1,
            source: "write-error",
            reason: sample
                ? "写失败：磁盘满（ENOSPC）—— 这次写入没成功，腾出空间后重试"
                : "写失败：磁盘满（ENOSPC），且连可用空间都读不到（卷可能已不可访问）",
        },
    };
}

/**
 * 人类可读字节数（bar 上的数字证据）。
 *
 * 与 `shared/context/compaction.ts::fmtBytes` 分开写：那份是**上下文预算**口径（只到 MB，
 * 小数值精确到 KB 就够），这里要看**磁盘水位**（几百 G 到几百 M 都要可读，且 `0.3 G`
 * 这种量级正是用户判断"还剩多少"的关键）。两处口径不同，别互相借用。
 */
export function fmtDiskBytes(n: number): string {
    const abs = Math.abs(n);
    if (abs >= 1024 ** 4) return `${(n / 1024 ** 4).toFixed(1)} T`;
    if (abs >= 1024 ** 3) return `${(n / 1024 ** 3).toFixed(1)} G`;
    if (abs >= 1024 ** 2) return `${(n / 1024 ** 2).toFixed(1)} M`;
    if (abs >= 1024) return `${Math.round(n / 1024)} K`;
    return `${n} B`;
}

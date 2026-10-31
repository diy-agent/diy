// src/main/core/cache-hint-store.ts
// 🎯 冷缓存边界的**落盘层**（##477）：`$DIY_HOME/cache-hint.yaml` 读写。
//
// 为什么不塞进 state.yaml：那是 profiles / subjects 的权威注册表，`saveState` 只重建这两块
// （其它键会被整份覆盖丢掉）。边界的写入节奏是「每次首步请求」，与 state 的「人/agent 交互」
// 差一个量级 —— 混进去既会互相踩，也会让 state 的 fsync 变成热路径。
//
// 判据不在这里：算法全在 `shared/cache-hint.ts`（纯函数、表驱动单测）。本文件只做三件事：
// 读成 `Record<channel, ChannelStats>`、把 samples 的投影（safePoint）写正、原子写盘。
//
// 数据定性 = **store**（不是流水）：它是「下次启动直接用的边界」，坏了就该退到缺省值
// （safePoint=60s / failPoint=+∞ = 不提示），绝不能因为读失败把整个 app 卡住。

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import * as yaml from "js-yaml";
import { writeFileAtomic } from "./atomic-write";
import { emptyChannelStats, safePointOf, type ChannelStats } from "../../shared/cache-hint";
import { localISOString } from "@diy-agent/time";

/** 落盘版本：结构不兼容时整份忽略（宁可退回没历史，也不要拿半懂的字段算数） */
export const CACHE_HINT_STORE_VERSION = 1;

export interface CacheHintStore {
    version: number;
    channels: Record<string, ChannelStats>;
}

export function cacheHintFile(home: string): string {
    return join(home, "cache-hint.yaml");
}

const isNum = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);

/** 一条渠道的宽松归一：坏字段各回缺省（一个个读，不让一处坏掉整份） */
function normalizeStats(raw: unknown, nowIso: string): ChannelStats | null {
    if (!raw || typeof raw !== "object") return null;
    const o = raw as Record<string, unknown>;
    const base = emptyChannelStats(nowIso);
    const samples = Array.isArray(o["samples"]) ? o["samples"].filter(isNum).filter((g) => g > 0) : [];
    const failRaw = o["failPoint"];
    const hintsRaw = (o["hints"] ?? {}) as Record<string, unknown>;
    return {
        // samples 是事实、safePoint 是投影：读回一律重算（手改投影不改行为）
        safePoint: safePointOf(samples),
        failPoint: isNum(failRaw) && failRaw > 0 ? failRaw : null,
        samples,
        updatedAt: typeof o["updatedAt"] === "string" ? o["updatedAt"] : base.updatedAt,
        lastRequestAt: isNum(o["lastRequestAt"]) && o["lastRequestAt"] > 0 ? o["lastRequestAt"] : null,
        hints: {
            date: typeof hintsRaw["date"] === "string" ? hintsRaw["date"] : "",
            count: isNum(hintsRaw["count"]) && hintsRaw["count"] >= 0 ? hintsRaw["count"] : 0,
        },
    };
}

/** 读 store。文件不存在 / 坏 / 版本不符 → 空 store（**不抛**：边界缺失等于"不提示"）。 */
export function loadCacheHintStore(home: string, now = new Date()): CacheHintStore {
    const p = cacheHintFile(home);
    const empty: CacheHintStore = { version: CACHE_HINT_STORE_VERSION, channels: {} };
    // 判据必须在 prepareStep（同步钩子）里拿到边界 —— 真发前要同步决定"提不提示"，改异步会把整条判定链染成 async
    if (!existsSync(p)) return empty; // sync-io-ok: 同上；文件是几百 B 的 YAML（与 context-config 的读侧同一取舍）
    let raw: unknown;
    try {
        raw = yaml.load(readFileSync(p, "utf-8")); // sync-io-ok: 同上 —— 读侧本来就同步，不在这里新造异步链
    } catch (e) {
        console.warn(`[cache-hint] ${p} 解析失败，按"无历史"处理（不提示）:`, e);
        return empty;
    }
    if (!raw || typeof raw !== "object") return empty;
    const o = raw as Record<string, unknown>;
    if (o["version"] !== CACHE_HINT_STORE_VERSION) {
        console.warn(`[cache-hint] ${p} 版本 ${String(o["version"])} 与当前 ${CACHE_HINT_STORE_VERSION} 不符，整份忽略`);
        return empty;
    }
    const channelsRaw = o["channels"];
    if (!channelsRaw || typeof channelsRaw !== "object") return empty;
    const nowIso = localISOString(now);
    const channels: Record<string, ChannelStats> = {};
    for (const [key, val] of Object.entries(channelsRaw as Record<string, unknown>)) {
        const stats = normalizeStats(val, nowIso);
        if (stats) channels[key] = stats;
    }
    return { version: CACHE_HINT_STORE_VERSION, channels };
}

/** 写 store（原子：tmp → rename）。写前把 safePoint 投影对齐 samples。 */
export function saveCacheHintStore(home: string, store: CacheHintStore): void {
    const channels: Record<string, ChannelStats> = {};
    for (const [key, stats] of Object.entries(store.channels)) {
        channels[key] = { ...stats, safePoint: safePointOf(stats.samples) };
    }
    const body = yaml.dump(
        { version: CACHE_HINT_STORE_VERSION, channels },
        { indent: 2, noRefs: true, lineWidth: 200 },
    );
    writeFileAtomic(cacheHintFile(home), body);
}

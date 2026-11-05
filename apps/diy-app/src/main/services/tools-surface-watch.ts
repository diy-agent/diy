// src/main/services/tools-surface-watch.ts
// 🎯 工具面漂移的**启动时预报**（##519）：换 build 后首个请求必然整段全价，早知道早决策。
//
// 为什么必须"事先"：`tools` 段在 wire 上排在 **system 之前**，改一个字节 ⇒ 整段前缀缓存作废，
// 那一步按全价计费（实测 300k 上下文 ≈ $0.045）。等到真发那一步再 log，钱已经花了
// （`local-agent` 里那条 `工具面变更 ⇒ 本轮首步整段失配` 属于**最后一次确认**，不是预报）。
//
// 判据只有一个：**启动时算一次当前工具面的 hash，与上次启动落下的那份比**。
//   · 相同 ⇒ 什么都不说（重启本身不花钱：字节没变，缓存照样命中；##519 实测过）；
//   · 不同 ⇒ 出声，并说清代价（下一个请求的全价 ≈ 该任务上下文）。
//
// 为什么不用 steps.jsonl 的 `toolsHash` 比：那是"每任务一条"，启动时要把所有会话都读一遍才知道
// 各任务的现状；而"这次 build 有没有改工具面"是**进程级事实**，一个全局标记就够，O(1)。
//
// ⚠️ 本文件只做「记账 + 判定」；hash 怎么算由调用方给（`sha256Hex(JSON.stringify(buildTools(...)))`
// 与真发快照的口径逐字相同，见 `local-agent` 的 `step.toolsHash`）。

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import * as yaml from "js-yaml";
import { writeFileAtomic } from "../core/atomic-write";
import { localISOString } from "@diy-agent/time";

/** 落盘版本：结构不兼容时整份忽略（宁可当作"没有上次记录"，也不要拿半懂的字段报警） */
export const TOOLS_SURFACE_VERSION = 1;

export interface ToolsSurfaceRecord {
    version: number;
    /** 上次启动时的工具面 hash（与 `steps.jsonl` 的 `toolsHash` 同一口径） */
    hash: string;
    /** 上次启动时刻（ISO，本地时区） */
    at: string;
}

export function toolsSurfaceFile(home: string): string {
    return join(home, "tools-surface.yaml");
}

/**
 * 读上次的记录；没有 / 坏了 / 版本不认识 ⇒ null（= 首次启动或老数据，不报警）。
 *
 * // sync-io-ok: 只在**启动路径**调一次（`##519` 的「启动时预报」），
 * //   一次几十字节的读，改异步等于给启动流程加一个 await 点而收益为零。
 * //   app 里禁止同步 IO 的判据是「别阻塞主进程的稳态」，启动那一下不在其中。
 */
export function readToolsSurfaceRecord(home: string): ToolsSurfaceRecord | null {
    const file = toolsSurfaceFile(home);
    if (!existsSync(file)) return null; // sync-io-ok: 同上（启动一次）
    try {
        const raw = yaml.load(readFileSync(file, "utf-8")) as Record<string, unknown> | null; // sync-io-ok: 启动一次
        if (!raw || typeof raw !== "object") return null;
        if (raw["version"] !== TOOLS_SURFACE_VERSION) return null;
        const hash = raw["hash"];
        if (typeof hash !== "string" || hash === "") return null;
        return {
            version: TOOLS_SURFACE_VERSION,
            hash,
            at: typeof raw["at"] === "string" ? raw["at"] : "",
        };
    } catch {
        return null;
    }
}

export function writeToolsSurfaceRecord(home: string, hash: string, at = localISOString()): void {
    const rec: ToolsSurfaceRecord = { version: TOOLS_SURFACE_VERSION, hash, at };
    // 编码由 `writeFileAtomic` 自己定（它总是 utf-8）；这里只声明「掉电耐久」—— 它是一份账，
    // 丢了不致命，但留着才能下次比得出「工具面到底变没变」。
    writeFileAtomic(toolsSurfaceFile(home), yaml.dump(rec, { lineWidth: 200 }), { fsync: true });
}

export interface ToolsSurfaceDrift {
    /** 这次 build 的工具面 hash */
    hash: string;
    /** 上次启动时的那份（null = 首次 / 读不出） */
    previous: ToolsSurfaceRecord | null;
    /** 工具面变了（⇒ 重启后首个请求整段全价） */
    changed: boolean;
}

/**
 * 启动时判定：算好的当前 hash 与上次记录比。**只判定，不写盘**（写盘由调用方决定时机 ——
 * 报警要能读到"上一次"，所以写要在读之后、且必须再走 `writeToolsSurfaceRecord`）。
 */
export function toolsSurfaceDriftOf(home: string, hash: string): ToolsSurfaceDrift {
    const previous = readToolsSurfaceRecord(home);
    return { hash, previous, changed: previous !== null && previous.hash !== hash };
}

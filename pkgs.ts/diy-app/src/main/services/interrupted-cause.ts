// src/main/services/interrupted-cause.ts
// 🎯 冷读现场勘验的**读盘侧**（##416）：把「进程怎么死的」读成纯函数能吃的证据。
//
// 只读三个来源（全是既有痕迹，**不新增埋点**）：
//   · `<DIY_HOME>/log/app-exit.jsonl` —— `crash-reporting.ts::appendExitLog` 的信号/异常尾巴，
//     以及 `scripts/electron-dev.mts` 在 watch 重启旧实例前写的那条（kind = `electron-dev-restart`）
//   · `<DIY_HOME>/log/crashes/{pending,completed}/*.dmp` —— Crashpad minidump（原生崩溃）
//
// 硬约束：**永不抛**。调用点在会话加载 / 开轮的收敛路径上，读盘失败不能让会话起不来 ——
// 失败时按「没证据」处理（退化成 unknown 兜底句，即改动前的行为）。

import { appendFileSync, mkdirSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import type { AppExitRecord, CauseEvidence, MinidumpRecord } from "../../shared/interrupted-cause";
import { localISOString } from "@diy-agent/time";

/** 退出日志（相对 DIY_HOME） */
export const APP_EXIT_LOG_REL = join("log", "app-exit.jsonl");
/** minidump 根（相对 DIY_HOME） */
export const CRASH_DUMPS_REL = join("log", "crashes");

/** 读 `app-exit.jsonl`（逐行容错：坏行跳过，不因一行脏数据丢全部证据） */
export function readAppExitLog(home: string): AppExitRecord[] {
    const file = join(home, APP_EXIT_LOG_REL);
    let raw: string;
    try {
        raw = readFileSync(file, "utf-8");
    } catch {
        return [];
    }
    const out: AppExitRecord[] = [];
    for (const line of raw.split("\n")) {
        const t = line.trim();
        if (!t) continue;
        try {
            const row = JSON.parse(t) as Partial<AppExitRecord>;
            if (typeof row.ts !== "string" || typeof row.kind !== "string") continue;
            out.push({ ...row, ts: row.ts, kind: row.kind, file });
        } catch {
            /* 半截行（写到一半被杀）：跳过 */
        }
    }
    return out;
}

/** 扫 minidump（`pending` / `completed` 两个子目录；`log/crashes` 自身也扫一层，兼容老布局） */
export function readMinidumps(home: string): MinidumpRecord[] {
    const root = join(home, CRASH_DUMPS_REL);
    const out: MinidumpRecord[] = [];
    const scan = (dir: string): void => {
        let names: string[];
        try {
            names = readdirSync(dir);
        } catch {
            return;
        }
        for (const n of names) {
            const p = join(dir, n);
            try {
                const st = statSync(p);
                if (st.isDirectory()) {
                    // 只下钻一层（pending / completed）；更深的是 Crashpad 内部布局，不看
                    if (dir === root) scan(p);
                    continue;
                }
                if (n.endsWith(".dmp")) out.push({ path: p, mtimeMs: st.mtimeMs });
            } catch {
                /* 文件刚被移走：忽略 */
            }
        }
    };
    scan(root);
    return out;
}

/** 一次读齐（冷读收敛时每批调一次；量级是「每天几条」） */
export function readCauseEvidence(home: string): CauseEvidence {
    return { exits: readAppExitLog(home), dumps: readMinidumps(home) };
}

/**
 * 追加一行退出记录（`log/app-exit.jsonl`）。**永不抛**：调用点全在退出路径上（信号 handler /
 * watch 重启前），那里再抛异常只会把「留痕」变成「新的崩溃源」。
 *
 * 写入方有三处，格式必须同一份（否则冷读认得这条、认不得那条）：
 *   · `crash-reporting.ts` —— SIGTERM / SIGINT / SIGHUP / uncaughtException / unhandledRejection
 *   · `scripts/electron-dev.mts` —— watch 重启旧实例**之前**主动记一条（##416 实测：只靠
 *     Electron 自己的 handler 会漏 —— ##404 lab 的 `app-exit.jsonl` 里只有 1 条 SIGTERM，
 *     而那次期间重启了多次；不能指望被杀进程在死前把字写完，所以杀的一方亲手记）
 */
export function appendAppExit(home: string, kind: string, detail = "", pid = process.pid): void {
    try {
        mkdirSync(join(home, "log"), { recursive: true });
        const row: AppExitRecord = { ts: localISOString(), kind, pid, detail };
        appendFileSync(join(home, APP_EXIT_LOG_REL), `${JSON.stringify(row)}\n`, "utf-8");
    } catch {
        /* 退出路径上尽力而为 */
    }
}

// src/main/services/local-layout-migrate.ts
// 🎯 会话数据**落位迁移**（##379）：旧平铺 `local/<key>.<kind>.jsonl` → 分层
//    `local/<uri 路径>/<key>/<kind>.jsonl`；工具输出原文 `local/toolout/<id>.txt` → 各会话目录。
//
// ── 三条硬约束（与 `agent local` 的读侧双认互补）──
//   1. **幂等 + 可中断续跑**：逐个文件 copy → 校验大小 → 删源；任何一刻中断，重跑不会算错
//      （已迁的走 `skip`，不会二次搬）。
//   2. **绝不覆盖**：目标已存在且大小不同 ⇒ 记 `conflict` 留原地，交人看（数据安全优先于"搬干净"）。
//   3. **生产根只允许 dry-run**：真迁必须由用户在明确知情下执行（本函数直接拒绝 production）。
//
// key 不可逆（sha256 前缀）⇒ 「文件名 → uri」只能靠**现存的 uri 集合**反查；
// 反查不到的就是孤儿（任务已删），记 `unknown` 留原地 —— 不猜、不删。
//
// ⚠️ uri 集合取自**磁盘上的任务目录**（`projects/<pid>/tasks/<tid>/`），不走 `core/task`。
// 两个理由：① 迁移面对的就是磁盘现状（state.yaml 可能滞后于目录）；② `core/task` 带着
// `TaskStateSchema` 等 zod schema，静态 import 它会让本 chunk 与 `room-service` 共用 task chunk，
// 把 task 模块提升成**先于 `@diy-agent/rpc` 补丁求值**的共享 chunk —— 症状正是启动即
// `TypeError: TaskStateSchema.cliArg is not a function`（##322 记过的坑，本次实测复现）。

import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync } from "node:fs";
import path from "node:path";
import { readRuntimeConfig } from "../../runtime";
import { projectsRoot, diyHome } from "../core/state";
import {
    keyOf,
    legacySessionFile,
    localDir,
    SESSION_KINDS,
    sessionDir,
    sessionFile,
    sessionStateFile,
    type SessionKind,
} from "../core/local-paths";
import { readJsonlTail } from "../core/jsonl-tail";
import { legacyToolOutDir, safeId } from "./tool-output";

/** 单条迁移动作（`from`/`to` 都是相对 `$DIY_HOME` 的路径，便于人读与跨机比对） */
export interface LayoutMigrationEntry {
    from: string;
    to: string;
    action: "move" | "skip" | "conflict" | "unknown";
    /** 为什么（conflict / unknown 才有） */
    note?: string;
}

export interface LayoutMigrationResult {
    dryRun: boolean;
    moved: number;
    skipped: number;
    conflicts: number;
    unknown: number;
    /** 实际动作条数（= moved + skipped） */
    total: number;
    /** toolout 部分：按会话账本能定归属的条数 / 兜底不了（任务已删）的条数 */
    toolOut: { owned: number; orphan: number };
    /** 明细（**有上限**：24871 个 toolout 全列出来没人看） */
    entries: LayoutMigrationEntry[];
    /** 明细被截断（entries 未含全部动作） */
    truncated: boolean;
}

/** 明细上限（报告给人看，不是数据出口） */
const MAX_ENTRIES = 400;

const rel = (abs: string): string => path.relative(diyHome(), abs).split(path.sep).join("/");

/**
 * 扫旧平铺文件 → `{ key, kind, file }`。只认顶层**普通文件**（目录如 `plan/` / `toolout/` 不进）。
 * 后缀判别必须走 `SESSION_KINDS`（将来加 kind 时这里自动跟上，不会漏搬）。
 */
function scanLegacySessions(): { key: string; kind: SessionKind; file: string }[] {
    const root = localDir();
    const out: { key: string; kind: SessionKind; file: string }[] = [];
    for (const name of readdirSync(root)) {
        for (const kind of SESSION_KINDS) {
            const suffix = `.${kind}.jsonl`;
            if (!name.endsWith(suffix)) continue;
            const stem = name.slice(0, -suffix.length);
            // key 形状：可读前缀 + `-` + 12 位 hex（唯一性由 hash 段承担）
            if (!/-[0-9a-f]{12}$/.test(stem)) continue;
            const file = path.join(root, name);
            try {
                if (!statSync(file).isFile()) continue;
            } catch {
                continue;
            }
            out.push({ key: stem, kind, file });
            break;
        }
    }
    return out;
}

/**
 * 会话引用的工具原文 id（归属判据）。
 *
 * ##431 起两个来源，都**限读**：
 *   ① `compact-state.json` 的 `opIds`（当前值快照，几百 B，O(1)）—— 新会话的权威来源；
 *   ② 账本**尾部窗口**（老会话没有快照，或快照只覆盖最近几次）里的 `clippedIds.ids` / 老 `clipped[].id`。
 *
 * 为什么不再整份读账本：266 会话实测 274 MB，一条迁移命令扫一遍就是秒级 × 几十个任务。
 * 代价：超出尾部窗口的老记录里的 id 会漏 ⇒ 那些原文落在 `unknown`（留原地，人可手查）—— 宁可少归，不可猜。
 */
function clippedIdsOf(uri: string): string[] {
    const ids = new Set<string>();
    const stateFile = sessionStateFile(uri, "compact-state");
    if (existsSync(stateFile)) {
        try {
            // sync-io-ok: 迁移是离线命令（无并发可挡），读的是几百 B 的当前值快照
            const st = JSON.parse(readFileSync(stateFile, "utf-8")) as { opIds?: unknown };
            if (Array.isArray(st.opIds)) for (const id of st.opIds) if (typeof id === "string" && id) ids.add(id);
        } catch {
            /* 坏快照：交给下面的账本回落（与产品读侧同策略） */
        }
    }
    const files = [sessionFile(uri, "compact"), legacySessionFile(uri, "compact")];
    for (const file of files) {
        const tail = readJsonlTail(file, { maxBytes: 256 * 1024, maxLines: 200 });
        for (const s of tail.lines) {
            try {
                const rec = JSON.parse(s) as {
                    details?: { clipped?: { id?: unknown }[]; clippedIds?: { ids?: unknown } };
                };
                const listed = rec.details?.clippedIds?.ids;
                if (Array.isArray(listed)) for (const id of listed) if (typeof id === "string" && id) ids.add(id);
                for (const c of rec.details?.clipped ?? []) {
                    if (typeof c?.id === "string" && c.id) ids.add(c.id);
                }
            } catch {
                /* 坏行跳过（与产品读侧同策略） */
            }
        }
    }
    return [...ids];
}

/** 单文件搬迁：copy → 校验 → 删源；返回动作 */
function takeOver(from: string, to: string, dryRun: boolean): { action: LayoutMigrationEntry["action"]; note?: string } {
    let note: string | undefined;
    const srcSize = statSync(from).size;
    if (existsSync(to)) {
        const dstSize = statSync(to).size;
        if (srcSize === dstSize) {
            if (!dryRun) rmSync(from, { force: true }); // 已迁完的残留源：清掉（幂等收尾）
            return { action: "skip", note: "目标已存在且等大（已迁）" };
        }
        if (dstSize > srcSize) {
            // 目标比源大：正常迁移只会产生「等大」目标 ⇒ 不是本命令的产物，留原地交人看。
            return { action: "conflict", note: `目标已存在且比源大（源 ${srcSize}B / 目标 ${dstSize}B）` };
        }
        // 目标比源**小**：正常迁移不可能产生 ⇒ 只可能是旧实现（直接 copyFileSync 落目标）中断
        // 留下的截断副本。读侧双认只判存在 ⇒ 它会**优先被认领**，历史照样腰斩（##266 review2 R1.1）。
        // 故先备份残片再重做副本：源零丢失，读侧立刻恢复完整。
        if (dryRun) {
            return { action: "move", note: `目标疑为截断副本（源 ${srcSize}B / 目标 ${dstSize}B）；实迁将备份后重做` };
        }
        const backup = `${to}.conflict-${Date.now()}`;
        renameSync(to, backup);
        note = `目标疑为截断副本（${dstSize}B < 源 ${srcSize}B），已备份为 ${path.basename(backup)} 后重做`;
    }
    if (!dryRun) {
        mkdirSync(path.dirname(to), { recursive: true });
        // 先写 `to.tmp` 再同目录 `rename` —— 保证 `to` 只可能以**完整**形态出现（##266 review1 R1）。
        // 直接 copyFileSync(from, to) 的中断窗口（ENOSPC / 进程被杀）会留下截断副本，而读侧双认
        // 只判存在 ⇒ 会把截断那份当权威、后续 append 接在截断处，源尾部永久孤立（历史静默腰斩）。
        // 与 ##383 的 `writeFileAtomic` 同范式（`check-atomic-write.mjs` 的豁免①只认 `.tmp` 腿）。
        const tmp = `${to}.tmp`;
        copyFileSync(from, tmp);
        if (statSync(tmp).size !== statSync(from).size) {
            rmSync(tmp, { force: true });
            return { action: "conflict", note: "复制后大小不符（已回滚，源保留）" };
        }
        renameSync(tmp, to);
        rmSync(from, { force: true });
    }
    return { action: "move", note };
}

/**
 * 磁盘上的全部任务 uri（`projects/<pid>/tasks/<tid>`）。
 * 只认**目录存在的**任务：迁移是磁盘行为，目录才是真源（见文件头第 2 条注记）。
 */
function scanTaskUris(): string[] {
    const out: string[] = [];
    const dirs = (p: string): string[] => {
        try {
            return readdirSync(p, { withFileTypes: true })
                .filter((d) => d.isDirectory())
                .map((d) => d.name);
        } catch {
            return [];
        }
    };
    for (const pid of dirs(projectsRoot())) {
        for (const tid of dirs(path.join(projectsRoot(), pid, "tasks"))) {
            out.push(`projects/${pid}/tasks/${tid}`);
        }
    }
    return out;
}

/**
 * 执行迁移（`dryRun` = 只算不动）。
 * ⚠️ 生产根（`DIY_ENV=production`）**只允许 dry-run**：调用方传 dryRun=false 会拿到 `null` 之外的
 * 拒绝（由本函数抛错），不许静默降级成 dry-run —— 那会让人以为"迁过了"。
 */
export function migrateLocalLayout(opts: { dryRun: boolean; toolout?: boolean }): LayoutMigrationResult {
    const dryRun = opts.dryRun !== false;
    if (!dryRun && readRuntimeConfig().env === "production") {
        throw new Error("生产根（DIY_ENV=production）只允许 --dry-run 演练；实迁请由用户在确认后手动执行");
    }
    const withToolOut = opts.toolout !== false;

    const uris = scanTaskUris();
    const keyToUri = new Map<string, string>();
    for (const uri of uris) keyToUri.set(keyOf(uri), uri);

    const entries: LayoutMigrationEntry[] = [];
    let moved = 0;
    let skipped = 0;
    let conflicts = 0;
    let unknown = 0;
    let truncated = false;
    const push = (e: LayoutMigrationEntry): void => {
        if (entries.length < MAX_ENTRIES) entries.push(e);
        else truncated = true;
    };

    for (const { key, kind, file } of scanLegacySessions()) {
        const uri = keyToUri.get(key);
        if (!uri) {
            unknown += 1;
            push({ from: rel(file), to: "", action: "unknown", note: "找不到对应任务（key 不可逆；任务可能已删）" });
            continue;
        }
        const to = sessionFile(uri, kind);
        const r = takeOver(file, to, dryRun);
        if (r.action === "move") moved += 1;
        else if (r.action === "skip") skipped += 1;
        else conflicts += 1;
        push({ from: rel(file), to: rel(to), action: r.action, ...(r.note ? { note: r.note } : {}) });
    }

    // ── 工具输出原文：归属只能从**会话账本**（`details.clipped[].id`）反推 ──
    let owned = 0;
    let orphan = 0;
    if (withToolOut) {
        const idToUri = new Map<string, string>();
        const contested = new Set<string>();
        for (const uri of uris) {
            for (const id of clippedIdsOf(uri)) {
                const prev = idToUri.get(id);
                if (prev && prev !== uri) contested.add(id);
                else idToUri.set(id, uri);
            }
        }
        const legacyDir = legacyToolOutDir();
        const files = existsSync(legacyDir)
            ? readdirSync(legacyDir).filter((f) => f.endsWith(".txt"))
            : [];
        for (const f of files) {
            const id = f.slice(0, -4);
            const uri = idToUri.get(id);
            const from = path.join(legacyDir, f);
            if (!uri) {
                orphan += 1;
                push({ from: rel(from), to: "", action: "unknown", note: "账本里无人引用（或任务已删）" });
                continue;
            }
            if (contested.has(id)) {
                conflicts += 1;
                push({ from: rel(from), to: "", action: "conflict", note: "同一 id 被多个任务引用 → 归不动，留原地" });
                continue;
            }
            const to = path.join(sessionDir(uri), "toolout", `${safeId(id)}.txt`);
            const r = takeOver(from, to, dryRun);
            if (r.action === "move") {
                moved += 1;
                owned += 1;
            } else if (r.action === "skip") {
                skipped += 1;
                owned += 1;
            } else {
                conflicts += 1;
            }
            push({ from: rel(from), to: rel(to), action: r.action, ...(r.note ? { note: r.note } : {}) });
        }
    }

    return {
        dryRun,
        moved,
        skipped,
        conflicts,
        unknown,
        total: moved + skipped,
        toolOut: { owned, orphan },
        entries,
        truncated,
    };
}

// src/main/core/models-sync.ts
// 🎯 模型目录（models.dev 快照）的**应用内刷新**：抓上游 → 校验 → 有 diff 才写 `$DIY_HOME/data/`。
//
// 与构建期脚本（`scripts/gen-models-dev.mts`，CI 定时 workflow 归 ##107）的关系：
//   · 构建期产物 = `src/main/data/models.dev.json`，**随发行分发**、实例永远改不到；
//   · 本模块 = 运行中的实例**自己**刷新（定时 + 手工按钮），写 `$DIY_HOME/data/models.dev.json`
//     —— 数据文件候选里它优先级最高（见 core/data-file.ts），故刷新后自然生效、无需发版。
//
// 硬约束（##385 §3.4，照抄 ##107）：
//   · fail-soft：抓取 / 解析 / 校验失败 → **绝不写盘**（半张快照 = 静默丢价 = 计价错档）；
//   · 写盘一律过 `atomic-write`（原子覆盖；失败时目标文件逐字不变、mtime 也不动）；
//   · 无 diff 不写（无变更 = 无噪音，也避免每次 tick 都刷 mtime 掩盖真实变更时刻）；
//   · 出声：返回值带 error / 数量，由调用方（bar / 设置页 / 定时日志）呈现，**不静默**。
//
// 边界：本文件只做「一次刷新」（纯依赖注入：home / origin / fetchText / now）。
//   · 启动首跑在 `services/models-startup-refresh.ts`（就叫一次）；
//   · 定时（24h）与任务级 job 的管理 / 可见性归 **##408** —— 它要调的就是本文件的
//     `refreshModelsOnce`（一次 tick），所以这个函数必须保持**无定时器、无全局状态**。
import { readFileSync } from "node:fs";
import { MODELS_DEV_FILE, type ModelsRefreshResult, type ModelsSnapshotInfo, type SpecProvider } from "../../shared/model-config";
import { writeFileAtomic } from "./atomic-write";
import { dataFileHit, dataHomeFile, type DataFileHit } from "./data-file";
import { buildModelsSnapshot, diffSnapshot, snapshotCounts } from "./models-snapshot";
import { localISOString } from "@diy-agent/time";

/** 缺省上游（真源见 `diy/AGENTS.md::model.truth`） */
export const MODELS_DEV_ORIGIN = "https://models.dev/api.json";

/** 抓取超时：models.dev 的 api.json 有数 MB，20s 足够；超时即失败（不挂死启动 / 请求） */
export const MODELS_FETCH_TIMEOUT_MS = 20_000;

/** 抓取失败（网络 / HTTP 状态 / 超时）—— 调用方据此保留旧文件 */
export class ModelsFetchError extends Error {
    readonly code = "net/models-dev-fetch";
}

export interface RefreshModelsOptions {
    /** 数据根（`DIY_HOME`），测试注入口 */
    home: string;
    /** 抓取源：http(s) URL 或本地文件路径（离线源 / 意图测试）；缺省 `$DIY_MODELS_DEV_ORIGIN` */
    origin?: string;
    /** 抓取实现（测试注入假抓取器） */
    fetchText?: (url: string) => Promise<string>;
    /** 时钟（测试注入） */
    now?: () => Date;
}

/** 抛抓取错误（**唯一 throw 点**；code 固定在该异常类上） */
function fetchFail(message: string): never {
    // error-code-ok: code 由 ModelsFetchError 固定为 net/models-dev-fetch
    throw new ModelsFetchError(message);
}

/** 缺省抓取：http(s) 走 fetch（带超时）；其余按本地文件读（与 gen 脚本同一口径，便于离线复现） */
export async function readModelsSource(origin: string, fetchText?: (url: string) => Promise<string>): Promise<string> {
    if (fetchText) return fetchText(origin);
    if (!/^https?:\/\//i.test(origin)) return readFileSync(origin, "utf-8");
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), MODELS_FETCH_TIMEOUT_MS);
    try {
        const res = await fetch(origin, { signal: ctrl.signal });
        if (!res.ok) fetchFail(`上游返回 HTTP ${res.status} ${res.statusText}`);
        return await res.text();
    } catch (e) {
        if (e instanceof ModelsFetchError) throw e;
        const why = e instanceof Error ? e.message : String(e);
        // AbortError 的 message 在 Node 里是「This operation was aborted」—— 换成可读的时间口径
        fetchFail(ctrl.signal.aborted ? `抓取超时（${MODELS_FETCH_TIMEOUT_MS}ms）` : `抓取失败：${why}`);
    } finally {
        clearTimeout(timer);
    }
}

/** 读一份快照文件（解析 + 计数）；文件坏了 → 抛（诊断出口要说清「坏在哪」，不能装作没有） */
function loadSnapshotFile(path: string): Record<string, SpecProvider> {
    return JSON.parse(readFileSync(path, "utf-8")) as Record<string, SpecProvider>;
}

/**
 * **当前生效**的快照是哪一份（诊断出口用）。
 * 返回 null = 一份都没有（内置数据都缺失，属安装损坏）。
 */
export function activeSnapshot(home: string): { hit: DataFileHit; info: ModelsSnapshotInfo } | null {
    const hit = dataFileHit(MODELS_DEV_FILE, home);
    if (!hit) return null;
    const counts = snapshotCounts(loadSnapshotFile(hit.path));
    return { hit, info: { path: hit.path, source: hit.source, ...counts } };
}

/**
 * 一次刷新（启动首跑 / 后续调度器 tick / 手工按钮共用）：
 *   抓 → 校验 → 与**当前生效**快照比对 → 有 diff 才原子写 `$DIY_HOME/data/models.dev.json`。
 *
 * 永不抛（失败进返回值）：调用点包括启动流程与 UI，抛出去只会变成未处理拒绝 / 界面无反馈。
 */
export async function refreshModelsOnce(o: RefreshModelsOptions): Promise<ModelsRefreshResult> {
    const now = o.now ?? (() => new Date());
    const checkedAt = localISOString(now());
    const origin = o.origin ?? process.env["DIY_MODELS_DEV_ORIGIN"] ?? MODELS_DEV_ORIGIN;
    const dest = dataHomeFile(MODELS_DEV_FILE, o.home);

    // 当前生效的那份（可能坏：坏了不阻止刷新 —— 更该被覆盖，但仍不许写半成品）
    let previous: ModelsSnapshotInfo | null = null;
    let prevSnapshot: Record<string, SpecProvider> | null = null;
    try {
        const cur = activeSnapshot(o.home);
        if (cur) {
            previous = cur.info;
            prevSnapshot = loadSnapshotFile(cur.hit.path);
        }
    } catch {
        // 旧文件解析失败：按「没有可比对象」处理（本次刷新若能成功，正好把它换掉）
        prevSnapshot = null;
        previous = null;
    }

    const fail = (error: string): ModelsRefreshResult => ({
        ok: false,
        changed: false,
        checkedAt,
        path: dest,
        origin,
        providers: previous?.providers ?? 0,
        models: previous?.models ?? 0,
        addedProviders: [],
        removedProviders: [],
        addedModels: 0,
        removedModels: 0,
        previous,
        error,
    });

    let raw: string;
    try {
        raw = await readModelsSource(origin, o.fetchText);
    } catch (e) {
        return fail(e instanceof Error ? e.message : String(e));
    }

    let built: ReturnType<typeof buildModelsSnapshot>;
    try {
        built = buildModelsSnapshot(JSON.parse(raw));
    } catch (e) {
        // 解析失败与校验失败都到此：**不写盘**，本地快照逐字不变
        return fail(e instanceof Error ? e.message : String(e));
    }

    const diff = diffSnapshot(prevSnapshot, built.snapshot);
    if (!diff.changed) {
        return {
            ok: true,
            changed: false,
            checkedAt,
            path: dest,
            origin,
            providers: built.providers,
            models: built.models,
            addedProviders: [],
            removedProviders: [],
            addedModels: 0,
            removedModels: 0,
            previous,
            error: null,
        };
    }

    try {
        // 原子写：半成品不可能落下（atomic-write 的契约）；内容与构建期产物同一序列化（无缩进）
        writeFileAtomic(dest, JSON.stringify(built.snapshot));
    } catch (e) {
        return fail(`写入失败：${e instanceof Error ? e.message : String(e)}`);
    }

    return {
        ok: true,
        changed: true,
        checkedAt,
        path: dest,
        origin,
        providers: built.providers,
        models: built.models,
        addedProviders: diff.addedProviders,
        removedProviders: diff.removedProviders,
        addedModels: diff.addedModels,
        removedModels: diff.removedModels,
        previous,
        error: null,
    };
}

/**
 * 刷新 + **立即生效**（定时器 / 手工按钮的入口）。
 *
 * 只有 `ok && changed` 才动进程内缓存：无 diff / 失败时缓存仍指向同一份文件，
 * 清缓存只会让下一次读多解析 4MB JSON（模型页卡一下），没有好处。
 */
export async function refreshAndApply(o: RefreshModelsOptions): Promise<ModelsRefreshResult> {
    const r = await refreshModelsOnce(o);
    if (r.ok && r.changed) {
        const { invalidateSnapshot } = await import("./model-registry");
        const { refreshModelRuntime } = await import("./model-runtime");
        invalidateSnapshot();
        refreshModelRuntime(o.home);
    }
    return r;
}

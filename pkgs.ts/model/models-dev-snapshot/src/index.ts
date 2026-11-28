// models.dev 规格快照：包内兜底 + 运行时刷新。
//
// 两份文件，职责分开：
//   · 包内 dist/models.dev.json  —— gen 脚本生成的打包产物，不进 git，装包即带
//   · 数据根 data/models.dev.json —— 运行时拉下来的新版，catalog 优先读它
//
// 只暴露路径，不在启动时 import 6.5 MB 的 JSON（解析要几十毫秒）。

import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const SOURCE_URL = process.env['MODELS_DEV_URL'] ?? 'https://models.dev/api.json';
const DEFAULT_INTERVAL_MS = 6 * 60 * 60 * 1000;

/** 包内快照路径。源码态与 dist 态都指向 <包根>/dist。 */
export function bundledSnapshotPath(): string {
    return fileURLToPath(new URL('../dist/models.dev.json', import.meta.url));
}

/** 包内快照在不在；没生成 / 没下载到时 catalog 照旧报「缺快照」。 */
export function hasBundledSnapshot(): boolean {
    return existsSync(bundledSnapshotPath());
}

export type SnapshotRefreshState = 'updated' | 'unchanged' | 'failed';

export interface SnapshotRefreshResult {
    readonly at: number;
    readonly state: SnapshotRefreshState;
    readonly providers?: number;
    readonly error?: string;
}

let lastRefresh: SnapshotRefreshResult | undefined;

/** 最近一次拉取结果，给配置页回显用。 */
export function lastRefreshResult(): SnapshotRefreshResult | undefined {
    return lastRefresh;
}

/** 运行时数据根里那份快照的路径。 */
export function runtimeSnapshotPath(home: string): string {
    return join(home, 'data', 'models.dev.json');
}

/**
 * 拉一次快照写到数据根。带 If-None-Match：接口回 304 就什么都不写（几十字节）。
 * 失败不抛 —— UI 要把失败原因显示出来，不能让一次网络抖动变成整页报错。
 */
export async function refreshSnapshot(home: string, url: string = SOURCE_URL): Promise<SnapshotRefreshResult> {
    const target = runtimeSnapshotPath(home);
    const etagPath = join(dirname(target), 'models.dev.etag');
    const headers: Record<string, string> = {};
    if (existsSync(etagPath)) headers['If-None-Match'] = readFileSync(etagPath, 'utf8').trim();
    try {
        const response = await fetch(url, { headers });
        if (response.status === 304) {
            lastRefresh = { at: Date.now(), state: 'unchanged' };
            return lastRefresh;
        }
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const text = await response.text();
        const parsed: unknown = JSON.parse(text);
        if (typeof parsed !== 'object' || parsed === null) throw new Error('快照不是对象');
        mkdirSync(dirname(target), { recursive: true });
        writeFileSync(target, text);
        const etag = response.headers.get('etag');
        if (etag !== null) writeFileSync(etagPath, etag);
        lastRefresh = { at: Date.now(), state: 'updated', providers: Object.keys(parsed).length };
        return lastRefresh;
    } catch (cause) {
        lastRefresh = { at: Date.now(), state: 'failed', error: cause instanceof Error ? cause.message : String(cause) };
        return lastRefresh;
    }
}

/**
 * 定时拉取。启动先拉一次（ETag 命中很便宜），之后默认每 6 小时一次。
 * 返回停止函数，供关服时清理。
 */
export function startSnapshotRefresh(home: string, intervalMs = DEFAULT_INTERVAL_MS): () => void {
    void refreshSnapshot(home);
    const timer = setInterval(() => void refreshSnapshot(home), intervalMs);
    timer.unref?.();
    return () => clearInterval(timer);
}

/** 运行时那份快照有多旧（毫秒），配置页显示「上次更新」。 */
export function runtimeSnapshotAge(home: string): number | undefined {
    const path = runtimeSnapshotPath(home);
    return existsSync(path) ? Date.now() - statSync(path).mtimeMs : undefined;
}

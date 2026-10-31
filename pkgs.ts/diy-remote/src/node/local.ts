// local 发现器：**本机**已跑的 diy 实例。
//
// 数据源 = 实例注册表 `~/.diy-instances/<pid>.json`（跨数据根：生产 / lab / test 各写各的条目，
// 由 diy-app 启动时自报，见 `main/core/instance-registry.ts`）。注册表里 `pingPort` 是本轮新增字段。
//
// 为什么本地也要走 HTTP 而不是直接读文件：文件只说明「启动时它这么想」，**活着且可 ping** 才算
// 一个能用的 endpoint（进程卡死 / 端口已关都会让旧条目变成假象）。本发现器只收 ping 得通的。
//
// 老实例（没有 pingPort 字段）静默跳过：它们不提供 /ping，这一轮也确实连不上。

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import type { DiscoveredInstance, Discoverer, PingInfo } from '../types.js';
import { fetchPing } from './ping-client.js';

/** 注册表目录（`DIY_INSTANCE_REGISTRY` 覆盖；缺省 `~/.diy-instances`，与 diy-app 同口径） */
export function defaultRegistryDir(env: NodeJS.ProcessEnv = process.env): string {
    const override = env['DIY_INSTANCE_REGISTRY'];
    if (override !== undefined && override.trim() !== '') return override.trim();
    return join(homedir(), '.diy-instances');
}

export interface LocalDiscoverDeps {
    dir?: string;
    listFiles?: (dir: string) => string[];
    readFile?: (file: string) => string | null;
    ping?: (endpoint: string, timeoutMs: number) => Promise<{ ok: boolean; info: PingInfo | null }>;
    timeoutMs?: number;
}

interface Consumption {
    pingPort: number;
    pid: number;
    variant: string;
    env: string;
    diyHome: string;
}

/** 解析一条注册表记录（宽松：只认得出 pingPort 的） */
export function parseRegistryRecord(raw: unknown): Consumption | null {
    if (typeof raw !== 'object' || raw === null) return null;
    const o = raw as Record<string, unknown>;
    const pingPort = o['pingPort'];
    const pid = o['pid'];
    if (typeof pingPort !== 'number' || !Number.isInteger(pingPort) || pingPort <= 0 || pingPort > 65535) return null;
    if (typeof pid !== 'number' || !Number.isFinite(pid) || pid <= 0) return null;
    return {
        pingPort,
        pid,
        variant: typeof o['variant'] === 'string' ? o['variant'] : '',
        env: typeof o['env'] === 'string' ? o['env'] : '',
        diyHome: typeof o['diyHome'] === 'string' ? o['diyHome'] : '',
    };
}

/** local 发现器（依赖可注入：单测摆假目录 + 假 ping，不碰真进程） */
export function localDiscoverer(deps: LocalDiscoverDeps = {}): Discoverer {
    const dir = deps.dir ?? defaultRegistryDir();
    const listFiles = deps.listFiles ?? defaultListFiles;
    const readFile = deps.readFile ?? defaultReadFile;
    const ping = deps.ping ?? fetchPing;
    const timeoutMs = deps.timeoutMs ?? 800;

    return {
        kind: 'local',
        discover: async () => {
            const files = listFiles(dir).filter((f) => f.endsWith('.json'));
            const records: Consumption[] = [];
            for (const name of files) {
                const text = readFile(join(dir, name));
                if (text === null) continue;
                try {
                    const rec = parseRegistryRecord(JSON.parse(text));
                    if (rec !== null) records.push(rec);
                } catch {
                    /* 坏 JSON：注册表是别人进程写的，跳过即可（读侧无信任基础） */
                }
            }
            const results = await Promise.all(
                records.map(async (rec): Promise<DiscoveredInstance | null> => {
                    const endpoint = `http://127.0.0.1:${rec.pingPort}`;
                    const r = await ping(endpoint, timeoutMs);
                    if (!r.ok || r.info === null) return null;
                    return {
                        id: r.info.id,
                        displayName: r.info.displayName,
                        endpoint,
                        source: 'local',
                        meta: {
                            pid: String(r.info.pid),
                            variant: r.info.variant,
                            ...(r.info.app !== '' ? { app: r.info.app } : {}),
                            ...(rec.env !== '' ? { env: rec.env } : {}),
                            ...(rec.diyHome !== '' ? { diyHome: rec.diyHome } : {}),
                        },
                    };
                }),
            );
            return results.filter((r): r is DiscoveredInstance => r !== null);
        },
    };
}

function defaultListFiles(dir: string): string[] {
    if (!existsSync(dir)) return [];
    try {
        return readdirSync(dir);
    } catch {
        return [];
    }
}

function defaultReadFile(file: string): string | null {
    try {
        return readFileSync(file, 'utf-8');
    } catch {
        return null;
    }
}

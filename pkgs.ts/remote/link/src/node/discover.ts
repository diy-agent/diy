// 发现器链：跑若干**互相独立**的发现器 → 合并去重 → 列给用户选。
//
// 三条硬规矩（##479）：
//   1. 每个发现器独立失败：一台机器 mDNS 被拦、没装 tailscale，都只让那一路空手而归，
//      **不连坐**别的路（用 allSettled，失败记进 `errors` 但不抛）。
//   2. 结果**合并去重后返回**，绝不自动连接 —— 连哪台是用户的决定，不是发现器的副作用。
//   3. 没有 id 的候选（manual / 老 mDNS 记录）补一次 /ping 拿身份；ping 不通仍保留这一行
//      （用户手输的地址可能是还没起来的实例），只在 meta 里标 `reachable=false`。

import type { DiscoveredInstance, Discoverer, MergedInstance } from '../types.js';
import { mergeDiscovered } from '../merge.js';
import { manualDiscoverer } from '../discover/manual.js';
import { localDiscoverer, type LocalDiscoverDeps } from './local.js';
import { mdnsDiscoverer, type MdnsBrowser } from './mdns.js';
import { tailscaleDiscoverer, type TailscaleDiscoverDeps } from './tailscale.js';
import { fetchPing } from './ping-client.js';

/** 全部发现器（缺省跑这个顺序；`manual` 只在用户给了输入时加入） */
export const ALL_SOURCES: readonly string[] = ['local', 'mdns', 'tailscale', 'manual'];

export interface DiscoverFailure {
    source: string;
    /** 人读一句话 */
    message: string;
}

export interface DiscoverAllOptions {
    /** 只跑这几路（缺省 = local + mdns + tailscale，有 manual 输入时再加 manual） */
    sources?: readonly string[];
    /** 手动 URL（`diy remote discover --manual host:9400`） */
    manual?: readonly string[];
    /** mDNS 收集时长（缺省 1500ms —— 多播查询要等一轮响应） */
    mdnsTimeoutMs?: number;
    /** 单次 /ping 超时（缺省 1500ms） */
    pingTimeoutMs?: number;
    /** 注入用（测试 / 自定注册表目录） */
    registryDir?: string;
    mdnsBrowser?: MdnsBrowser;
    tailscale?: TailscaleDiscoverDeps;
    local?: LocalDiscoverDeps;
    /** 给没有 id 的候选补 ping（缺省 true；测试可关） */
    enrich?: boolean;
}

export interface DiscoverAllResult {
    /** 合并去重后的候选列表（按来源优先级 + 显示名排序） */
    items: MergedInstance[];
    /** 哪一路挂了（空数组 = 全部正常） */
    errors: DiscoverFailure[];
}

/** 按 `sources` 组装发现器；manual 没有输入时不给（否则它只会返回空） */
export function buildDiscoverers(opts: DiscoverAllOptions = {}): Discoverer[] {
    const manual = opts.manual ?? [];
    const selected = new Set(opts.sources ?? ['local', 'mdns', 'tailscale', ...(manual.length > 0 ? ['manual'] : [])]);
    const out: Discoverer[] = [];
    if (selected.has('local')) out.push(localDiscoverer(opts.local ?? { dir: opts.registryDir }));
    if (selected.has('mdns')) {
        out.push(mdnsDiscoverer({ browser: opts.mdnsBrowser, timeoutMs: opts.mdnsTimeoutMs ?? 1500 }));
    }
    if (selected.has('tailscale')) out.push(tailscaleDiscoverer(opts.tailscale ?? {}));
    if (selected.has('manual') && manual.length > 0) out.push(manualDiscoverer(manual));
    return out;
}

export async function discoverAll(opts: DiscoverAllOptions = {}): Promise<DiscoverAllResult> {
    const discoverers = buildDiscoverers(opts);
    const settled = await Promise.allSettled(discoverers.map((d) => d.discover()));

    const raw: DiscoveredInstance[] = [];
    const errors: DiscoverFailure[] = [];
    settled.forEach((result, i) => {
        const kind = discoverers[i]?.kind ?? 'unknown';
        if (result.status === 'fulfilled') {
            raw.push(...result.value);
        } else {
            const message = result.reason instanceof Error ? result.reason.message : String(result.reason);
            errors.push({ source: kind, message });
        }
    });

    const merged = mergeDiscovered(raw);
    if (opts.enrich === false) return { items: merged, errors };

    // 没有 id 的行补一次身份（manual / 没带 TXT 的 mDNS）—— 收到 id 后再合并一遍，跨来源去重
    const timeoutMs = opts.pingTimeoutMs ?? 1500;
    const enriched = await Promise.all(
        merged.map(async (row): Promise<DiscoveredInstance> => {
            if (row.id !== null) return row;
            const r = await fetchPing(row.endpoint, timeoutMs);
            if (!r.ok || r.info === null) {
                return { ...row, meta: { ...(row.meta ?? {}), reachable: 'false' } };
            }
            return {
                ...row,
                id: r.info.id,
                displayName: row.displayName ?? r.info.displayName,
                meta: {
                    ...row.meta,
                    reachable: 'true',
                    variant: r.info.variant,
                    ...(r.info.app !== '' ? { app: r.info.app } : {}),
                },
            };
        }),
    );
    return { items: mergeDiscovered(enriched), errors };
}

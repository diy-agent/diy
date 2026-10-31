// 发现结果合并去重：多个发现器可能同时看到同一台实例（local + mdns 最常见）。
//
// 判据：
//   · 有 id 就按 id 合并 —— id 是身份（hostname / IP / 端口都可能变，id 不变）。
//   · 没 id 的按 endpoint（归一后）合并 —— 发现阶段常常只能拿到地址。
//   · 同一个 id 出现多个 endpoint 时**只留一个**构成 `endpoint` 字段：取 `SOURCE_RANK` 靠前的来源
//     给出的那个（manual 手输 > local 本机 > tailscale 网格名 > mdns 广播），其余来源仍记在 `sources`。
//   · 输出顺序稳定：来源优先级 → 显示名 → endpoint，便于用户按序号选、也便于测试断言。

import { sourceRank, type DiscoveredInstance, type MergedInstance } from './types.js';

/**
 * endpoint 归一：补 scheme、去尾部斜杠、host 小写；**端口保留**（同机多实例靠端口区分）。
 * 解析不了的（空串 / 只有 scheme）→ null（调用方丢弃，别把垃圾塞进候选列表）。
 */
export function normalizeEndpoint(raw: string): string | null {
    const text = typeof raw === 'string' ? raw.trim() : '';
    if (text === '') return null;
    const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(text) ? text : `http://${text}`;
    let url: URL;
    try {
        url = new URL(withScheme);
    } catch {
        return null;
    }
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
    if (url.hostname === '') return null;
    url.hash = '';
    url.search = '';
    const path = url.pathname.replace(/\/+$/, '');
    return `${url.protocol}//${url.host}${path}`;
}

/** 合并同一实例的多条记录；同时按 id 与 endpoint 建索引，两条路都能对上 */
export function mergeDiscovered(items: readonly DiscoveredInstance[]): MergedInstance[] {
    const rows: MergedInstance[] = [];
    const byId = new Map<string, MergedInstance>();
    const byEndpoint = new Map<string, MergedInstance>();

    for (const raw of items) {
        const endpoint = normalizeEndpoint(raw.endpoint);
        if (endpoint === null) continue;
        const id = typeof raw.id === 'string' && raw.id.trim() !== '' ? raw.id.trim() : null;
        const displayName =
            typeof raw.displayName === 'string' && raw.displayName.trim() !== '' ? raw.displayName.trim() : null;
        const source = typeof raw.source === 'string' && raw.source.trim() !== '' ? raw.source.trim() : 'unknown';
        // 已经是合并结果的输入（`discoverAll` 补完身份后**再合并一遍**）：把它积累的 sources 一起带进来，
        // 否则第二轮会把 ["local","manual"] 削成 [raw.source]，跨来源证据凭空消失。
        const incoming: readonly string[] = Array.isArray((raw as Partial<MergedInstance>).sources)
            ? ((raw as Partial<MergedInstance>).sources ?? [])
            : [source];

        const existing = (id !== null ? byId.get(id) : undefined) ?? byEndpoint.get(endpoint);
        if (existing === undefined) {
            const row: MergedInstance = {
                id,
                displayName,
                endpoint,
                source,
                sources: [...new Set([...incoming, source])],
                ...(raw.meta ? { meta: { ...raw.meta } } : {}),
            };
            rows.push(row);
            if (id !== null) byId.set(id, row);
            byEndpoint.set(endpoint, row);
            continue;
        }

        // ── 合并进已有行 ──
        if (existing.id === null && id !== null) {
            existing.id = id;
            byId.set(id, existing);
        }
        if (existing.displayName === null && displayName !== null) existing.displayName = displayName;
        // 端点：更可信的来源给出的地址覆盖（同 rank 保留先到的）
        if (sourceRank(source) < sourceRank(existing.source)) {
            byEndpoint.delete(existing.endpoint);
            existing.endpoint = endpoint;
            existing.source = source;
        }
        for (const s of [...incoming, source]) if (!existing.sources.includes(s)) existing.sources.push(s);
        if (raw.meta) existing.meta = { ...(existing.meta ?? {}), ...raw.meta };
        byEndpoint.set(existing.endpoint, existing);
        byEndpoint.set(endpoint, existing);
    }

    for (const row of rows) row.sources.sort((a, b) => sourceRank(a) - sourceRank(b));
    return rows.sort(compareRows);
}

function compareRows(a: MergedInstance, b: MergedInstance): number {
    const ra = Math.min(...a.sources.map(sourceRank));
    const rb = Math.min(...b.sources.map(sourceRank));
    if (ra !== rb) return ra - rb;
    const na = a.displayName ?? a.id ?? a.endpoint;
    const nb = b.displayName ?? b.id ?? b.endpoint;
    if (na !== nb) return na < nb ? -1 : 1;
    return a.endpoint < b.endpoint ? -1 : a.endpoint > b.endpoint ? 1 : 0;
}

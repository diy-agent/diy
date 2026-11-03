// manual 发现器：用户直接输入 URL / host:port —— **兜底**，也用于「自动发现全都没找到」时。
//
// 只做归一（补 scheme / 补缺省端口 / 去尾部斜杠），不做探测：探测在 node 侧（`probeEndpoint`），
// 纯归一便于单测（用户输入五花八门是常态：`192.168.1.5`、`host:9400`、`http://x/`）。

import { PING_DEFAULT_PORT, type DiscoveredInstance, type Discoverer } from '../types.js';
import { normalizeEndpoint } from '../merge.js';

/**
 * 归一用户输入。与 `normalizeEndpoint` 的差别：**补缺省端口**（手输最少信息时也能用）。
 * 无法解析 → null（调用方报错，别静默丢弃用户输入）。
 */
export function normalizeManualInput(raw: string): string | null {
    const text = typeof raw === 'string' ? raw.trim() : '';
    if (text === '') return null;
    const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(text) ? text : `http://${text}`;
    let url: URL;
    try {
        url = new URL(withScheme);
    } catch {
        return null;
    }
    if (url.hostname === '') return null;
    if (url.port === '') url.port = String(PING_DEFAULT_PORT);
    return normalizeEndpoint(url.toString());
}

/** 一条输入 → 一条候选（id / displayName 未知，ping 通之后由调用方补） */
export function manualCandidates(inputs: readonly string[]): DiscoveredInstance[] {
    const out: DiscoveredInstance[] = [];
    for (const input of inputs) {
        const endpoint = normalizeManualInput(input);
        if (endpoint === null) continue;
        out.push({ id: null, displayName: null, endpoint, source: 'manual' });
    }
    return out;
}

/** manual 发现器（无外部 IO，故 `discover()` 同步结果包 Promise） */
export function manualDiscoverer(inputs: readonly string[]): Discoverer {
    return {
        kind: 'manual',
        discover: async () => manualCandidates(inputs),
    };
}

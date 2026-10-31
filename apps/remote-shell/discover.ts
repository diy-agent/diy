// discover.ts — 发现器适配层：横条上的实例列表从 ##479 的发现器来。
//
// 现阶段 `@diy-agent/remote`（##479 的成果，含 local / mdns / tailscale / manual 四路发现器）
// 还没合入 main，所以这里做两件事：
//   1. 运行时**动态 import** `@diy-agent/remote/node`：包在了就用它的 `discoverAll`
//      （联调时不用改本壳一行代码，合入即生效）；
//   2. 包不在时退回「手动 URL」这一路（`--url` / `DIY_REMOTE_ENDPOINTS`），横条照样能用。
//
// 为什么用变量形式的 import 说明符：tsc 的 `moduleResolution: bundler` 会去解析字面量，
// 包不存在时直接编译失败。变量形式 ⇒ 交给运行时，失败可捕获（Node 的 ERR_MODULE_NOT_FOUND）。
//
// ⚠️ 本模块**不复制** ##479 的发现逻辑（local 注册表 / mDNS / tailscale 全归那个包）；
// 这里只有 manual 兜底 —— 兜底是「壳的输入口」，不是第二个发现器实现。

import {
    messageOf,
    normalizeEndpoint,
    parseEndpointList,
    type DiscoveredInstance,
    type DiscoveryError,
} from './index.js';

/** ##479 的入口说明符（`@diy-agent/remote/node`） */
const REMOTE_NODE_SPEC = '@diy-agent/remote/node';

/** `discoverAll` 的结果里本壳用得到的两个字段（其余字段忽略） */
export interface RemoteDiscoverResult {
    items?: readonly DiscoveredInstance[];
    errors?: readonly DiscoveryError[];
}

/** `@diy-agent/remote/node` 里本壳用得到的形状（少即是稳：多出来的导出不关心） */
export interface RemoteNodeModule {
    discoverAll?: (options: { manual?: readonly string[] }) => Promise<RemoteDiscoverResult>;
}

/** 发现器链的完整结果：候选（未合并）+ 哪几路失败 */
export interface DiscoveryResult {
    items: DiscoveredInstance[];
    errors: DiscoveryError[];
}

export interface DiscoverOptions {
    /** 手动输入的 endpoint（CLI `--url` / `DIY_REMOTE_ENDPOINTS`） */
    manual: readonly string[];
    /** 注入用（单测换掉真实的动态 import） */
    load?: () => Promise<RemoteNodeModule | null>;
}

/** 试着加载 ##479 的 Node 入口；不在 / 形状不对 ⇒ null（退回 manual） */
async function loadRemoteModule(): Promise<RemoteNodeModule | null> {
    try {
        const specifier = REMOTE_NODE_SPEC;
        const loaded = (await import(specifier)) as RemoteNodeModule;
        return typeof loaded.discoverAll === 'function' ? loaded : null;
    } catch {
        return null;
    }
}

/** 手输的 endpoint → manual 候选（显示名留空，横条退回 host 显示） */
function manualItems(manual: readonly string[]): DiscoveredInstance[] {
    return parseEndpointList(manual.join(','), 'manual')
        .map((item) => ({ ...item, endpoint: normalizeEndpoint(item.endpoint) }))
        .filter((item) => item.endpoint !== '');
}

/**
 * 跑一遍发现链。
 *
 * 失败不连坐：远程包整个不可用只记一条 error，manual 候选照样返回（横条不能因此空掉）。
 */
export async function discoverInstances(options: DiscoverOptions): Promise<DiscoveryResult> {
    const fallback = manualItems(options.manual);
    const load = options.load ?? loadRemoteModule;
    const remote = await load();
    if (!remote?.discoverAll) return { items: fallback, errors: [] };

    try {
        const result = await remote.discoverAll({ manual: options.manual });
        return {
            // 远程包自己也会回 manual 那一路；与我们的 fallback 合并去重发生在 mergeCandidates
            items: [...(result.items ?? []), ...fallback],
            errors: [...(result.errors ?? [])],
        };
    } catch (cause) {
        return {
            items: fallback,
            errors: [{ source: 'remote', message: `发现链整体失败：${messageOf(cause)}` }],
        };
    }
}

// mdns 发现器 + 广播器：同一局域网（含 tailscale 的 mDNS 转发网段）内的 diy 实例自动互相看见。
//
// 服务类型：`_diy._tcp`（bonjour-service 里 `type: "diy"`），TXT 带 `id` / `displayName` / `variant`。
//
// 判据：
//   · **发现失败就静默降级**（多播被防火墙拦 / 没有网卡 ⇒ 空列表），不影响其它发现器。
//   · 广播失败同样静默（只记一行 warn）：一台连不上 mDNS 的机器仍能靠 local / tailscale / manual 被发现。
//   · 只在**实例起来之后**广播；退出时 unpublish（不保证执行，故读侧本来就不信过期记录）。

import Bonjour from 'bonjour-service';
import { MDNS_SERVICE_TYPE, type DiscoveredInstance, type Discoverer } from '../types.js';

/** 一条 mDNS 服务记录（把 bonjour 的对象裁成可测的数据） */
export interface MdnsServiceRecord {
    name: string;
    host: string | null;
    port: number;
    addresses: string[];
    txt: Record<string, string>;
}

/** 浏览接口（单测注入假实现；真实现见 createBonjourBrowser） */
export interface MdnsBrowser {
    browse(timeoutMs: number): Promise<MdnsServiceRecord[]>;
}

function txtOf(raw: unknown): Record<string, string> {
    const out: Record<string, string> = {};
    if (typeof raw !== 'object' || raw === null) return out;
    for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
        if (value === undefined || value === null) continue;
        out[key] = Buffer.isBuffer(value) ? value.toString('utf-8') : String(value);
    }
    return out;
}

/** 服务记录 → 候选实例（host 优先用 MagicDNS 名，退化到第一条地址） */
export function recordToInstance(rec: MdnsServiceRecord): DiscoveredInstance | null {
    const host = rec.host !== null && rec.host !== '' ? rec.host.replace(/\.$/, '') : rec.addresses[0];
    if (host === undefined || host === '' || !Number.isInteger(rec.port) || rec.port <= 0) return null;
    const txt = rec.txt;
    return {
        id: typeof txt['id'] === 'string' && txt['id'] !== '' ? txt['id'] : null,
        displayName:
            (typeof txt['displayName'] === 'string' && txt['displayName'] !== '' ? txt['displayName'] : null) ??
            rec.name,
        endpoint: `http://${host.includes(':') ? `[${host}]` : host}:${rec.port}`,
        source: 'mdns',
        ...(txt['variant'] || txt['app']
            ? {
                  meta: {
                      ...(txt['variant'] ? { variant: txt['variant'] } : {}),
                      ...(txt['app'] ? { app: txt['app'] } : {}),
                  },
              }
            : {}),
    };
}

/** 真实现：bonjour-service 的 find，收满 `timeoutMs` 后停 */
export function createBonjourBrowser(serviceType = MDNS_SERVICE_TYPE): MdnsBrowser {
    return {
        browse: (timeoutMs) =>
            new Promise<MdnsServiceRecord[]>((resolve) => {
                const found: MdnsServiceRecord[] = [];
                const seen = new Set<string>();
                let bonjour: InstanceType<typeof Bonjour> | null = null;
                let browser: ReturnType<InstanceType<typeof Bonjour>['find']> | null = null;
                const cleanup = () => {
                    try {
                        browser?.stop();
                    } catch {
                        /* 忽略 */
                    }
                    try {
                        bonjour?.destroy();
                    } catch {
                        /* 忽略 */
                    }
                };
                try {
                    bonjour = new Bonjour();
                    browser = bonjour.find({ type: serviceType }, (service) => {
                        const rec: MdnsServiceRecord = {
                            name: typeof service.name === 'string' ? service.name : '',
                            host: typeof service.host === 'string' ? service.host : null,
                            port: Number(service.port),
                            addresses: Array.isArray(service.addresses)
                                ? service.addresses.filter((a) => typeof a === 'string')
                                : [],
                            txt: txtOf(service.txt),
                        };
                        const key = `${rec.name}|${rec.host ?? ''}|${rec.port}`;
                        if (seen.has(key)) return;
                        seen.add(key);
                        found.push(rec);
                    });
                } catch (e) {
                    console.warn('[remote] mDNS 浏览启动失败（静默跳过）：', e);
                    resolve([]);
                    return;
                }
                setTimeout(
                    () => {
                        cleanup();
                        resolve(found);
                    },
                    Math.max(100, timeoutMs),
                );
            }),
    };
}

export function mdnsDiscoverer(opts: { browser?: MdnsBrowser; timeoutMs?: number } = {}): Discoverer {
    const browser = opts.browser ?? createBonjourBrowser();
    const timeoutMs = opts.timeoutMs ?? 1500;
    return {
        kind: 'mdns',
        discover: async () => {
            const records = await browser.browse(timeoutMs);
            return records.map(recordToInstance).filter((r): r is DiscoveredInstance => r !== null);
        },
    };
}

export interface MdnsPublisher {
    readonly published: boolean;
    stop(): void;
}

export interface MdnsPublishOptions {
    port: number;
    id: string;
    displayName: string;
    variant: string;
    /** app 短名（##484；地址里那段）。缺省不广播 —— 读侧对缺字段是宽松的 */
    app?: string;
    /** 绑定的网卡地址（缺省由 bonjour 自己挑） */
    host?: string;
}

/** 广播本实例（`_diy._tcp`）。任何失败都只 warn —— 广播不是本机可用的前提。 */
export function publishMdns(opts: MdnsPublishOptions): MdnsPublisher {
    try {
        const bonjour = new Bonjour();
        bonjour.publish({
            name: opts.displayName,
            type: MDNS_SERVICE_TYPE,
            port: opts.port,
            txt: {
                id: opts.id,
                displayName: opts.displayName,
                variant: opts.variant,
                ...(opts.app ? { app: opts.app } : {}),
            },
            ...(opts.host ? { host: opts.host } : {}),
        });
        return {
            published: true,
            stop: () => {
                try {
                    bonjour.unpublishAll(() => bonjour.destroy());
                } catch {
                    /* 忽略 */
                }
            },
        };
    } catch (e) {
        console.warn('[remote] mDNS 广播失败（不影响其它发现方式）：', e);
        return { published: false, stop: () => undefined };
    }
}

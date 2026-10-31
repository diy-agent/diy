// 实例的**显示身份地址**（用户裁决 ##484）：
//
//   alice@c-mac/diy-chat.lab:9401?x=s&b=2
//    └┬─┘ └─┬─┘ └──┬──┘ └┬┘ └┬─┘ └───┬──┘
//    用户  机器    app  variant 端口   属性
//
// ⚠️ 两套标识**各司其职，绝不混用**（这是本模块存在的理由）：
//   人看   `displayAddress` —— 上面这串；一眼看出「哪台机器上的哪个 app、哪个变体」
//   程序连 `id` + `endpoint` —— id 永不变、endpoint 是真实连接地址
//   自动化测试**永远不该看 displayAddress**：它随显示名 / 端口 / 同机实例数变。找实例用 id。
//
// 为什么端口默认不出现（用户裁决）：`test` / `lab` 同时起多个实例互相连是常态，但**多数时候只有一个**，
// 端口写出来只是噪音。只有「同一格」（user + host + app + variant 全同）出现多个实例时才带端口 ——
// 端口是连接的实际信息，人看到就能用；`#2` 这种序号还要多问一句「2 在哪」。
//
// 本模块**纯函数、不 import node:***（renderer / CLI / 主进程共用一份判据）。

import type { PingInfo } from './types.js';

/** 拆开的身份地址（`formatAddress` 的入参 / `parseAddress` 的出参） */
export interface InstanceAddress {
    /** 本机登录名（`os.userInfo().username`） */
    user: string;
    /** 机器显示名（`InstanceIdentity.displayName`，用户可改；**id 才是稳定标识**） */
    host: string;
    /** app 短名（`@diy-agent/app-chat` → `diy-chat`，见 `shortAppName`） */
    app: string;
    /** 产物变体：prod / lab / test / preview */
    variant: string;
    /** 端口：**仅同格多实例时**才该出现在地址里（见 `displayAddress`） */
    port?: number;
    /** 任意附加属性（`?x=s&b=2`）；缺省 / 空对象 = 不带 `?` */
    attrs?: Record<string, string>;
}

/**
 * 段内保留字符：出现在段里地址就无法反解。
 * `/` 分 app、`@` 分用户、`:` 分端口、`?` 分属性、`&` 分 k=v、`#` 与空白只为可读性。
 * `.` 不在其中 —— 机器名（`c-mac.local`）本来就带点，反解时它属于 host 段（host 到 `/` 才结束）。
 */
const RESERVED = /[/@:?#&\s]/;
/** app / variant 还要躲开 `.`：那两段之间靠 `.` 分界 */
const RESERVED_APP = /[/@:?#&\s.]/;

/**
 * 包名 → 地址里的 app 短名（地址栏里 `@diy-agent/app-chat` 太长）。
 *
 * `@diy-agent/app-chat` → `diy-chat`、`@diy-agent/app` → `diy`、`video` → `video`（已短的原样）。
 */
export function shortAppName(packageName: string): string {
    const base = packageName.trim().split('/').pop() ?? '';
    if (base === '' || base === 'app') return 'diy';
    if (base.startsWith('app-')) return `diy-${base.slice('app-'.length)}`;
    return base;
}

function assertSegment(label: string, value: string, pattern: RegExp): void {
    if (typeof value !== 'string' || value.trim() === '') {
        throw new TypeError(`地址段「${label}」不能为空`);
    }
    if (pattern.test(value)) {
        throw new TypeError(`地址段「${label}」含保留字符（${value}）`);
    }
}

function formatAttrs(attrs: Record<string, string>): string {
    const pairs = Object.entries(attrs).filter(([, value]) => typeof value === 'string');
    if (pairs.length === 0) return '';
    return `?${pairs.map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(value)}`).join('&')}`;
}

/**
 * 组装地址。**严格**：段里带保留字符 / 端口不合法就抛 `TypeError`
 * （宁可报错，也不静默把 `c/mac` 拼成一个反解不回来的地址）。
 * 段内容常常是用户可改的显示名 ⇒ 需要兜底时用 `tryFormatAddress`。
 */
export function formatAddress(addr: InstanceAddress): string {
    assertSegment('user', addr.user, RESERVED);
    assertSegment('host', addr.host, RESERVED);
    assertSegment('app', addr.app, RESERVED_APP);
    assertSegment('variant', addr.variant, RESERVED_APP);
    if (addr.port !== undefined && (!Number.isInteger(addr.port) || addr.port <= 0 || addr.port > 65535)) {
        throw new TypeError(`端口不合法：${String(addr.port)}`);
    }
    const port = addr.port === undefined ? '' : `:${String(addr.port)}`;
    const attrs = addr.attrs === undefined ? '' : formatAttrs(addr.attrs);
    return `${addr.user}@${addr.host}/${addr.app}.${addr.variant}${port}${attrs}`;
}

/** `formatAddress` 的不抛版本：拼不出来（段非法 / 端口不对）⇒ null（UI 退回显示名） */
export function tryFormatAddress(addr: InstanceAddress): string | null {
    try {
        return formatAddress(addr);
    } catch {
        return null;
    }
}

const ADDRESS_PATTERN = /^([^/@:?#&\s]+)@([^/@:?#&\s]+)\/([^/@:?#&\s.]+)\.([^/@:?#&\s.]+)(?::(\d+))?(?:\?(.*))?$/;

/**
 * 反解地址（`formatAddress` 的逆）。**宽松**：不是地址就返回 null，不抛
 * （与 `parsePingInfo` 同口径 —— 用户手输 / 对端自报的东西没有信任基础）。
 */
export function parseAddress(text: string): InstanceAddress | null {
    if (typeof text !== 'string') return null;
    const m = ADDRESS_PATTERN.exec(text.trim());
    if (m === null) return null;
    const [, user, host, app, variant, portText, attrText] = m;
    if (user === undefined || host === undefined || app === undefined || variant === undefined) return null;

    let port: number | undefined;
    if (portText !== undefined) {
        const n = Number(portText);
        if (!Number.isInteger(n) || n <= 0 || n > 65535) return null;
        port = n;
    }

    let attrs: Record<string, string> | undefined;
    if (attrText !== undefined && attrText !== '') {
        const out: Record<string, string> = {};
        for (const pair of attrText.split('&')) {
            if (pair === '') continue;
            const eq = pair.indexOf('=');
            const rawKey = eq === -1 ? pair : pair.slice(0, eq);
            const rawValue = eq === -1 ? '' : pair.slice(eq + 1);
            try {
                out[decodeURIComponent(rawKey)] = decodeURIComponent(rawValue);
            } catch {
                return null; // 坏转义：这串不是我们排出来的
            }
        }
        attrs = out;
    }

    return {
        user,
        host,
        app,
        variant,
        ...(port === undefined ? {} : { port }),
        ...(attrs === undefined ? {} : { attrs }),
    };
}

/**
 * 两个地址是不是「同一格」（判「要不要带端口」的键）：
 * user + host + app + variant 全同 ⇒ 光看地址分不清是哪一个实例。
 */
export function sameAddressGroup(a: InstanceAddress, b: InstanceAddress): boolean {
    return a.user === b.user && a.host === b.host && a.app === b.app && a.variant === b.variant;
}

/** 同格里的实例数（含自己）：> 1 ⇒ 地址必须带端口才分得清 */
export function addressGroupSize(addr: InstanceAddress, peers: readonly InstanceAddress[] = []): number {
    return 1 + peers.filter((peer) => sameAddressGroup(peer, addr)).length;
}

/**
 * 人看的地址：**默认不带端口**；同格出现多个实例时自动带（判据见文件头）。
 *
 * `peers` = 其它实例的地址（不含自己）。拿不到端口时只能不带 —— 地址照样可读，只是分不清多实例。
 */
export function displayAddress(addr: InstanceAddress, peers: readonly InstanceAddress[] = []): string {
    const conflict = addressGroupSize(addr, peers) > 1;
    const { port, ...rest } = addr;
    return formatAddress(conflict && port !== undefined ? { ...rest, port } : rest);
}

/**
 * `displayAddress` 的**不抛**版本：显示名是用户可改的，可能含保留字符（`c/mac`）。
 * 拼不出来就退回 `user@host` —— 横条 / CLI 永远有东西可显示，不因一个怪名字崩掉。
 */
export function safeDisplayAddress(addr: InstanceAddress, peers: readonly InstanceAddress[] = []): string {
    try {
        return displayAddress(addr, peers);
    } catch {
        return `${addr.user}@${addr.host}`;
    }
}

/** 从 endpoint 取端口（`http://127.0.0.1:9401` → 9401）；不合法 / 没端口 ⇒ null */
export function portOfEndpoint(endpoint: string): number | null {
    try {
        const url = new URL(endpoint);
        if (url.port === '') return null;
        const n = Number(url.port);
        return Number.isInteger(n) && n > 0 && n <= 65535 ? n : null;
    } catch {
        return null;
    }
}

/**
 * `/ping` 载荷 + endpoint → 地址（`user` 由调用方给：本模块不碰 `node:os`）。
 *
 * 端口从 endpoint 取 —— 它才是「程序连的那个」；`PingInfo` 里故意不放端口（发现器自报 endpoint）。
 */
export function addressOfPing(info: PingInfo, endpoint: string, opts: { user: string }): InstanceAddress {
    const port = portOfEndpoint(endpoint);
    return {
        user: opts.user,
        host: info.displayName,
        app: info.app,
        variant: info.variant,
        ...(port === null ? {} : { port }),
    };
}

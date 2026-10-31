// index.ts — A1 远程壳的**纯领域层**：类型 / 归一化 / 合并 / 参数解析。
//
// 这里不放任何 Electron / Node IO（单测直接 import 就能跑）：窗口、视图、心跳都在 main.ts，
// 横条 HTML 在 bar.ts，发现器适配在 discover.ts。
//
// 三条硬规则（##481 body）在这一层体现为：
//   1. 横条高度是**壳的常量**（BAR_HEIGHT），远程页面永远从 y=32 开始 —— 物理上盖不住横条。
//   2. 连接状态只描述「当前在哪台 + 通不通」，不带任何确认 / 拦截。
//   3. 连接保留 = 以 endpoint 为键（见 main.ts 的 pages Map），不淘汰。

/** 横条高度（px）：横条由 shell 自己渲染，远程页面区的 y 从它开始 */
export const BAR_HEIGHT = 32;

export const TITLE = 'diy 远程壳（A1）';

export const DEFAULT_WIDTH = 1200;
export const DEFAULT_HEIGHT = 800;

/** 心跳间隔：远程进程悄悄死掉时，页面自己不会喊，只能壳去探 */
export const HEARTBEAT_INTERVAL_MS = 3000;
/** 单次探活超时（内网 / tailnet 都够用；再慢就当断线，让人看见） */
export const HEARTBEAT_TIMEOUT_MS = 1500;

/** `/ping` 路径与 ##479 一致（本壳只把它当「对端还活着」的信号，不解析字段） */
export const PING_PATH = '/ping';

/**
 * 一台被发现到的 diy 实例。
 *
 * ⚠️ 与 ##479 `@diy-agent/remote` 的 `DiscoveredInstance` **逐字段一致**
 * （真源：`pkgs.ts/diy-remote/src/types.ts`，该包尚未合入 main）。合入后把这里换成
 * `import type { DiscoveredInstance } from "@diy-agent/remote"` 即可，其余代码不动。
 */
export interface DiscoveredInstance {
    /** 实例自报的永不变 id；发现阶段可能不知道（null ≠ 没有 id） */
    id: string | null;
    /** 可改的显示名（缺省 hostname）；未知为 null */
    displayName: string | null;
    /** 直接可用的基址，形如 `http://192.168.1.5:9400` */
    endpoint: string;
    /** 哪个发现器给出的（local / mdns / tailscale / manual） */
    source: string;
    /** 发现器附带的证据（variant / pid…），只作线索 */
    meta?: Record<string, string>;
}

/** 合并去重后的一行（同一实例常被多路同时看到） */
export interface MergedCandidate extends DiscoveredInstance {
    /** 参与合并的来源，按 SOURCE_RANK 排序 */
    sources: string[];
}

/** 多源合并时的端点优先级：manual 最高（用户手输 = 明确意图，不该被自动发现覆盖） */
export const SOURCE_RANK: readonly string[] = ['manual', 'local', 'tailscale', 'mdns'];

export function sourceRank(source: string): number {
    const index = SOURCE_RANK.indexOf(source);
    return index === -1 ? SOURCE_RANK.length : index;
}

export type ConnectionStatus = 'connecting' | 'connected' | 'disconnected';

/** 当前所在实例（横条左侧显示的就是它） */
export interface CurrentInstance {
    endpoint: string;
    displayName: string;
    /**
     * 人读地址 `user@host/app.variant[:port]`（##484：横条显示的**就是它**，不再是 URL）。
     * null = 还没 ping 到 app / variant（此时横条退回显示名）。
     */
    address: string | null;
    status: ConnectionStatus;
    /** 断线 / 加载失败的一句话原因（连上时没有） */
    detail?: string;
}

/** 横条列表里的一行：候选 + 人读地址（null = 身份还没 ping 到，横条退回显示名 / endpoint） */
export interface BarInstance extends MergedCandidate {
    address: string | null;
}

/** 横条拿到的完整状态（一次推全量，横条只负责画） */
export interface BarState {
    current: (CurrentInstance & { dot: string; label: string }) | null;
    instances: readonly BarInstance[];
    /** 哪几路发现器失败（空 = 全部正常） */
    errors: readonly DiscoveryError[];
}

export interface DiscoveryError {
    source: string;
    message: string;
}

export interface BarLayoutRect {
    x: number;
    y: number;
    width: number;
    height: number;
}

/**
 * 布局自述（判据 3 的结构性证据）：横条与页面是**两个独立 WebContentsView**，
 * 几何上不重叠 ⇒ 远程页面渲染什么（哪怕 position:fixed inset:0）都到不了横条那一行。
 */
export interface ShellLayout {
    bar: { bounds: BarLayoutRect; webContentsId: number };
    page: { bounds: BarLayoutRect; webContentsId: number; endpoint: string } | null;
    /** 视图按 z 序（末位 = 最上）；横条必须是最末一个 */
    children: { webContentsId: number; bounds: BarLayoutRect }[];
    /** 横条与**任一其他视图**有没有重叠（必须 false；保留的隐藏页也算） */
    overlap: boolean;
    windowHeight: number;
}

/** 状态 → 横条的圆点（壳决定，页面 / 远程都改不了） */
export function statusDot(status: ConnectionStatus): string {
    if (status === 'connected') return '●';
    if (status === 'connecting') return '◌';
    return '⚠';
}

/** 状态 → 横条的文案 */
export function statusLabel(status: ConnectionStatus): string {
    if (status === 'connected') return '已连';
    if (status === 'connecting') return '连接中';
    return '断线';
}

/** 给横条补上圆点与文案（派生字段只在主进程算一次） */
export function withBadge(instance: CurrentInstance): CurrentInstance & { dot: string; label: string } {
    return { ...instance, dot: statusDot(instance.status), label: statusLabel(instance.status) };
}

/**
 * endpoint 归一化：补 `http://`、去掉末尾斜杠。
 * **不剥路径** —— 手输的 `http://host:8080/app` 也是合法基址（探活只取 origin）。
 */
export function normalizeEndpoint(raw: string): string {
    const text = raw.trim();
    if (text === '') return '';
    const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(text) ? text : `http://${text}`;
    return withScheme.replace(/\/+$/, '');
}

/** 取 origin（`/ping` 探活挂在这里；手输了路径也不影响） */
export function originOf(endpoint: string): string {
    try {
        return new URL(endpoint).origin;
    } catch {
        return endpoint;
    }
}

/** 探活 URL */
export function pingUrl(endpoint: string): string {
    return `${originOf(endpoint)}${PING_PATH}`;
}

/** 显示名：自报优先，其次 host，最后原样（永远不空） */
export function displayNameOf(instance: { displayName: string | null; endpoint: string }): string {
    const named = instance.displayName?.trim();
    if (named) return named;
    try {
        return new URL(instance.endpoint).host || instance.endpoint;
    } catch {
        return instance.endpoint;
    }
}

// ── 显示身份地址（##484）─────────────────────────────────────────────────
//
// 人看 `alice@c-mac/diy-chat.lab`（用户@机器/app.variant[:端口][?属性]）；
// 程序连**永远**用 id + endpoint —— 两套标识各司其职，自动化测试不该看地址。
//
// ⚠️ 下面是 `@diy-agent/remote`（`pkgs.ts/diy-remote/src/address.ts`）的**同构副本**：
// 本壳刻意不与那个包做构建期耦合（见 discover.ts 头注：包不在也要能独立跑），故纯函数抄一份。
// `tests/address.test.ts` 对着两份实现逐例对拍 —— 改了一边没改另一边就红。

/** 拆开的身份地址（与 `@diy-agent/remote` 的 `InstanceAddress` 逐字段一致） */
export interface InstanceAddress {
    /** 本机登录名（`os.userInfo().username`） */
    user: string;
    /** 机器显示名（用户可改；id 才是稳定标识） */
    host: string;
    /** app 短名（`@diy-agent/app-chat` → `diy-chat`） */
    app: string;
    /** 产物变体：prod / lab / test / preview */
    variant: string;
    /** 端口：仅同格多实例时才出现在地址里 */
    port?: number;
    /** 任意附加属性（`?x=s&b=2`） */
    attrs?: Record<string, string>;
}

/** 段内保留字符（见 `@diy-agent/remote` 同名注释）；`.` 只在 app / variant 段里算保留 */
const ADDRESS_RESERVED = /[/@:?#&\s]/;
const ADDRESS_RESERVED_APP = /[/@:?#&\s.]/;

function assertAddressSegment(label: string, value: string, pattern: RegExp): void {
    if (typeof value !== 'string' || value.trim() === '') throw new TypeError(`地址段「${label}」不能为空`);
    if (pattern.test(value)) throw new TypeError(`地址段「${label}」含保留字符（${value}）`);
}

function formatAddressAttrs(attrs: Record<string, string>): string {
    const pairs = Object.entries(attrs).filter(([, value]) => typeof value === 'string');
    if (pairs.length === 0) return '';
    return `?${pairs.map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(value)}`).join('&')}`;
}

/** 组装地址（严格：段非法 / 端口不对就抛；调用方要兜底用 `safeDisplayAddress`） */
export function formatAddress(addr: InstanceAddress): string {
    assertAddressSegment('user', addr.user, ADDRESS_RESERVED);
    assertAddressSegment('host', addr.host, ADDRESS_RESERVED);
    assertAddressSegment('app', addr.app, ADDRESS_RESERVED_APP);
    assertAddressSegment('variant', addr.variant, ADDRESS_RESERVED_APP);
    if (addr.port !== undefined && (!Number.isInteger(addr.port) || addr.port <= 0 || addr.port > 65535)) {
        throw new TypeError(`端口不合法：${String(addr.port)}`);
    }
    const port = addr.port === undefined ? '' : `:${String(addr.port)}`;
    const attrs = addr.attrs === undefined ? '' : formatAddressAttrs(addr.attrs);
    return `${addr.user}@${addr.host}/${addr.app}.${addr.variant}${port}${attrs}`;
}

const ADDRESS_PATTERN = /^([^/@:?#&\s]+)@([^/@:?#&\s]+)\/([^/@:?#&\s.]+)\.([^/@:?#&\s.]+)(?::(\d+))?(?:\?(.*))?$/;

/** 反解地址（宽松：不是地址 ⇒ null，不抛） */
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
                return null;
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

/** 两个地址是不是「同一格」（判「要不要带端口」的键）：user + host + app + variant 全同 */
export function sameAddressGroup(a: InstanceAddress, b: InstanceAddress): boolean {
    return a.user === b.user && a.host === b.host && a.app === b.app && a.variant === b.variant;
}

/** 同格里的实例数（含自己）：> 1 ⇒ 地址必须带端口才分得清 */
export function addressGroupSize(addr: InstanceAddress, peers: readonly InstanceAddress[] = []): number {
    return 1 + peers.filter((peer) => sameAddressGroup(peer, addr)).length;
}

/** 人看的地址：**默认不带端口**，同格多实例才带（端口是连接的实际信息） */
export function displayAddress(addr: InstanceAddress, peers: readonly InstanceAddress[] = []): string {
    const conflict = addressGroupSize(addr, peers) > 1;
    const { port, ...rest } = addr;
    return formatAddress(conflict && port !== undefined ? { ...rest, port } : rest);
}

/** `displayAddress` 的不抛版本：显示名是用户可改的，拼不出来退回 `user@host` */
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

/** 一台实例的地址原料：发现器给 displayName + meta（app / variant），/ping 也能补 */
export interface AddressSource {
    endpoint: string;
    displayName: string | null;
    app: string | null;
    variant: string | null;
}

/** 原料 → 地址；缺 app / variant / host 就 null（宁可只显示名字，也不编一段地址出来） */
export function addressOf(source: AddressSource, user: string): InstanceAddress | null {
    const host = source.displayName?.trim() ?? '';
    const app = source.app?.trim() ?? '';
    const variant = source.variant?.trim() ?? '';
    if (host === '' || app === '' || variant === '') return null;
    const port = portOfEndpoint(source.endpoint);
    return { user, host, app, variant, ...(port === null ? {} : { port }) };
}

/**
 * 一组实例 → 每台的人读地址（`Map<endpoint, 地址 | null>`）。
 * 同格多实例自动带端口 —— 判据就靠「这一整组」而不是单台，故必须整组一起算。
 */
export function displayAddresses(sources: readonly AddressSource[], user: string): Map<string, string | null> {
    const rows = sources.map((source) => ({ endpoint: source.endpoint, address: addressOf(source, user) }));
    const known = rows.filter((row): row is { endpoint: string; address: InstanceAddress } => row.address !== null);
    const out = new Map<string, string | null>();
    for (const row of rows) {
        if (row.address === null) {
            out.set(row.endpoint, null);
            continue;
        }
        const peers = known.filter((other) => other.endpoint !== row.endpoint).map((other) => other.address);
        out.set(row.endpoint, safeDisplayAddress(row.address, peers));
    }
    return out;
}

/**
 * 合并去重：同一台实例可能被 mdns + local 同时看到。
 * 键优先用 id（同一台跨 endpoint），没有 id 时用 endpoint；多来源记进 `sources`。
 */
export function mergeCandidates(items: readonly DiscoveredInstance[]): MergedCandidate[] {
    const merged: MergedCandidate[] = [];
    const byId = new Map<string, MergedCandidate>();
    const byEndpoint = new Map<string, MergedCandidate>();

    for (const item of items) {
        const endpoint = normalizeEndpoint(item.endpoint);
        if (endpoint === '') continue;
        const knownId = item.id === null ? null : item.id;
        const prior = (knownId === null ? undefined : byId.get(knownId)) ?? byEndpoint.get(endpoint);
        if (prior) {
            if (!prior.sources.includes(item.source)) prior.sources.push(item.source);
            if (prior.displayName === null && item.displayName !== null) prior.displayName = item.displayName;
            if (prior.id === null && item.id !== null) prior.id = item.id;
            // 高优先级来源（manual > local > tailscale > mdns）说了算：endpoint 与 source 一起换
            if (sourceRank(item.source) < sourceRank(prior.source)) {
                prior.endpoint = endpoint;
                prior.source = item.source;
            }
            if (item.meta && prior.meta === undefined) prior.meta = item.meta;
            byEndpoint.set(endpoint, prior);
            if (prior.id !== null) byId.set(prior.id, prior);
            continue;
        }
        const fresh: MergedCandidate = {
            id: item.id,
            displayName: item.displayName,
            endpoint,
            source: item.source,
            sources: [item.source],
            ...(item.meta ? { meta: item.meta } : {}),
        };
        merged.push(fresh);
        byEndpoint.set(endpoint, fresh);
        if (fresh.id !== null) byId.set(fresh.id, fresh);
    }

    const sorted = merged.map((item) => ({
        ...item,
        sources: [...item.sources].sort((a, b) => sourceRank(a) - sourceRank(b)),
    }));
    sorted.sort(
        (a, b) => sourceRank(a.source) - sourceRank(b.source) || displayNameOf(a).localeCompare(displayNameOf(b)),
    );
    return sorted;
}

/** `DIY_REMOTE_ENDPOINTS` / CLI 里的逗号（或空白）分隔列表 → manual 候选 */
export function parseEndpointList(raw: string | undefined, source = 'manual'): DiscoveredInstance[] {
    if (!raw) return [];
    return raw
        .split(/[\s,]+/)
        .map((part) => part.trim())
        .filter((part) => part !== '')
        .map((endpoint) => ({ id: null, displayName: null, endpoint: normalizeEndpoint(endpoint), source }));
}

export interface CliArgs {
    url: string | null;
    width: number;
    height: number;
}

/**
 * 只认自己的三个开关（`--url` / `--width` / `--height`），其余 argv 一律忽略 ——
 * Electron / Chromium 自己的开关（`--remote-debugging-port` 等）不能被当成错误。
 */
export function parseCliArgs(argv: readonly string[]): CliArgs {
    const args: CliArgs = { url: null, width: DEFAULT_WIDTH, height: DEFAULT_HEIGHT };
    for (let i = 0; i < argv.length; i += 1) {
        const raw = argv[i] ?? '';
        const eq = raw.indexOf('=');
        const name = eq === -1 ? raw : raw.slice(0, eq);
        const inline = eq === -1 ? null : raw.slice(eq + 1);
        const value = (): string => {
            if (inline !== null) return inline;
            const next = argv[i + 1];
            if (next !== undefined) i += 1;
            return next ?? '';
        };
        if (name === '--url') {
            const endpoint = normalizeEndpoint(value());
            if (endpoint !== '') args.url = endpoint;
        } else if (name === '--width') {
            const width = Number(value());
            if (Number.isFinite(width) && width > 0) args.width = Math.round(width);
        } else if (name === '--height') {
            const height = Number(value());
            if (Number.isFinite(height) && height > 0) args.height = Math.round(height);
        }
    }
    return args;
}

/** 两个矩形有没有重叠（横条保护的结构判据；贴边不算重叠） */
export function rectsOverlap(a: BarLayoutRect, b: BarLayoutRect): boolean {
    if (a.width <= 0 || a.height <= 0 || b.width <= 0 || b.height <= 0) return false;
    return a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;
}

/** 错误对象 → 一句话（心跳 / 发现的 detail 用） */
export function messageOf(cause: unknown): string {
    if (cause instanceof Error) return cause.message;
    return String(cause);
}

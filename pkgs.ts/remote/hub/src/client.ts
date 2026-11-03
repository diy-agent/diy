// 卫星侧：拿地址（人比对）→ 输码提交 → 拿 Token → 长连（WSS + 心跳 + 退避重连）。
//
// **地址即身份**（协议备忘 §二）：配对分成两步，结构上强制「先显示地址，再交码」——
//
//   preparePairing(url)   GET /hub/info，返回要连接的 host；**不发送任何秘密**
//   completePairing(...)  人比对完地址、输入码之后才调用；body 里才有 code
//
// 没有「一步到位」的入口：想跳过显示地址只能自己重写 HTTP，本包不给刀。
//
// 判据 14：卫星**只连出**，本文件不出现任何 listen / createServer。

import { WebSocket } from 'ws';
import { HubError } from './errors.js';
import { generateKeyPair, type KeyPair } from './key.js';
import { assertPairableAddress, displayAddress, normalizeHubEndpoint, parseInviteUrl } from './links.js';
import type { SecretStore } from './secret.js';
import { writeLink } from './store-fs.js';
import {
    HEARTBEAT_INTERVAL_MS,
    HUB_PROTOCOL_VERSION,
    RECONNECT_BASE_MS,
    RECONNECT_MAX_MS,
    type HubInfo,
    type HubLink,
    type PairRequestBody,
    type PairSuccess,
} from './types.js';

export interface FetchLike {
    (
        input: string,
        init?: { method?: string; headers?: Record<string, string>; body?: string; signal?: AbortSignal },
    ): Promise<{
        ok: boolean;
        status: number;
        json(): Promise<unknown>;
        text(): Promise<string>;
    }>;
}

export interface FetchOptions {
    fetchImpl?: FetchLike;
    timeoutMs?: number;
    /** 只给单测 / 内网自建：允许非 tailscale / 明文地址（**必须显式**，不静默降级） */
    allowInsecure?: boolean;
}

/** `GET /hub/info` —— 公开信息，**不含任何秘密** */
export async function fetchHubInfo(endpoint: string, opts: FetchOptions = {}): Promise<HubInfo> {
    const base = normalizeHubEndpoint(endpoint);
    const doFetch = opts.fetchImpl ?? (globalThis.fetch as unknown as FetchLike);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), opts.timeoutMs ?? 5_000);
    try {
        const res = await doFetch(`${base}/info`, { signal: controller.signal });
        if (!res.ok) throw new HubError('hub/bad-input', `/hub/info 返回 ${res.status}`, base);
        const info = (await res.json()) as HubInfo;
        if (info.protocolVersion !== HUB_PROTOCOL_VERSION) {
            throw new HubError(
                'hub/protocol-mismatch',
                `协议版本不一致：Hub 是 ${info.protocolVersion}，本机是 ${HUB_PROTOCOL_VERSION}`,
            );
        }
        if (!info.hubPublicKey || !info.hubNodeId) {
            throw new HubError('hub/bad-input', '/hub/info 缺 hubPublicKey / hubNodeId');
        }
        return info;
    } finally {
        clearTimeout(timer);
    }
}

/** 第一步的产物：**必须先把 `address` 显示给人**，人确认之后才能调 `completePairing`。 */
export interface PreparedPairing {
    /** Hub 基址 `https://c-mac.gute-fish.ts.net/hub` */
    endpoint: string;
    inviteId: string;
    /** 给人比对的地址（host） */
    address: string;
    info: HubInfo;
}

/**
 * 第一步：解析邀请 URL、校验配对地址策略、取 Hub 公开信息。
 *
 * 这一步**不发任何秘密**（没有 code、没有公钥）。返回的 `address` 就是要显示给人看的那一行。
 */
export async function preparePairing(inviteUrl: string, opts: FetchOptions = {}): Promise<PreparedPairing> {
    const { endpoint, inviteId } = parseInviteUrl(inviteUrl);
    assertPairableAddress(endpoint, { allowInsecure: opts.allowInsecure });
    const info = await fetchHubInfo(endpoint, opts);
    return { endpoint, inviteId, address: displayAddress(endpoint), info };
}

export interface CompletePairingInput {
    code: string;
    nodeId: string;
    displayName: string;
    keyPair?: KeyPair;
    /** 等待 Owner 批准的最长毫秒数（缺省 0 = 只提交，不等待） */
    waitMs?: number;
}

export interface CompletePairingResult {
    result: PairSuccess;
    keyPair: KeyPair;
}

/**
 * 第二步：人比对过 `prepared.address` 之后，才把码与公钥发出去。
 *
 * 参数类型就是 `PreparedPairing` —— 没有经过 `preparePairing` 就拿不到它。
 */
export async function completePairing(
    prepared: PreparedPairing,
    input: CompletePairingInput,
    opts: FetchOptions = {},
): Promise<CompletePairingResult> {
    const keyPair = input.keyPair ?? generateKeyPair();
    const body: PairRequestBody = {
        protocolVersion: HUB_PROTOCOL_VERSION,
        inviteId: prepared.inviteId,
        domainId: prepared.info.domainId,
        code: input.code,
        nodeId: input.nodeId,
        displayName: input.displayName,
        publicKey: keyPair.publicKey,
        waitMs: input.waitMs ?? 0,
    };
    const doFetch = opts.fetchImpl ?? (globalThis.fetch as unknown as FetchLike);
    const res = await doFetch(`${prepared.endpoint}/pair`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
    });
    const payload = (await res.json()) as PairSuccess & { error?: string; message?: string };
    if (!res.ok) {
        throw new HubError(
            (payload.error as HubError['code']) ?? 'hub/bad-input',
            payload.message ?? `/hub/pair 返回 ${res.status}`,
        );
    }
    return { result: payload, keyPair };
}

/** 卫星侧落盘：Token 进钥匙串，link.json 只留非敏感信息（判据 11） */
export async function persistPairing(
    deps: { secrets: SecretStore; linkFile: string; endpoint: string },
    info: HubInfo,
    token: string,
): Promise<HubLink> {
    await deps.secrets.set(tokenAccount(info.hubNodeId), token);
    const link: HubLink = {
        version: 1,
        domainId: info.domainId,
        hubNodeId: info.hubNodeId,
        hubPublicKey: info.hubPublicKey,
        hubEndpoint: normalizeHubEndpoint(deps.endpoint),
    };
    writeLink(deps.linkFile, link);
    return link;
}

export function tokenAccount(hubNodeId: string): string {
    return `token:${hubNodeId}`;
}

export function reconnectDelay(attempt: number): number {
    const safe = Math.max(0, Math.floor(attempt));
    return Math.min(RECONNECT_BASE_MS * 2 ** safe, RECONNECT_MAX_MS);
}

export type ClientState = 'connecting' | 'online' | 'offline' | 'revoked';

export interface HubClientOptions {
    hubEndpoint: string;
    token: string;
    heartbeatMs?: number;
    now?: () => Date;
    onState?: (state: ClientState, detail?: { attempt?: number; delayMs?: number; reason?: string }) => void;
}

/**
 * 卫星的长连循环：连上 → 心跳 → 断了按 1s/2s/…/60s 退避重连。
 * 撤销（服务端 403 或关闭码 4003）**停止重连**并进入 `revoked`（判据 17）。
 */
export class HubClient {
    private ws: WebSocket | null = null;
    private stopped = false;
    private attempt = 0;
    private heartbeat: NodeJS.Timeout | null = null;
    private retryTimer: NodeJS.Timeout | null = null;
    private current: ClientState = 'offline';

    constructor(private readonly opts: HubClientOptions) {}

    get state(): ClientState {
        return this.current;
    }

    start(): void {
        this.stopped = false;
        this.connect();
    }

    stop(): void {
        this.stopped = true;
        this.clearTimers();
        this.ws?.close(1000, 'client stopped');
        this.ws = null;
    }

    private connect(): void {
        if (this.stopped) return;
        this.setState('connecting', { attempt: this.attempt });
        const ws = new WebSocket(wsUrl(this.opts.hubEndpoint), {
            headers: { authorization: `Bearer ${this.opts.token}` },
        });
        this.ws = ws;

        ws.on('open', () => {
            this.attempt = 0;
            this.setState('online');
            this.startHeartbeat(ws);
        });
        ws.on('unexpected-response', (_req, res) => {
            // 401/403 = 无此 Token / 成员关系被撤销 —— 不再重连（判据 17）
            if (res.statusCode === 403 || res.statusCode === 401) {
                this.setState('revoked', { reason: `HTTP ${res.statusCode}` });
                this.stop();
            }
        });
        ws.on('close', (code: number) => {
            this.clearTimers();
            this.ws = null;
            if (this.stopped) return;
            if (code === 4003) {
                this.setState('revoked', { reason: 'membership revoked' });
                this.stop();
                return;
            }
            const delay = reconnectDelay(this.attempt++);
            this.setState('offline', { attempt: this.attempt, delayMs: delay });
            this.retryTimer = setTimeout(() => this.connect(), delay);
        });
        ws.on('error', () => {
            /* close 会跟着来，重连逻辑只在 close 里做，避免双触发 */
        });
    }

    private startHeartbeat(ws: WebSocket): void {
        const interval = this.opts.heartbeatMs ?? HEARTBEAT_INTERVAL_MS;
        this.heartbeat = setInterval(() => {
            if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'ping' }));
        }, interval);
    }

    private clearTimers(): void {
        if (this.heartbeat) clearInterval(this.heartbeat);
        if (this.retryTimer) clearTimeout(this.retryTimer);
        this.heartbeat = null;
        this.retryTimer = null;
    }

    private setState(state: ClientState, detail?: { attempt?: number; delayMs?: number; reason?: string }): void {
        this.current = state;
        this.opts.onState?.(state, detail);
    }
}

function wsUrl(endpoint: string): string {
    const url = new URL(normalizeHubEndpoint(endpoint));
    url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
    url.pathname = '/hub/ws';
    url.search = '';
    return url.toString();
}

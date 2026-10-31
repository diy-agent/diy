// 实例的 `/ping` 服务端 —— 本轮**唯一**对外暴露的 HTTP 面（##479）。
//
// ⚠️⚠️ 当前**没有任何鉴权**（本轮明确不做）。所以：
//   · 缺省只绑 `127.0.0.1`（回环）——只有本机能连；
//   · 要跨机 ping 才由用户显式设 `DIY_PING_HOST=0.0.0.0` 或某个内网地址（如 tailscale IP）；
//   · **绝不绑公网地址**：没有 token、没有 TLS、没有限流，暴露公网 = 把「这台机器上有 diy、
//     pid、启动时间」交给任何扫描器。文档与 README 都写明这条，别等出事再补。
//
// 只实现 `GET /ping`（+ HEAD）：不提供任何读写数据的能力，故即使被同网段的机器看到，
// 信息面也止于 PingInfo（不含数据根路径、不含任务/会话内容）。

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { hostname } from 'node:os';
import { PING_DEFAULT_PORT, PING_PATH, type PingInfo } from '../types.js';
import type { InstanceIdentity } from '../identity.js';

export interface PingServerOptions {
    identity: InstanceIdentity;
    /** 产物变体（prod / lab / test / preview） */
    variant: string;
    /** 实例版本（app.getVersion() 或包版本） */
    version: string;
    /** 绑哪个地址；缺省 = `DIY_PING_HOST` || `127.0.0.1`（见文件头：别暴露公网） */
    host?: string;
    /** 端口；缺省 = `DIY_PING_PORT` || 9400 */
    port?: number;
    /** 端口被占时向后顺延几个（缺省 10：同机多实例各占一个；显式给端口时不给顺延） */
    fallbackPorts?: number;
    /** 启动时刻（缺省 = 现在；`uptimeMs` 由它算） */
    startedAt?: Date;
    /** 缺省 = 本进程 pid */
    pid?: number;
}

export interface PingServerHandle {
    host: string;
    port: number;
    /** `http://host:port`（发现器写进结果的形态） */
    baseUrl: string;
    /** 当前会返回的载荷（测试与 CLI `diy remote self` 用） */
    info(): PingInfo;
    close(): Promise<void>;
}

function envPort(env: NodeJS.ProcessEnv): number | null {
    const raw = env['DIY_PING_PORT'];
    if (raw === undefined || raw.trim() === '') return null;
    const n = Number(raw);
    return Number.isInteger(n) && n > 0 && n <= 65535 ? n : null;
}

function envHost(env: NodeJS.ProcessEnv): string | null {
    const raw = env['DIY_PING_HOST'];
    return raw === undefined || raw.trim() === '' ? null : raw.trim();
}

/** 监听地址的人读提示：绑非回环时提醒一次「无鉴权」 */
export function bindHint(host: string): string | null {
    return host === '127.0.0.1' || host === '::1' || host === 'localhost'
        ? null
        : `[remote] /ping 绑在 ${host}（非回环），当前无鉴权 —— 仅限内网 / 私有网格（tailscale 等），绝不要暴露公网`;
}

export async function startPingServer(opts: PingServerOptions): Promise<PingServerHandle> {
    const env = process.env;
    const host = opts.host ?? envHost(env) ?? '127.0.0.1';
    const requested = opts.port ?? envPort(env) ?? PING_DEFAULT_PORT;
    // 显式给了端口（opts / 环境变量）就不顺延 —— 那是用户点名要的端口，换掉等于骗他；
    // 缺省端口被占才顺延（同机多实例各自找一个空位）。
    const fallbackPorts = opts.fallbackPorts ?? (opts.port !== undefined || envPort(env) !== null ? 1 : 10);
    const startedMs = (opts.startedAt ?? new Date()).getTime();
    const pid = opts.pid ?? process.pid;

    const hint = bindHint(host);
    if (hint !== null) console.warn(hint);

    const makeInfo = (): PingInfo => ({
        id: opts.identity.id,
        displayName: opts.identity.displayName,
        // ##484：地址里那段 app（`diy-chat` / `video` / …）—— 只有 variant 分不清并存的多个 app
        app: opts.identity.app,
        variant: opts.variant,
        version: opts.version,
        pid,
        startedAt: new Date(startedMs).toISOString(),
        uptimeMs: Math.max(0, Date.now() - startedMs),
    });

    const server = createServer((req, res) => handlePing(req, res, makeInfo));

    const port = await listenWithFallback(server, host, requested, fallbackPorts);
    return {
        host,
        port,
        baseUrl: `http://${host}:${port}`,
        info: makeInfo,
        close: () =>
            new Promise<void>((resolve) => {
                server.close(() => resolve());
                server.closeAllConnections?.();
            }),
    };
}

function handlePing(req: IncomingMessage, res: ServerResponse, info: () => PingInfo): void {
    const path = (req.url ?? '/').split('?')[0] ?? '/';
    if (path !== PING_PATH) {
        res.writeHead(404, { 'content-type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ error: 'not-found', hint: `只有 ${PING_PATH}` }));
        return;
    }
    if (req.method !== 'GET' && req.method !== 'HEAD') {
        res.writeHead(405, { 'content-type': 'application/json; charset=utf-8', allow: 'GET, HEAD' });
        res.end(JSON.stringify({ error: 'method-not-allowed' }));
        return;
    }
    const body = JSON.stringify(info());
    res.writeHead(200, {
        'content-type': 'application/json; charset=utf-8',
        'content-length': Buffer.byteLength(body),
        'cache-control': 'no-store',
    });
    res.end(req.method === 'HEAD' ? undefined : body);
}

/** 顺序试端口：EADDRINUSE 才顺延，其它错误直接抛（不掩盖真问题） */
function listenWithFallback(server: Server, host: string, startPort: number, tries: number): Promise<number> {
    return new Promise<number>((resolve, reject) => {
        let attempt = 0;
        const tryListen = (port: number) => {
            attempt += 1;
            const onError = (err: NodeJS.ErrnoException) => {
                if (err.code === 'EADDRINUSE' && attempt < tries) {
                    tryListen(port + 1);
                    return;
                }
                reject(err);
            };
            server.once('error', onError);
            server.listen(port, host, () => {
                server.off('error', onError);
                const addr = server.address();
                resolve(typeof addr === 'object' && addr !== null ? (addr as AddressInfo).port : port);
            });
        };
        tryListen(startPort);
    });
}

/** 本机 hostname（发现器展示用；id 绝不取它，见 identity.ts） */
export function localHostname(): string {
    try {
        return hostname();
    } catch {
        return '';
    }
}

// `GET /ping` 客户端：探活 + 取身份。
//
// 判据：**失败一律返回结果对象，不抛** —— 发现链里一台机器连不上是常态（关机 / 不在同一网络），
// 不能让它把整次发现打断。调用方（CLI）需要人读错误时看 `error`。

import { request } from 'node:http';
import { PING_PATH, type PingInfo } from '../types.js';

export interface PingResult {
    ok: boolean;
    info: PingInfo | null;
    /** 失败原因（人读一句话；成功时为 null） */
    error: string | null;
    /** 实际耗时（毫秒） */
    elapsedMs: number;
}

/** 宽松校验：字段类型不对就当「不是 diy 的 /ping」（防止把别人的 200 HTML/JSON 当实例） */
export function parsePingInfo(raw: unknown): PingInfo | null {
    if (typeof raw !== 'object' || raw === null) return null;
    const o = raw as Record<string, unknown>;
    const str = (v: unknown): v is string => typeof v === 'string' && v !== '';
    const num = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
    if (!str(o['id']) || !str(o['displayName'])) return null;
    if (!str(o['variant']) || !str(o['version']) || !str(o['startedAt'])) return null;
    if (!num(o['pid']) || !num(o['uptimeMs'])) return null;
    return {
        id: o['id'],
        displayName: o['displayName'],
        // 老实例（##484 之前）没有 app 字段：给空串而不是整条作废 —— 身份仍然可用，地址里那段留空
        app: str(o['app']) ? o['app'] : '',
        variant: o['variant'],
        version: o['version'],
        pid: o['pid'],
        startedAt: o['startedAt'],
        uptimeMs: o['uptimeMs'],
    };
}

/** 打一个 endpoint 的 /ping（endpoint 形如 `http://host:9400`，末尾斜杠无所谓） */
export async function fetchPing(endpoint: string, timeoutMs = 1500): Promise<PingResult> {
    const started = Date.now();
    const base = endpoint.replace(/\/+$/, '');
    let url: URL;
    try {
        url = new URL(`${base}${PING_PATH}`);
    } catch {
        return { ok: false, info: null, error: `endpoint 不合法：${endpoint}`, elapsedMs: 0 };
    }
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
        return { ok: false, info: null, error: `只支持 http(s)：${endpoint}`, elapsedMs: 0 };
    }

    return new Promise<PingResult>((resolve) => {
        let settled = false;
        const finish = (result: Omit<PingResult, 'elapsedMs'>) => {
            if (settled) return;
            settled = true;
            resolve({ ...result, elapsedMs: Date.now() - started });
        };
        const req = request(
            {
                protocol: url.protocol,
                hostname: url.hostname,
                port: url.port === '' ? undefined : Number(url.port),
                path: `${url.pathname}${url.search}`,
                method: 'GET',
                headers: { accept: 'application/json' },
                timeout: timeoutMs,
                // **禁用连接复用**（agent:false）：Node 19+ 的全局 agent 默认 keep-alive，
                // 而探测目标是「同一端口上可能已经换了一个实例」—— 复用到旧套接字会读成 ECONNRESET，
                // 把「实例重启后仍活着」误报成连不上。探测是低频一次性请求，长连接没有任何收益。
                agent: false,
            },
            (res) => {
                const chunks: Buffer[] = [];
                let size = 0;
                res.on('data', (chunk: Buffer) => {
                    size += chunk.length;
                    if (size > 64 * 1024) {
                        req.destroy(new Error('响应过大（>64KB）：不像是 /ping'));
                        return;
                    }
                    chunks.push(chunk);
                });
                res.on('end', () => {
                    if (res.statusCode !== 200) {
                        finish({ ok: false, info: null, error: `HTTP ${res.statusCode ?? '?'}` });
                        return;
                    }
                    let parsed: unknown;
                    try {
                        parsed = JSON.parse(Buffer.concat(chunks).toString('utf-8'));
                    } catch {
                        finish({ ok: false, info: null, error: '响应不是 JSON' });
                        return;
                    }
                    const info = parsePingInfo(parsed);
                    finish(
                        info === null
                            ? { ok: false, info: null, error: '响应不是 diy /ping 契约（字段缺失）' }
                            : { ok: true, info, error: null },
                    );
                });
                res.on('error', (e: Error) => finish({ ok: false, info: null, error: e.message }));
            },
        );
        req.on('timeout', () => {
            req.destroy(new Error(`超时（${timeoutMs}ms）`));
        });
        req.on('error', (e: Error) => {
            finish({ ok: false, info: null, error: e.message });
        });
        req.end();
    });
}

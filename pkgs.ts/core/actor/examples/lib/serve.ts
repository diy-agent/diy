// serve.ts — 双端接线：`serveActor`（服务端一个函数）+ `connectActor`（调用方一个函数）。
//
// 这就是「像 rpc 那样的示范」：`defineKind` 是契约，`serveActor` 是 bind，`connectActor` 是 use。
// 差别在于 actor 的契约比 rpc 多两样东西：**状态**（state schema）和**事件**（events 封闭集合），
// 所以服务端只要给 kind + 数据目录就能起，不用把每个方法再绑一次。
//
// 分层照旧：本文件只做「谁连谁」；帧的搬运在 net-link.ts；语义全在 src/。

import { rm } from 'node:fs/promises';

import {
    ActorClient,
    createActor,
    createClient,
    type ActorStore,
    type FanoutPort,
    type Kind,
} from '../../src/index.js';

import { dialSocket, listenSocket, type Listening } from './net-link.js';
import { openJsonlStore } from './store-jsonl.js';
import path from 'node:path';
import { z } from 'zod';

export interface ServeActorOptions<K extends Kind> {
    readonly kind: K;
    /** actor 地址（进日志与扇出回执，不参与寻址） */
    readonly uri: string;
    /** unix socket 路径 */
    readonly socket: string;
    /** 落盘目录（不给 = 内存 store，进程一死全没） */
    readonly dataDir?: string;
    /** 扇出端口（不注入时，声明了 `fanoutQuery` 的查询回 `err E_UNAVAILABLE`） */
    readonly port?: FanoutPort;
    readonly onLog?: (event: { level: 'warn' | 'error'; message: string; error?: unknown }) => void;
}

export interface ServedActor<K extends Kind> {
    readonly uri: string;
    readonly socket: string;
    readonly actor: ReturnType<typeof createActor<K>>;
    readonly store?: ActorStore<z.output<K['state']>>;
    close(): Promise<void>;
}

/** 起一个 actor：加载快照 → 听 socket → 每条连接一条链路 */
export async function serveActor<K extends Kind>(opts: ServeActorOptions<K>): Promise<ServedActor<K>> {
    const store = opts.dataDir
        ? await openJsonlStore<z.output<K['state']>>({
              dir: opts.dataDir,
              onWarn: (m) => opts.onLog?.({ level: 'warn', message: m }),
          })
        : undefined;

    const actor = createActor({ kind: opts.kind, uri: opts.uri, store, port: opts.port, onLog: opts.onLog });
    await actor.start();

    // 上一个进程被 kill -9 会留下 socket 文件（EADDRINUSE），先清掉
    await rm(opts.socket, { force: true });
    let listening: Listening | undefined;
    listening = await listenSocket({
        path: opts.socket,
        onLink: (link) => actor.attach(link),
        onError: (err) => opts.onLog?.({ level: 'warn', message: `链路错误：${err.message}`, error: err }),
    });

    return {
        uri: opts.uri,
        socket: opts.socket,
        actor,
        store,
        async close() {
            await listening?.close();
            await actor.close();
            await store?.close();
        },
    };
}

export interface DialedClient<K extends Kind> extends ActorClient<K> {
    close(): void;
}

/** 连一个 actor（调用方侧）。`timeoutMs` 是单请求超时，不是连接超时 */
export async function connectActor<K extends Kind>(opts: {
    readonly kind: K;
    readonly socket: string;
    readonly timeoutMs?: number;
}): Promise<DialedClient<K>> {
    const link = await dialSocket(opts.socket);
    const client = createClient({ link, kind: opts.kind, timeoutMs: opts.timeoutMs }) as DialedClient<K>;
    client.close = () => link.close();
    return client;
}

/**
 * 扇出端口：`target` 形如 `unix:/tmp/x/peer-a.sock`。
 *
 * 摆放（哪个成员在哪台机器）**只在 kind 的 state 里**，这里只负责「按地址拨号」。
 * 每次拨一条新连接（示范够用；生产该做连接池，见 docs/09-example.md「留给你的作业」）。
 */
export function createSocketPort(opts: { timeoutMs?: number } = {}): FanoutPort & { close(): Promise<void> } {
    return {
        async query({ target, name, data }) {
            const socketPath = parseTarget(target);
            const link = await dialSocket(socketPath, { timeoutMs: opts.timeoutMs });
            try {
                // client 只需要一条链路就能发帧；kind 只用于静态类型，这里走 rawQuery
                const client = createClient({ link, kind: undefined as unknown as Kind, timeoutMs: opts.timeoutMs });
                const outcome = await client.rawQuery(name, data, { timeoutMs: opts.timeoutMs });
                if (!outcome.ok) {
                    throw Object.assign(new Error(outcome.message), { code: outcome.code });
                }
                return outcome.data;
            } finally {
                link.close();
            }
        },
        async close() {
            // 每条 query 自己关链路，端口本身没有资源（保持接口对称）
        },
    };
}

/** `unix:/path/to.sock` → `/path/to.sock`（协议不规定地址形态，这里只示范一种） */
export function parseTarget(target: string): string {
    const prefix = 'unix:';
    if (!target.startsWith(prefix)) {
        throw Object.assign(new Error(`不认识的 target：${target}（本示范只认 ${prefix}<path>`), {
            code: 'E_NOT_FOUND',
        });
    }
    return target.slice(prefix.length);
}

/** target 的构造侧（和 parseTarget 一对；写死在剧本里容易拼错） */
export function unixTarget(socketPath: string): string {
    return `unix:${path.resolve(socketPath)}`;
}

/** 等一个 socket 起来（子进程启动是异步的；拨通一次就算好了） */
export async function waitForSocket(socket: string, timeoutMs = 10_000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
        try {
            const link = await dialSocket(socket, { timeoutMs: 500 });
            link.close();
            return;
        } catch (err) {
            if (Date.now() > deadline) throw err;
            await new Promise((resolve) => setTimeout(resolve, 50));
        }
    }
}

// gateway.ts — 浏览器侧的连接层：一条 WebSocket → ChannelClientBinding → 强类型 client
//               → chat-page 认的 `WorkbenchGateway`（页面代码一行不改）。
//
// 三段，全是 @diy-agent/rpc 的现成部件，本文件只做「浏览器缺的那一小块」：
//   ① 把浏览器原生 WebSocket 包成 WsTransport 要的 WsLike（浏览器是 addEventListener，
//      WsTransport 吃的是 node 风格的 `on(event, cb)`；协议本身一字不差）；
//   ② `new ChannelClientBinding(tx)` —— 信封协议客户端（与 electron IPC 同一套）；
//   ③ `createTypedClient(binding, webApi)` —— schema 推出来的强类型方法（zod 每次校验入参）。
//
// ⚠️ 铁律②（revoke 后不自动重试）在这里落地：`invoke` 只发**一次**，UNAUTHENTICATED 直接往上抛，
// 由 renderer 切回「未连接」。本文件不含任何重连 / 重试 / 续签逻辑 —— 加了就等于绕过副方。

import { ChannelClientBinding, createTypedClient, RpcError, type TypedClient } from '@diy-agent/rpc';
import { WsTransport } from '@diy-agent/rpc/ws';
import type { PageInfo, WorkbenchGateway } from '@diy-agent/workbench-ui';
import { webApi } from './api.js';

/** 一条已建立的连接 */
export interface WebConnection {
    /** 强类型 RPC 客户端（授权 + 页面方法都在上面） */
    readonly client: TypedClient<typeof webApi>;
    /** 工作台骨架要的那座桥（listPages / invoke） */
    readonly gateway: WorkbenchGateway;
    /** 连接掉了（socket 关闭 / 服务端重启）时回调；**不重连** */
    onClose(callback: () => void): void;
    close(): void;
}

/** UNAUTHENTICATED = 未授权 / 已 revoke / token 过期。HTTP 绑定下它就是 401 */
export function isUnauthenticated(error: unknown): boolean {
    return error instanceof RpcError && error.code === 'UNAUTHENTICATED';
}

/** WsTransport 要的最小 WsLike：浏览器 WebSocket 只有 addEventListener，这里补成 on() */
function browserSocketLike(socket: WebSocket): {
    send(data: string): void;
    close(): void;
    on(event: string, callback: (...args: never[]) => void): void;
} {
    return {
        send: (data: string) => socket.send(data),
        close: () => socket.close(),
        on(event: string, callback: (...args: never[]) => void): void {
            if (event === 'message') {
                socket.addEventListener('message', (message) => {
                    // WsTransport 只对 data 调 toString()，字符串原样传即可
                    (callback as unknown as (data: string, isBinary: boolean) => void)(message.data as string, false);
                });
                return;
            }
            if (event === 'close') {
                socket.addEventListener('close', () => (callback as unknown as () => void)());
                return;
            }
            socket.addEventListener('error', () =>
                (callback as unknown as (err: unknown) => void)(new Error('socket')),
            );
        },
    };
}

/** 连上（socket open 即返回；授权状态由 web.auth.* 决定） */
export async function connectWeb(url: string): Promise<WebConnection> {
    const socket = new WebSocket(url);
    await new Promise<void>((done, fail) => {
        socket.addEventListener('open', () => done(), { once: true });
        socket.addEventListener('error', () => fail(new Error(`连不上 ${url}`)), { once: true });
    });

    const binding = new ChannelClientBinding(new WsTransport(browserSocketLike(socket)));
    const client = createTypedClient(binding, webApi);
    const closeHandlers = new Set<() => void>();
    socket.addEventListener('close', () => {
        for (const handler of closeHandlers) handler();
    });

    const gateway: WorkbenchGateway = {
        listPages: async (): Promise<readonly PageInfo[]> => client.web.page.list({}),
        invoke: (pageId: string, method: string, args?: unknown): Promise<unknown> =>
            // 一次就是一次：不重试、不重连（铁律②）
            client.web.page.invoke({ pageId, method, args }),
    };

    return {
        client,
        gateway,
        onClose(callback: () => void): void {
            closeHandlers.add(callback);
        },
        close(): void {
            closeHandlers.clear();
            binding.dispose();
            socket.close();
        },
    };
}

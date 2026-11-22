// instance-streams.ts —— 读一个实例的 RPC 订阅（实例页明细用）。
//
// 连接是**短命**的：开 WS → 调 `streams()` → 关。它自己也会出现在结果里（刚建、还没订房间），
// 所以过滤掉 `rooms` 为空的条目 —— 剩下的才是「真正在看东西」的连接。
//
// 目前只有 diy2 有 `/rpc`；别的实例（diy-app serve 的 h2c）连不上，返回 error 由 UI 显示。

import { ChannelClientBinding } from "@diy-agent/rpc";
import { WsTransport } from "@diy-agent/rpc/ws";
import { WebSocket } from "ws";

import type { InstanceStream } from "../../shared/instance-row";

const TIMEOUT_MS = 800;

function withTimeout<T>(promise: Promise<T>, ms: number, what: string): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${what} 超时（${ms}ms）`)), ms);
    });
    return Promise.race([promise, timeout]).finally(() => {
        if (timer !== undefined) clearTimeout(timer);
    }) as Promise<T>;
}

export interface StreamsResult {
    streams: InstanceStream[];
    error: string | null;
}

/**
 * 连上去读一次订阅快照。
 *
 * 失败不抛：实例页是**只读观测**，一个实例连不上不该把整页弄红 —— 行里显示 error 就够。
 */
export async function rpcStreamsOf(port: number, timeoutMs: number = TIMEOUT_MS): Promise<StreamsResult> {
    const socket = new WebSocket(`ws://127.0.0.1:${port}/rpc`);
    try {
        await withTimeout(
            new Promise<void>((resolve, reject) => {
                socket.once("open", () => resolve());
                socket.once("error", (error: Error) => reject(error));
            }),
            timeoutMs,
            "连接 /rpc",
        );

        const binding = new ChannelClientBinding(new WsTransport(socket));
        const all = await withTimeout(
            binding.invoke<unknown, InstanceStream[]>("streams", { input: {} }),
            timeoutMs,
            "读 streams",
        );
        return { streams: all.filter((stream) => stream.rooms.length > 0), error: null };
    } catch (error) {
        return { streams: [], error: error instanceof Error ? error.message : String(error) };
    } finally {
        try {
            socket.close();
        } catch {
            /* 已断开 */
        }
    }
}

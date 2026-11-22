/**
 * instance-streams.test.ts —— 实例页的「事件流订阅」读数。
 *
 * 两件事：把 `streams()` 里空房间的探测连接滤掉；连不上时给 error 而不是抛。
 * 用真 ws 服务端 + 真 rpc 绑定（不 mock 传输层）。
 */
import { WebSocketServer } from "ws";
import { z } from "zod";
import { describe, expect, it } from "vitest";

import { ChannelServerBinding, RpcSchema } from "@diy-agent/rpc";
import { WsTransport } from "@diy-agent/rpc/ws";

import { rpcStreamsOf } from "../src/main/services/instance-streams";

const api = RpcSchema.group({ children: { streams: RpcSchema.unary({ input: {}, output: z.unknown() }) } });

async function fakeDiy2(rows: unknown[]): Promise<{ port: number; close: () => Promise<void> }> {
    const wss = new WebSocketServer({ port: 0 });
    await new Promise<void>((resolve) => wss.once("listening", () => resolve()));
    const address = wss.address();
    if (address === null || typeof address === "string") throw new Error("没有端口");

    wss.on("connection", (socket) => {
        const binding = new ChannelServerBinding(new WsTransport(socket));
        binding._on("streams", api.streams, async () => rows);
    });

    return {
        port: address.port,
        close: async () => {
            for (const client of wss.clients) client.terminate();
            await new Promise<void>((resolve) => wss.close(() => resolve()));
        },
    };
}

describe("rpcStreamsOf", () => {
    it("读到订阅；过滤掉「还没订任何房间」的探测连接", async () => {
        const server = await fakeDiy2([
            { conn: "ws-1", rooms: ["task:a", "proj:diy"], since: 1 },
            { conn: "ws-9", rooms: [], since: 2 },
        ]);
        try {
            const result = await rpcStreamsOf(server.port, 1_000);
            expect(result).toEqual({
                streams: [{ conn: "ws-1", rooms: ["task:a", "proj:diy"], since: 1 }],
                error: null,
            });
        } finally {
            await server.close();
        }
    });

    it("端口没人听：返回 error，不抛（只读观测不该把整页弄红）", async () => {
        // 先占一个端口再放掉，确保确实没人听
        const probe = new WebSocketServer({ port: 0 });
        await new Promise<void>((resolve) => probe.once("listening", () => resolve()));
        const address = probe.address();
        if (address === null || typeof address === "string") throw new Error("没有端口");
        await new Promise<void>((resolve) => probe.close(() => resolve()));

        const result = await rpcStreamsOf(address.port, 500);
        expect(result.streams).toEqual([]);
        expect(result.error).not.toBeNull();
    });
});

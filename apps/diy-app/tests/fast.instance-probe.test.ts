/**
 * fast.instance-probe.test.ts — 实例探活的**方法名**锁
 *
 * 为什么值得一条独立测试：`fetchAppInfo` 里写的是**线上字符串**（`diy.app.info`），
 * tsc 看不见。2026-11 把顶层 `getAppInfo` 并进 `app.info` 时这里漏改，于是：
 * app 明明起来了，CLI 却认不出「这个端口是我的实例」→ 空转 30s 报「启动超时」，
 * 顺手把刚起的实例杀掉，最后还误报「单实例锁被占用」。
 *
 * 这里用一个只认 `/diy.app.info` 的桩服务端：客户端要是换了方法名（或拼错），
 * 断言直接红，而不是等到用户启动不了。
 */
import { createServer, type Http2Server, type ServerHttp2Stream } from "node:http2";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { fetchAppInfo } from "../src/main/services/instance-probe";

let server: Http2Server;
let port = 0;
const paths: string[] = [];

beforeAll(async () => {
    server = createServer();
    server.on("stream", (stream: ServerHttp2Stream, headers) => {
        paths.push(String(headers[":path"] ?? ""));
        stream.respond({ ":status": 200, "content-type": "application/json" });
        stream.end(JSON.stringify({ result: { diyHome: "/tmp/probe-home", pid: 4242, env: "test" } }));
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    port = (server.address() as AddressInfo).port;
});

afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
});

describe("fetchAppInfo", () => {
    it("走 diy.app.info（与 apiDef 的 app 域同一条），解出身份字段", async () => {
        const info = await fetchAppInfo(port, 2000);
        expect(info).toMatchObject({ diyHome: "/tmp/probe-home", pid: 4242, env: "test" });
        expect(paths).toContain("/diy.app.info");
    });
});

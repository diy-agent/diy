// server/index.ts —— **生产入口**（也是 `bin/diy2` 拉起的那个产物）。
//
// 只做编排，不含领域逻辑、不含路由：
//   读配置（唯一真源 ./config） → 装配（./app） → 监听 127.0.0.1 → 落 app.port（下次沿用的端口）
//   + 注册表 → 优雅退出。
//
// 「import 即 listen」在这里是**有意**的：这个文件就是可执行入口（node build/prod/server/index.mjs
// / bin/diy2 的 import），而装配逻辑已经从模块顶层搬进 createDiy2App —— 想复用 handler 的
// 调用方（dev）用 ./app，不需要也不应该 import 本文件。

import { createServer } from 'node:http';

import { createDiy2App } from './app';
import { describeConfig, modelConfigHint, resolveConfig } from './config';
import { announce, retract } from './registry';
import { probe } from './probe';
import { listenWithStickyPort } from './listen';

const config = resolveConfig({ moduleDir: import.meta.dirname });
// entity-runtime 读 model.yaml 的路径（懒读：只在真发请求时用，所以此处设置即生效）
if (config.modelConfigPath !== undefined) process.env['DIY_MODEL_CONFIG'] ??= config.modelConfigPath;
const hint = modelConfigHint(config);
if (hint !== null) console.warn(hint);

const app = createDiy2App({
    config,
    port: () => {
        const address = server.address();
        return typeof address === 'object' && address !== null ? address.port : null;
    },
});

// 只绑本机：这个进程带着 read/write/edit/bash 工具，监听 0.0.0.0 等于把任意命令执行面
// 暴露给整个局域网（而且没有鉴权）。要远程用请走 SSH 隧道。
const server = createServer(app.handle);

/** 同一数据根已有实例在跑 → 不再起第二个（同一份 sqlite 双写） */
async function alreadyRunning(): Promise<number | null> {
    // 候选地址 = `app.port` 记录（上次用的那个）+ 本次裁决的端口。
    // 记录**不是**存活证据，只决定「先往哪儿看」；身份由 /api/info 自报的 home 判。
    // 生产尤其靠它：监听端口固定 5192，不从记录里取，但实例可能正跑在 `--port 5300` 上——
    // 只看 5192 就会当没人，第二个进程起来双写同一份 sqlite。
    const candidates = [...new Set([config.recordedPort, config.port])].filter(
        (port): port is number => port !== null && port !== 0,
    );
    for (const port of candidates) {
        const result = await probe(port, config.home);
        if (result.kind === 'mine') return port;
        if (result.kind === 'other') {
            console.error(`[diy2] 端口 ${port} 被**另一个数据根**的实例占着（home=${result.info?.home}）`);
            console.error('[diy2] 换端口：diy2 -p 0（或 diy2 --port <n>），或先 diy2 stop');
            process.exit(1);
        }
    }
    return null;
}

const fatal = (error: Error): never => {
    console.error(`[diy2] 启动失败：${error.message}`);
    process.exit(1);
};

const reused = await alreadyRunning();
if (reused !== null) {
    console.log(`[diy2] 这个数据根已有实例在监听 http://127.0.0.1:${reused}（home=${config.home}）`);
    console.log('[diy2] 要重启：先 `diy2 stop`（或加 --restart），不要直接起第二个进程');
    process.exit(0);
}

// 启动期错误由这里接（而不是 `server.on('error')`）：监听要能**重试**（开发侧端口被占时
// 回落到内核分配，见 ./listen），而常驻 error 监听器会在第一次 EADDRINUSE 时就把进程抬走。
function badStartup(error: NodeJS.ErrnoException): never {
    if (error.code === 'EADDRINUSE') {
        console.error(`[diy2] 端口 ${config.port} 已被占用（own home=${config.home}）`);
        console.error('[diy2] 换端口：DIY2_PORT=0（内核分配）/ --port <n>；或先 diy2 stop');
        process.exit(1);
    }
    return fatal(error);
}

const { port } = await listenWithStickyPort(config, server).catch(badStartup);

// 监听成功之后的运行期错误：没有恢复手段，直提失败
server.on('error', (error: NodeJS.ErrnoException) => fatal(error));

console.log(`${describeConfig(config, port)} → http://127.0.0.1:${port}`);
if (config.webDir !== undefined) console.log(`[diy2] UI: ${config.webDir}`);
else console.log('[diy2] 未找到 UI 产物（只提供 /api）—— 开发请用 `./sha.sh dev`');

// 实例自报（dev 启动器 / workbench / remote 靠它看见本实例）
announce(config, port);

const shutdown = (signal: string): void => {
    console.log(`[diy2] ${signal} → 关闭`);
    // 刻意**不删** app.port：它记的是「下次用哪个端口」，删了下次就换成内核随机端口。
    app.close();
    retract();
    server.close(() => process.exit(0));
    // 长连接（SSE）可能挂住 close 回调：兜底硬退
    setTimeout(() => process.exit(0), 1500).unref();
};

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

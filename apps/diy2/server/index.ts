// server/index.ts —— **生产入口**（也是 `bin/diy2` 拉起的那个产物）。
//
// 只做编排，不含领域逻辑、不含路由：
//   读配置（唯一真源 ./config） → 装配（./app） → 监听 127.0.0.1 → 落 app.port + 注册表 → 优雅退出。
//
// 「import 即 listen」在这里是**有意**的：这个文件就是可执行入口（node build/prod/server/index.mjs
// / bin/diy2 的 import），而装配逻辑已经从模块顶层搬进 createDiy2App —— 想复用 handler 的
// 调用方（dev）用 ./app，不需要也不应该 import 本文件。

import { createServer } from 'node:http';

import { createDiy2App } from './app';
import { describeConfig, modelConfigHint, removePortFile, resolveConfig, writePortFile } from './config';
import { announce, retract } from './registry';
import { probe } from './probe';

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
    const recorded = config.port === 0 ? null : config.port;
    if (recorded === null) return null;
    const result = await probe(recorded, config.home);
    if (result.kind === 'mine') return recorded;
    if (result.kind === 'other') {
        console.error(`[diy2] 端口 ${recorded} 被**另一个数据根**的实例占着（home=${result.info?.home}）`);
        console.error('[diy2] 换端口：diy2 -p 0（或 diy2 --port <n>），或先 diy2 stop');
        process.exit(1);
    }
    return null;
}

const fatal = (error: Error): never => {
    console.error(`[diy2] 启动失败：${error.message}`);
    process.exit(1);
};

server.on('error', (error: NodeJS.ErrnoException) => {
    if (error.code === 'EADDRINUSE') {
        console.error(`[diy2] 端口 ${config.port} 已被占用（own home=${config.home}）`);
        console.error('[diy2] 换端口：DIY2_PORT=0（内核分配）/ --port <n>；或先 diy2 stop');
        process.exit(1);
    }
    fatal(error);
});

const reused = await alreadyRunning();
if (reused !== null) {
    console.log(`[diy2] 这个数据根已有实例在监听 http://127.0.0.1:${reused}（home=${config.home}）`);
    console.log('[diy2] 要重启：先 `diy2 stop`（或加 --restart），不要直接起第二个进程');
    process.exit(0);
}

server.listen(config.port, '127.0.0.1', () => {
    const address = server.address();
    const port = typeof address === 'object' && address !== null ? address.port : config.port;
    writePortFile(config.portFile, port);
    console.log(`${describeConfig(config)} → http://127.0.0.1:${port}`);
    if (config.webDir !== undefined) console.log(`[diy2] UI: ${config.webDir}`);
    else console.log('[diy2] 未找到 UI 产物（只提供 /api）—— 开发请用 `./sha.sh dev`');

    // 实例自报（dev 启动器 / workbench / remote 靠它看见本实例）
    announce(config, port);
});

const shutdown = (signal: string): void => {
    console.log(`[diy2] ${signal} → 关闭`);
    app.close();
    removePortFile(config.portFile);
    retract();
    server.close(() => process.exit(0));
    // 长连接（SSE）可能挂住 close 回调：兜底硬退
    setTimeout(() => process.exit(0), 1500).unref();
};

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

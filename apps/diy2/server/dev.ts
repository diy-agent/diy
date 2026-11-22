// server/dev.ts —— **单端口**开发入口：vite 以 middleware 方式挂进 diy2 自己的 HTTP server。
//
// 为什么不再「vite 一个端口 + API 一个端口 + /api 代理」（##dev-app 构建对齐）：
//   · dev 与 prod 的拓扑不一致 —— prod 一个进程一个地址，dev 两个端口加代理，
//     于是「哪个是入口 URL」每次都要问人，`/api` 的 SSE 还要穿过代理（缓冲 / 断连坑）；
//   · 端口要两处硬编码（vite `--port`、代理目标），改一处就静默连错；
//   · 两个进程两套日志两份 pid，`stop` 只能按端口杀（会误杀长连接的客户端）。
// 现在：一个端口、同源、无代理；UI 走 vite transform（HMR 仍由 vite 的 WS 提供，
// 复用同一个 HTTP server 的 upgrade 通道），/api 走同一个进程内的 handler。
//
// 退出码：75 = 「服务端代码变了，请重启我」（sha.sh dev 的看护循环据此重起）；
// 0 / 其他 = 正常退出 / 真失败，由看护循环原样透传。

import { createServer } from 'node:http';
import { watch } from 'node:fs';
import { join } from 'node:path';

import { createServer as createViteServer } from 'vite';

import { describeConfig, isProdHome, modelConfigHint, resolveConfig } from './config';
import { announce, retract } from './registry';
import { createDiy2App } from './app';
import { listenWithStickyPort } from './listen';

/** 看护循环约定的「请重启」退出码（`sysexits.h` 的 EX_TEMPFAIL） */
export const RESTART_CODE = 75;

const config = resolveConfig({ moduleDir: import.meta.dirname });

// dev 入口**不碰生产数据根**：DIY2_ENV 泄漏成 production（外层 shell / agent 常这么干）时，
// 数据根会按生产解析成 ~/.diy/diy2 —— 一次实验就写脏真库。宁可停下来说清楚。
if (isProdHome(config.home) && process.env['DIY2_ALLOW_PROD_HOME'] !== '1') {
    console.error(`[diy2] dev 入口拒绝使用生产数据根：${config.home}`);
    console.error('[diy2] 结构上是对的（DIY2_ENV 泄漏成 production 才会这样）→ 请用 `./sha.sh dev`');
    console.error('[diy2] 真要用它：DIY2_ALLOW_PROD_HOME=1');
    process.exit(1);
}
if (config.modelConfigPath !== undefined) process.env['DIY_MODEL_CONFIG'] ??= config.modelConfigPath;
const hint = modelConfigHint(config);
if (hint !== null) console.warn(hint);

const httpServer = createServer();
const app = createDiy2App({
    config,
    // dev 的页面来自 vite，不来自 build/<variant>/web（null = 明确不要，不是「按配置来」）
    webDir: null,
    port: () => {
        const address = httpServer.address();
        return typeof address === 'object' && address !== null ? address.port : null;
    },
});

const vite = await createViteServer({
    root: config.appRoot,
    appType: 'spa',
    server: {
        middlewareMode: true,
        // HMR 的 WebSocket 复用本 server 的 upgrade 通道（否则 vite 会另开 24678，
        // 多 worktree 并存时又变成「谁先起谁得」）
        ws: { server: httpServer },
    },
});

httpServer.on('request', (req, res) => {
    const pathname = (req.url ?? '/').split('?')[0] ?? '/';
    if (pathname === '/api' || pathname.startsWith('/api/')) {
        app.handle(req, res);
        return;
    }
    vite.middlewares(req, res, () => {
        res.statusCode = 404;
        res.end('not found');
    });
});

// `/rpc` 的 WS：与 vite 的 HMR 共用 upgrade 通道（不是 `/rpc` 的一律不碰，留给 vite）
httpServer.on('upgrade', (req, socket, head) => {
    app.handleUpgrade(req, socket, head);
});

// 端口粘性（`<home>/app.port`）：改服务端代码 → exit 75 → 看护循环重起；那边**不删**这个文件，
// 于是重启后还是同一个 URL —— 浏览器那边只是 HMR ws 断了重连，不用改书签。
// 被占用时回落到内核分配并重写记录（见 ./listen）；它只是「上次用的端口」，不证明谁在跑。
let port: number;
try {
    ({ port } = await listenWithStickyPort(config, httpServer));
} catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EADDRINUSE') {
        console.error(`[diy2] 端口 ${config.port} 已被占用（显式指定的端口不会自动漂移）`);
        console.error('[diy2] 换端口：--port <n> / DIY2_PORT=0；或先 ./sha.sh stop');
        process.exit(1);
    }
    console.error(`[diy2] 启动失败：${(error as Error).message}`);
    process.exit(1);
}
console.log(`${describeConfig(config, port)} → http://127.0.0.1:${port}`);
console.log('[diy2] UI 走 vite（HMR 同端口）；改 server/ 或 entity-runtime 会自动重启，改 UI 不用');
announce(config, port);

// ── 服务端代码变更 → 请看护循环重启 ──────────────────────────────
// vite 的 HMR 只管浏览器侧模块图；`server/**` 与 `pkgs.ts/**`（工作区包源码）在服务端的
// 实例是普通 node 对象（sqlite 连接、房间聚合），热替换语义不安全 —— 重启进程才是对的。
const watchRoots = [join(config.appRoot, 'server')];
if (config.repoRoot !== null) watchRoots.push(join(config.repoRoot, 'pkgs.ts', 'agent', 'entity-runtime', 'src'));

let timer: NodeJS.Timeout | undefined;
const scheduleRestart = (file: string | null): void => {
    if (file !== null && /\.(d\.ts|tsbuildinfo)$/.test(file)) return;
    if (timer !== undefined) return; // 一次保存会连发多个事件：只认第一次，等它统一重启
    console.log(`[diy2] 服务端代码变了${file === null ? '' : `（${file}）`} → 重启`);
    timer = setTimeout(() => {
        app.close();
        retract();
        void vite.close().finally(() => httpServer.close(() => process.exit(RESTART_CODE)));
        // 长连接（SSE）可能挂住 close 回调：兜底硬退
        setTimeout(() => process.exit(RESTART_CODE), 1500).unref();
    }, 200);
};

for (const root of watchRoots) {
    try {
        watch(root, { recursive: true }, (_event, filename) =>
            scheduleRestart(filename === null ? null : join(root, filename)),
        );
    } catch {
        // 目录不存在（发布形态 / 只装了 UI）：监听不到就不重启，不致命
    }
}

const shutdown = (): void => {
    // 刻意**不删** app.port：重启（看护循环 / Ctrl-C 再起）要还回同一个 URL。
    app.close();
    retract();
    void vite.close().finally(() => httpServer.close(() => process.exit(0)));
    setTimeout(() => process.exit(0), 1500).unref();
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

#!/usr/bin/env node
// main.mjs — apps/web 的启动器（判据 1 的入口）：**不需要 Electron**。
//
//   node apps/web/main.mjs --port 8080 --home /tmp/diy-web
//
// 为什么要先编：server / renderer 是 TS + workspace 包（exports 指 lib/*.js），Node 直接跑不起来。
// 这里按需跑 esbuild 出两个产物到 `build/<variant>/web/`（与 apps/* 既有构建口径一致），
// 再 import 真入口 —— 于是「一条 node 命令就能起」和「源码改了自动重编」两件事同时成立。
//
// 两个产物：
//   server.mjs            服务端（platform=node；@diy-agent/* 走运行时解析 —— 真包边界）
//   renderer/index.js     浏览器 bundle（platform=browser；chat-page 页面原样打进来）
// 依赖前提：能力包的 lib/ 已编（`./sha.sh build-pkgs`）。缺了这里会自动补一次，别去手敲。

import { execFileSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, '../..');

// ── 参数 ────────────────────────────────────────────────────────────
const argv = process.argv.slice(2);
const flag = (name, fallback) => {
    const at = argv.indexOf(`--${name}`);
    if (at < 0) return fallback;
    const value = argv[at + 1];
    if (value === undefined || value.startsWith('--')) return true;
    return value;
};
const has = (name) => argv.includes(`--${name}`);

const variant = String(flag('variant', process.env.DIY_VARIANT ?? 'lab'));
const home = String(flag('home', process.env.DIY_HOME ?? join(REPO, 'build', variant, 'home')));
const port = Number(flag('port', 8080));
const host = String(flag('host', '127.0.0.1'));
const httpRpcPort = Number(flag('http-rpc-port', 0));

const OUT = join(REPO, 'build', variant, 'web');
const STATIC = join(OUT, 'renderer');
const STAMP = join(OUT, '.build-stamp');

// ── 能力包 lib/ 就绪（缺则补编一次）──────────────────────────────────
const REQUIRED_LIBS = [
    'diy-rpc',
    'workbench',
    'ui-workbench',
    'diy-ui',
    'chat-page',
    'diy-agent-session',
    'diy-agent-session-store-jsonl',
    'diy-agent-session-store-memory',
    'diy-llm-provider',
    'diy-agent-model-catalog',
    'diy-agent-bot',
    'diy-remote',
];
const missing = REQUIRED_LIBS.filter((pkg) => !existsSync(join(REPO, 'pkgs.ts', pkg, 'lib', 'index.js')));
if (missing.length > 0) {
    console.log(`[web] 能力包 lib/ 未就绪（${missing.join(', ')}）→ 跑一次 ./sha.sh build-pkgs`);
    execFileSync('bash', [join(REPO, 'sha.sh'), 'build-pkgs'], { stdio: 'inherit', cwd: REPO });
}

// ── 按需构建 ────────────────────────────────────────────────────────
const SOURCES = [
    'api.ts',
    'auth.ts',
    'gateway.ts',
    'handlers.ts',
    'pages.ts',
    'renderer.ts',
    'server.ts',
    'index.html',
];

/** 源码里有比 stamp 更新的文件 ⇒ 需要重编 */
function stale() {
    if (!existsSync(STAMP) || !existsSync(join(OUT, 'server.mjs')) || !existsSync(join(STATIC, 'index.js'))) {
        return true;
    }
    const stamp = statSync(STAMP).mtimeMs;
    return SOURCES.some((name) => {
        const file = join(HERE, name);
        return existsSync(file) && statSync(file).mtimeMs > stamp;
    });
}

async function build() {
    const { build: esbuild } = await import('esbuild');
    mkdirSync(STATIC, { recursive: true });

    await esbuild({
        entryPoints: [join(HERE, 'server.ts')],
        bundle: true,
        platform: 'node',
        format: 'esm',
        target: 'node22',
        outfile: join(OUT, 'server.mjs'),
        // 真包边界：@diy-agent/* 运行时按包名解析（与 apps/chat 的主进程同一口径）
        packages: 'external',
        // 例外：apps/chat 的 sessions.ts 是**源码**（它的 lib/ 要另起 tsc 才能编，且它不是一个能
        // 直接 import 的应用包）—— 这里把源码打进来，避免「起 web 之前得先把 apps/chat 编一遍」。
        alias: { '@diy-agent/app-chat/sessions': join(REPO, 'apps/chat/sessions.ts') },
        logLevel: 'warning',
    });

    await esbuild({
        entryPoints: [join(HERE, 'renderer.ts')],
        bundle: true,
        platform: 'browser',
        format: 'esm',
        target: 'es2022',
        outfile: join(STATIC, 'index.js'),
        logLevel: 'warning',
        // 浏览器入口只许纯核（core 是浏览器安全的）；这里显式挡掉 node 内建，出错就早失败
        banner: { js: '// apps/web renderer（esbuild bundle）' },
    });

    copyFileSync(join(HERE, 'index.html'), join(STATIC, 'index.html'));
    // stamp 取一个「此刻」：用 utimes 避免 writeFileSync + mtime 精度问题
    writeFileSync(STAMP, `${new Date().toISOString()}\n`);
    utimesSync(STAMP, new Date(), new Date());
    console.log(`[web] 已构建 → ${OUT}`);
}

if (has('build') || has('build-only') || stale()) {
    await build();
}
if (has('build-only')) process.exit(0);

// ── 起服务 ──────────────────────────────────────────────────────────
mkdirSync(home, { recursive: true });
process.env.DIY_VARIANT = variant;
process.env.DIY_HOME = home;

const { startWebServer } = await import(pathToFileURL(join(OUT, 'server.mjs')).href);
const handle = await startWebServer({ port, host, home, staticDir: STATIC, variant, httpRpcPort });

console.log(`[web] 已启动：${handle.url}   （数据根 ${home}，变体 ${variant}）`);
console.log(`[web] /ping：${handle.url}/ping`);
if (handle.httpRpcPort !== null) console.log(`[web] h2c RPC：${handle.url.replace(/:\d+$/, `:${handle.httpRpcPort}`)}`);

const stop = async () => {
    await handle.close();
    process.exit(0);
};
process.on('SIGINT', () => void stop());
process.on('SIGTERM', () => void stop());

#!/usr/bin/env node
// scripts/check-migration-gate.mjs —— **产物态**端到端：启动闸门真的走对了吗？
//
// 为什么要它（2026-11-27 事故）：那天迁移卡死的两根因都在**产物态**才出现 ——
// ① `spawn` 的是 `tsx migrate-worker.ts`，而发布产物里既没有 tsx 也没有 .ts；
// ② 前端不等 SSE `onopen` 就 POST start，瞬时错误没人接。
// 这两条在源码态（`./sha.sh dev` / 单测）全绿，`./sha.sh build` 之后才炸。
// 于是把人真正会看到的路径写成可重复的检查：**构建产物 + 真服务 + 真 HTTP**。
//
// 三个场景（数据根用临时目录，不碰任何真实库）：
//   A 老库（文件在、还没跑过迁移）：启动 → mode=migrate（0/18）；迁移态其它 API 一律 503；
//      POST /api/migrate/start → 子进程真跑完 → mode=ready，页面 200
//      —— 用「空文件」而不是「目录里什么都没有」：后者连 readOnly 都打不开（探针按「交给真 app 报错」
//      处理），那是**全新安装**路径，不是闸门要管的老库。
//   B 缺一条记账：mode=migrate，且那一项在 plan 里 recorded=false（真待迁移才拦）
//   C 全齐：mode=ready，页面 200（已迁完的库不许再落迁移页）
//
// 跳过：产物没构建（缺 build/prod/{server,web}）→ 直接说「跳过」，不假装通过。
// 代价：约 6~10 秒（起三次服务 + 跑一次全量迁移）。
import { spawn } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const APP = path.join(ROOT, 'apps/diy2');
const SERVER = path.join(APP, 'build/prod/server/index.mjs');
const WEB = path.join(APP, 'build/prod/web');

if (!existsSync(SERVER) || !existsSync(WEB)) {
    console.log('· 产物未构建（apps/diy2/build/prod），跳过迁移闸门 e2e（./sha.sh build 之后再跑）');
    process.exit(0);
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** 等一个端口空出来：内核分配后立刻释放，保证端口是「刚才没人用」的 */
async function freePort() {
    const net = await import('node:net');
    return await new Promise((resolve, reject) => {
        const server = net.createServer();
        server.once('error', reject);
        server.listen(0, '127.0.0.1', () => {
            const { port } = server.address();
            server.close(() => resolve(port));
        });
    });
}

async function getJson(url, init) {
    const response = await fetch(url, { ...init, signal: AbortSignal.timeout(5000) });
    const text = await response.text();
    let body;
    try {
        body = JSON.parse(text);
    } catch {
        body = text.slice(0, 200);
    }
    return { status: response.status, body };
}

/** 起一个服务并在它「能答 /api/info」之后返回句柄 */
async function startServer(home) {
    const port = await freePort();
    const child = spawn(process.execPath, [SERVER, '--mode', 'development', '--launch', 'staging', '--home', home, '--port', String(port)], {
        cwd: APP,
        stdio: ['ignore', 'pipe', 'pipe'],
        env: { ...process.env, NO_COLOR: '1' },
    });
    let output = '';
    child.stdout.on('data', (chunk) => (output += String(chunk)));
    child.stderr.on('data', (chunk) => (output += String(chunk)));
    const base = `http://127.0.0.1:${String(port)}`;

    const exited = new Promise((resolve) => child.once('exit', (code) => resolve(code)));
    for (let i = 0; i < 120; i++) {
        if (child.exitCode !== null) break;
        try {
            const { status } = await getJson(`${base}/api/info`);
            if (status === 200) return { base, child, exited, output: () => output };
        } catch {
            /* 还没起来 */
        }
        await sleep(250);
    }
    child.kill('SIGKILL');
    throw new Error(`服务没起来（${home}）：\n${output.slice(-1500)}`);
}

async function stopServer(handle) {
    if (handle.child.exitCode === null) handle.child.kill('SIGTERM');
    await Promise.race([handle.exited, sleep(5000)]);
    if (handle.child.exitCode === null) handle.child.kill('SIGKILL');
}

/** 等 mode 变成期望值（迁移是异步子进程，必须轮询） */
async function waitMode(base, want, timeoutMs = 60_000) {
    const deadline = Date.now() + timeoutMs;
    let last;
    while (Date.now() < deadline) {
        const { body } = await getJson(`${base}/api/migrate/state`);
        last = body;
        if (body?.mode === want) return body;
        await sleep(300);
    }
    throw new Error(`等 mode=${want} 超时，最后是 ${JSON.stringify(last).slice(0, 400)}`);
}

const failures = [];
function check(name, ok, detail) {
    if (ok) {
        console.log(`  ✓ ${name}`);
    } else {
        console.log(`  ✗ ${name}${detail === undefined ? '' : ` —— ${detail}`}`);
        failures.push(name);
    }
}

const tmpRoot = mkdtempSync(path.join(tmpdir(), 'diy2-gate-e2e-'));
try {
    // ── A 全空：第一次启动 → 迁移页 → 跑完 → 主界面 ──────────────────────
    console.log('A 老库（有文件、没迁移）：第一次启动');
    const homeA = path.join(tmpRoot, 'a');
    mkdirSync(homeA, { recursive: true });
    new DatabaseSync(path.join(homeA, 'diy2.db')).close(); // 空 SQLite 文件 = 还没跑过任何迁移的老库
    const serverA = await startServer(homeA);
    try {
        const state = await getJson(`${serverA.base}/api/migrate/state`);
        check('老库落迁移页', state.body?.mode === 'migrate', JSON.stringify(state.body).slice(0, 200));
        check('老库版本 0/N', state.body?.version?.applied === 0, JSON.stringify(state.body?.version));
        check(
            '迁移态其它 API 一律 503',
            (await getJson(`${serverA.base}/api/rooms`)).status === 503,
            `got ${String((await getJson(`${serverA.base}/api/rooms`)).status)}`,
        );

        const started = await fetch(`${serverA.base}/api/migrate/start`, { method: 'POST' });
        check('POST start 被接受', started.status === 202, `got ${String(started.status)}`);
        const ready = await waitMode(serverA.base, 'ready');
        check('迁完自动换成真 app', ready.mode === 'ready');
        check('主界面可访问', (await getJson(`${serverA.base}/`)).status === 200);
    } finally {
        await stopServer(serverA);
    }

    const migrated = path.join(homeA, 'diy2.db');
    check('迁移后库文件在', existsSync(migrated));

    // ── C 全齐：已迁完的库不许再落迁移页（这次的病根）────────────────────
    console.log('C 已迁完的库：再启动');
    const homeC = path.join(tmpRoot, 'c');
    cpSync(homeA, homeC, { recursive: true });
    const serverC = await startServer(homeC);
    try {
        const state = await getJson(`${serverC.base}/api/migrate/state`);
        check('已迁完 → 直接 ready', state.body?.mode === 'ready', JSON.stringify(state.body).slice(0, 200));
        check('已迁完 → 页面 200', (await getJson(`${serverC.base}/`)).status === 200);
    } finally {
        await stopServer(serverC);
    }

    // ── B 真缺一条：仍然要拦 ───────────────────────────────────────────────
    console.log('B 删一条记账：真缺迁移');
    const homeB = path.join(tmpRoot, 'b');
    cpSync(homeA, homeB, { recursive: true });
    const raw = new DatabaseSync(path.join(homeB, 'diy2.db'));
    raw.prepare("DELETE FROM schema_migrations WHERE id = 'legacy-journal'").run();
    raw.close();
    const serverB = await startServer(homeB);
    try {
        const state = await getJson(`${serverB.base}/api/migrate/state`);
        check('真缺一条 → 迁移页', state.body?.mode === 'migrate', JSON.stringify(state.body).slice(0, 200));
        const item = (state.body?.plan ?? []).find((entry) => entry.step === 'legacy-journal');
        check('刚删的那条 recorded=false', item?.recorded === false, JSON.stringify(item));
    } finally {
        await stopServer(serverB);
    }
} catch (error) {
    failures.push(`异常：${error instanceof Error ? error.message : String(error)}`);
} finally {
    rmSync(tmpRoot, { recursive: true, force: true });
}

if (failures.length > 0) {
    console.error(`\n✗ 迁移闸门 e2e 失败 ${String(failures.length)} 项：`);
    for (const item of failures) console.error(`  · ${item}`);
    process.exit(1);
}
console.log('\n✓ 迁移闸门 e2e 通过（空库拦 / 迁完直进 / 真缺才拦）');
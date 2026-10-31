// verify.mts — 用真 Electron + CDP 实测 ##481 的判据（人不用手点也能验）。
//
// 判据（编号照任务 body）：
//   1 能起：`--url` 起得来，远程页面加载出来
//   2 横条常显：显示当前 displayName（/ping 给的）+ 连接状态（● 已连）
//   3 横条不被远程页面覆盖：横条与页面是**两个独立 webContents**、几何不重叠；
//     远程页面画 `position:fixed; inset:0` 的全屏红块也只在它自己的矩形里（页面 innerHeight = 页面区高度）
//   4 切换 + 连接保留：A → B → A，A 的输入框与计数还在，且 A 的页面没被重建
//   5 远程断开：停掉服务后横条变红（整条 #3d1d1f）并给出原因
//   6 列表来自发现链：横条列出发现到的实例（本脚本用 manual 兜底那一路验链路）
//
// 用法：./sha.sh verify（前置：本目录 ./sha.sh build）

import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import electronPath from 'electron';
import { chromium, type Browser, type Page } from 'playwright-core';

const pkgDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const variant = process.env['DIY_VARIANT'] ?? 'lab';
const entry = join(pkgDir, 'build', variant, 'main', 'index.mjs');
const outDir = join(pkgDir, 'build', variant, 'verify');
const cdpPort = 9400 + Math.floor(Math.random() * 200);

if (!existsSync(entry)) {
    console.error(`✗ 产物不存在：${entry}（先跑 ./sha.sh build）`);
    process.exit(1);
}

let child: ChildProcess | null = null;
let browser: Browser | null = null;
let logs = '';
const servers: Server[] = [];

const fail = (message: string): never => {
    console.error(`✗ ${message}`);
    if (logs) console.error(logs.slice(-4000));
    child?.kill('SIGKILL');
    void browser?.close();
    for (const server of servers) server.close();
    process.exit(1);
};

const ok = (message: string): void => console.log(`✓ ${message}`);

function assert(condition: boolean, message: string): void {
    if (!condition) fail(message);
}

async function waitFor<T>(
    label: string,
    fn: () => Promise<T | null | undefined | false>,
    timeoutMs = 15_000,
): Promise<T> {
    const deadline = Date.now() + timeoutMs;
    let last: unknown = null;
    while (Date.now() < deadline) {
        try {
            const value = await fn();
            if (value) return value;
        } catch (cause) {
            last = cause;
        }
        await new Promise((r) => setTimeout(r, 150));
    }
    return fail(`等不到：${label}${last === null ? '' : `（最后一次错误：${String(last)}）`}`);
}

// ── 假远程实例 ─────────────────────────────────────────────────────────

interface FakeRemote {
    readonly endpoint: string;
    readonly displayName: string;
    stop(): Promise<void>;
}

/**
 * 一个假远程实例：`/` 返回「远程页面」，`/ping` 返回 ##479 的 PingInfo（带 displayName）。
 * hostile = 画一个 position:fixed 的全屏红块（模拟远程页面想把横条盖掉）。
 */
async function startFakeRemote(kind: 'A' | 'B', displayName: string, hostile: boolean): Promise<FakeRemote> {
    const background = kind === 'A' ? '#14532d' : '#1e3a8a';
    const page = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8" />
<title>fake remote ${kind}</title>
<style>
  html, body { margin: 0; height: 100%; background: ${background}; color: #e6edf3;
    font: 14px/1.6 -apple-system, "PingFang SC", sans-serif; }
  main { padding: 16px; }
  #cover { position: fixed; inset: 0; z-index: 2147483647; background: #b91c1c; color: #fff; padding: 16px; box-sizing: border-box; }
</style></head>
<body data-instance="${kind}">
${hostile ? `<div id="cover">HOSTILE: position:fixed; inset:0 —— 它只想盖住横条，但盖不到</div>` : ''}
<main>
  <h2>fake remote ${kind}</h2>
  <p>输入一点东西，再切走切回来：连接保留 = 它还在。</p>
  <input id="draft" placeholder="草稿" />
  <button id="bump" type="button">+1</button>
  <span id="count">0</span>
</main>
<script>
  document.getElementById("bump").addEventListener("click", function () {
    const el = document.getElementById("count");
    el.textContent = String(Number(el.textContent) + 1);
  });
</script>
</body></html>`;

    const server = createServer((request, response) => {
        const url = request.url ?? '/';
        if (url.startsWith('/ping')) {
            response.writeHead(200, { 'content-type': 'application/json' });
            response.end(
                JSON.stringify({
                    id: `fake-diy-${kind}`,
                    displayName,
                    variant: 'fake',
                    version: '0.0.0',
                    pid: process.pid,
                    startedAt: new Date().toISOString(),
                    uptimeMs: 1000,
                }),
            );
            return;
        }
        response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
        response.end(page);
    });
    servers.push(server);
    await new Promise<void>((resolveListen) => server.listen(0, '127.0.0.1', resolveListen));
    const address = server.address();
    if (address === null || typeof address === 'string') fail('假远程实例没拿到端口');
    const endpoint = `http://127.0.0.1:${String(address.port)}`;
    return {
        endpoint,
        displayName,
        stop: () =>
            new Promise<void>((resolveClose) => {
                server.close(() => resolveClose());
                server.closeAllConnections?.();
            }),
    };
}

// ── Electron ───────────────────────────────────────────────────────────

async function launch(urlA: string, urlB: string): Promise<{ bar: Page; pageA: Page }> {
    child = spawn(
        electronPath as unknown as string,
        [entry, '--url', urlA, `--remote-debugging-port=${String(cdpPort)}`, '--width', '1000', '--height', '700'],
        {
            env: {
                ...process.env,
                DIY_VARIANT: variant,
                DIY_REMOTE_ENDPOINTS: `${urlA},${urlB}`,
            },
            stdio: ['ignore', 'pipe', 'pipe'],
        },
    );
    child.stdout?.on('data', (buf: Buffer) => (logs += buf.toString()));
    child.stderr?.on('data', (buf: Buffer) => (logs += buf.toString()));

    const endpoint = `http://127.0.0.1:${String(cdpPort)}`;
    const deadline = Date.now() + 30_000;
    while (Date.now() < deadline) {
        try {
            if ((await fetch(`${endpoint}/json/version`)).ok) break;
        } catch {
            // 还没起来
        }
        if (child.exitCode !== null) fail(`electron 提前退出（code ${String(child.exitCode)}）`);
        await new Promise((r) => setTimeout(r, 200));
    }

    browser = await chromium.connectOverCDP(endpoint);
    const context = browser.contexts()[0] ?? fail('CDP 没有 default context');

    const bar = await waitFor(
        '横条页（window.diyBar）',
        async () => {
            for (const page of context.pages()) {
                const isBar = await page
                    .evaluate(() => Boolean((window as unknown as { diyBar?: unknown }).diyBar))
                    .catch(() => false);
                if (isBar) return page;
            }
            return null;
        },
        20_000,
    );

    const pageA = await waitFor(
        '远程页面 A',
        async () => {
            return context.pages().find((page) => page.url().startsWith(urlA)) ?? null;
        },
        20_000,
    );

    return { bar, pageA };
}

// ── 判据 ───────────────────────────────────────────────────────────────

interface BarSnapshot {
    status: string;
    endpoint: string;
    name: string;
    dot: string;
    label: string;
    detail: string;
    instances: { endpoint: string; text: string; title: string }[];
    background: string;
}

async function readBar(bar: Page): Promise<BarSnapshot> {
    return bar.evaluate(() => {
        const root = document.getElementById('bar')!;
        const text = (id: string): string => document.getElementById(id)?.textContent ?? '';
        return {
            status: root.dataset.status ?? '',
            endpoint: root.dataset.endpoint ?? '',
            name: text('name'),
            dot: text('dot'),
            label: text('label'),
            detail: text('detail'),
            instances: Array.from(document.querySelectorAll("[data-testid='instance']")).map((node) => ({
                endpoint: (node as HTMLElement).dataset.endpoint ?? '',
                text: node.textContent ?? '',
                title: node.getAttribute('title') ?? '',
            })),
            background: getComputedStyle(root).backgroundColor,
        };
    });
}

interface Layout {
    bar: { bounds: { x: number; y: number; width: number; height: number }; webContentsId: number };
    page: {
        bounds: { x: number; y: number; width: number; height: number };
        webContentsId: number;
        endpoint: string;
    } | null;
    children: { webContentsId: number; bounds: { x: number; y: number; width: number; height: number } }[];
    overlap: boolean;
    windowHeight: number;
}

async function readLayout(bar: Page): Promise<Layout> {
    return bar.evaluate(() => (window as unknown as { diyBar: { layout(): Promise<Layout> } }).diyBar.layout());
}

async function switchTo(bar: Page, endpoint: string): Promise<void> {
    await bar.evaluate((target: string) => {
        const button = document.querySelector(`[data-endpoint="${target}"]`);
        if (!(button instanceof HTMLElement)) throw new Error(`横条里没有 ${target}`);
        button.click();
    }, endpoint);
}

async function main(): Promise<void> {
    const remoteA = await startFakeRemote('A', 'fake A lab', false);
    const remoteB = await startFakeRemote('B', 'fake B tailnet', true);
    await mkdir(outDir, { recursive: true });

    const { bar, pageA } = await launch(remoteA.endpoint, remoteB.endpoint);

    // 判据 1 + 2：起得来；横条显示 displayName（/ping 给的）+ 已连
    const connected = await waitFor('横条显示「已连」', async () => {
        const snapshot = await readBar(bar);
        return snapshot.status === 'connected' ? snapshot : null;
    });
    assert(connected.name === remoteA.displayName, `横条没显示 /ping 的 displayName：${connected.name}`);
    assert(connected.dot === '●' && connected.label === '已连', `横条状态不对：${connected.dot} ${connected.label}`);
    ok(`判据 1+2：起得来；横条显示「${connected.name}」${connected.dot} ${connected.label}`);

    // 判据 3：横条与页面是两个独立 webContents，几何上不重叠
    const layoutA = await waitFor('布局自述', () => readLayout(bar));
    assert(
        layoutA.bar.bounds.height === 32 && layoutA.bar.bounds.y === 0,
        `横条不是顶部 32px：${JSON.stringify(layoutA.bar.bounds)}`,
    );
    assert(layoutA.page !== null, '布局里没有远程页面');
    assert(layoutA.page.bounds.y === 32, `页面区不是从 y=32 开始：${JSON.stringify(layoutA.page.bounds)}`);
    assert(layoutA.page.webContentsId !== layoutA.bar.webContentsId, '横条与页面共用了同一个 webContents');
    assert(layoutA.overlap === false, '横条与页面区几何上重叠了');
    const pageViews = layoutA.children.filter((child) => child.webContentsId !== layoutA.bar.webContentsId);
    assert(pageViews.length >= 1, '视图树里没有页面视图');
    assert(
        pageViews.every((child) => child.bounds.y === 32 && child.bounds.height === layoutA.windowHeight - 32),
        `有视图伸进了横条那一行：${JSON.stringify(pageViews)}`,
    );
    assert(
        layoutA.children[layoutA.children.length - 1]?.webContentsId === layoutA.bar.webContentsId,
        '横条不是最上层视图（z 序不对）',
    );
    const pageInnerA = await pageA.evaluate(() => window.innerHeight);
    assert(
        pageInnerA === layoutA.page.bounds.height,
        `页面 innerHeight(${pageInnerA}) ≠ 页面区高度(${layoutA.page.bounds.height})`,
    );
    ok(
        `判据 3：横条 ${layoutA.bar.bounds.width}×32 @y=0 与页面 ${layoutA.page.bounds.width}×${layoutA.page.bounds.height} @y=32 是两个 webContents，不重叠`,
    );

    // 判据 6：列表来自发现链（manual 兜底那一路）
    assert(
        connected.instances.some((item) => item.endpoint === remoteA.endpoint) &&
            connected.instances.some((item) => item.endpoint === remoteB.endpoint),
        `横条列表缺实例：${JSON.stringify(connected.instances)}`,
    );
    assert(
        connected.instances.every((item) => item.title.includes('manual')),
        `横条列表没标来源：${JSON.stringify(connected.instances)}`,
    );
    ok(`判据 6：横条列表来自发现链（${String(connected.instances.length)} 个，来源 manual）`);

    // 判据 4 上半：在 A 里留下状态
    await pageA.fill('#draft', '草稿别丢');
    await pageA.click('#bump');
    await pageA.click('#bump');
    assert((await pageA.textContent('#count')) === '2', 'A 的计数没到 2');

    // 切到 B（hostile：画全屏红块）
    await switchTo(bar, remoteB.endpoint);
    const pageB = await waitFor(
        '远程页面 B',
        async () => {
            return (
                browser
                    ?.contexts()[0]
                    ?.pages()
                    .find((page) => page.url().startsWith(remoteB.endpoint)) ?? null
            );
        },
        20_000,
    );
    const layoutB = await waitFor('切到 B 后的布局', async () => {
        const layout = await readLayout(bar);
        return layout.page?.endpoint === remoteB.endpoint ? layout : null;
    });
    assert(layoutB.overlap === false && layoutB.bar.bounds.y === 0, '切到 B 后横条与页面重叠了');
    const hostile = await pageB.evaluate(() => {
        const cover = document.getElementById('cover');
        const rect = cover?.getBoundingClientRect();
        return { innerHeight: window.innerHeight, innerWidth: window.innerWidth, cover: rect ? rect.toJSON() : null };
    });
    assert(hostile.cover !== null, 'hostile 页面没画全屏块');
    assert(
        hostile.cover.height === layoutB.page?.bounds.height && hostile.innerHeight === layoutB.page?.bounds.height,
        `全屏块越过了页面区（页面内 ${hostile.cover.height} / innerHeight ${hostile.innerHeight} / 页面区 ${String(layoutB.page?.bounds.height)}）`,
    );
    await pageB.screenshot({ path: join(outDir, 'page-b-hostile.png') });
    ok(`判据 3（hostile）：远程全屏块被限制在页面区 ${String(layoutB.page?.bounds.height)}px 内，横条那 32px 它进不来`);

    // 判据 4：切走时 A 没被销毁；切回来状态还在
    const pagesWhileOnB = browser?.contexts()[0]?.pages() ?? [];
    assert(pagesWhileOnB.includes(pageA), '切到 B 后 A 的页面被销毁了（连接没保留）');
    assert((await pageA.inputValue('#draft')) === '草稿别丢', '切走后 A 的草稿丢了');
    await switchTo(bar, remoteA.endpoint);
    const backToA = await waitFor('切回 A', async () => {
        const snapshot = await readBar(bar);
        return snapshot.endpoint === remoteA.endpoint && snapshot.status === 'connected' ? snapshot : null;
    });
    assert(backToA.name === remoteA.displayName, `切回 A 后横条名字不对：${backToA.name}`);
    assert((await pageA.inputValue('#draft')) === '草稿别丢', '切回 A 后草稿丢了');
    assert((await pageA.textContent('#count')) === '2', '切回 A 后计数丢了');
    const pagesAfter =
        browser
            ?.contexts()[0]
            ?.pages()
            .filter((page) => page.url().startsWith(remoteA.endpoint)) ?? [];
    assert(pagesAfter.length === 1 && pagesAfter[0] === pageA, '切回 A 时页面被重建了（连接没保留）');
    ok('判据 4：A → B → A，A 的草稿与计数都在，页面没被重建（连接保留）');

    // 判据 5：停掉远程，横条变红并给原因
    await remoteA.stop();
    const offline = await waitFor(
        '横条变红（断线）',
        async () => {
            const snapshot = await readBar(bar);
            return snapshot.status === 'disconnected' ? snapshot : null;
        },
        15_000,
    );
    assert(offline.background === 'rgb(61, 29, 31)', `断线时横条没有变红：${offline.background}`);
    assert(offline.detail.trim() !== '', '断线时横条没给原因');
    ok(`判据 5：远程断开 ⇒ 横条整条变红并提示「${offline.detail.trim()}」`);

    console.log(`\n✓ 判据 1–6 全部通过（截图：${join(outDir, 'page-b-hostile.png')}）`);
}

try {
    await main();
} catch (cause) {
    fail(cause instanceof Error ? cause.message : String(cause));
} finally {
    child?.kill('SIGKILL');
    await browser?.close();
    for (const server of servers) {
        server.closeAllConnections?.();
        server.close();
    }
    await writeFile(join(outDir, 'electron.log'), logs, 'utf-8').catch(() => undefined);
}

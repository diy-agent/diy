// main.ts — Electron 主进程入口（A1 远程壳的装配）。
//
// 窗口里只有两个（或更多）**互相独立的 WebContentsView**，垂直排列：
//
//   ┌──────────────────────────────┐
//   │ 横条 32px（本地 data: 页）     │  ← 壳渲染，远程页面碰不到
//   ├──────────────────────────────┤
//   │ 远程页面（http://…）           │  ← y 从 32 开始
//   └──────────────────────────────┘
//
// 三条硬规则（##481）在这里的落点：
//   1. 横条是**另一个 webContents**，几何上不重叠 ⇒ 远程页面物理上盖不住它（判据 3）。
//   2. 横条只做「当前位置 + 切换」：`connect` 直接换 URL，没有任何确认 / 拦截。
//   3. 单窗口；切走的页面**不销毁**（pages Map 持有，只 setVisible(false)），切回来立即有内容。
//
// ⚠️ 不要用顶层 await（同 apps/chat 的教训）：Electron 的 ESM 入口里顶层 await 会让
// 模块求值卡在事件循环启动之前 —— app ready 永不触发、窗口不出现、CDP 也不监听。

import { app, BaseWindow, ipcMain, net, WebContentsView } from 'electron';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createLogger, isLogLevel } from '@diy-agent/log';
import { barDataUrl } from './bar.js';
import { BAR_INVOKE_CHANNEL, BAR_STATE_CHANNEL, SHELL_CURRENT_CHANNEL, type BarRequest } from './channels.js';
import { discoverInstances } from './discover.js';
import {
    BAR_HEIGHT,
    HEARTBEAT_INTERVAL_MS,
    HEARTBEAT_TIMEOUT_MS,
    TITLE,
    displayNameOf,
    mergeCandidates,
    messageOf,
    normalizeEndpoint,
    parseCliArgs,
    parseEndpointList,
    pingUrl,
    rectsOverlap,
    withBadge,
    type BarState,
    type CliArgs,
    type ConnectionStatus,
    type CurrentInstance,
    type DiscoveryError,
    type MergedCandidate,
    type ShellLayout,
} from './index.js';

// ##458 ③：lab 变体开 CDP（缺省 9222），agent 用 curl / playwright 连上来查 DOM。
// 必须在 app ready 之前 append；命令行已显式给 `--remote-debugging-port` 时不覆盖
// （验证脚本自己挑随机端口，避免和本机别的调试进程抢 9222）。
const cdpFromArgv = process.argv.some((arg) => arg.startsWith('--remote-debugging-port'));
if (process.env['DIY_VARIANT'] === 'lab' && !cdpFromArgv) {
    app.commandLine.appendSwitch('remote-debugging-port', process.env['DIY_CDP_PORT'] ?? '9222');
}

const here = dirname(fileURLToPath(import.meta.url)); // build/<variant>/main
const BAR_PRELOAD = join(here, '../preload/bar.cjs');
const SHELL_PRELOAD = join(here, '../preload/shell.cjs');

const args: CliArgs = parseCliArgs(process.argv.slice(2));

// ##482：应用日志（全 app 一份 jsonl 流，按 source 过滤）。装配层只在入口建一次，句柄往下传；
// DIY_HOME 缺席（被当纯库 import / 单测）⇒ 落到 Electron 的 userData，绝不写当前目录。
const logger = createLogger({
    dir: join(process.env['DIY_HOME'] ?? app.getPath('userData'), 'log', 'app'),
    level: isLogLevel(process.env['DIY_LOG_LEVEL']) ? process.env['DIY_LOG_LEVEL'] : 'info',
});
const log = logger.child('main:remote-shell');

log.info('远程壳启动', {
    variant: process.env['DIY_VARIANT'] ?? '',
    url: args.url ?? '',
    barHeight: BAR_HEIGHT,
    manual: process.env['DIY_REMOTE_ENDPOINTS'] ?? '',
});

/** 一个远程页面（连接保留的单元：按 endpoint 存在 pages 里，永不淘汰） */
interface PageEntry {
    readonly endpoint: string;
    readonly view: WebContentsView;
    displayName: string;
    /** 显示名是发现器 / 对端 /ping 给的（false = 还只是 host 兜底，可以被 /ping 覆盖） */
    named: boolean;
    status: ConnectionStatus;
    detail?: string;
    /** 渲染进程还活着（死过就得重建视图，不能复用） */
    alive: boolean;
}

interface PageRect {
    x: number;
    y: number;
    width: number;
    height: number;
}

let win: BaseWindow | null = null;
let barView: WebContentsView | null = null;
/** 没有 --url 时页面区显示的**本地**占位页（不是远程内容） */
let placeholderView: WebContentsView | null = null;

/** endpoint → 页面（连接保留：切走只隐藏，不销毁） */
const pages = new Map<string, PageEntry>();
let currentKey: string | null = null;

let instances: MergedCandidate[] = [];
let discoveryErrors: DiscoveryError[] = [];
let refreshing: Promise<void> | null = null;

let heartbeatTimer: ReturnType<typeof setInterval> | null = null;

// ── 状态 ────────────────────────────────────────────────────────────────

function currentEntry(): PageEntry | null {
    return currentKey === null ? null : (pages.get(currentKey) ?? null);
}

function currentInstance(): CurrentInstance | null {
    const entry = currentEntry();
    if (!entry) return null;
    return {
        endpoint: entry.endpoint,
        displayName: entry.displayName,
        status: entry.status,
        ...(entry.detail === undefined ? {} : { detail: entry.detail }),
    };
}

function refreshTitle(): void {
    if (!win) return;
    const current = currentKey === null ? null : currentInstance();
    win.setTitle(current === null ? TITLE : `${current.displayName} — ${TITLE}`);
}

function barState(): BarState {
    const current = currentInstance();
    return { current: current === null ? null : withBadge(current), instances, errors: discoveryErrors };
}

function pushState(): void {
    if (!barView || barView.webContents.isDestroyed()) return;
    barView.webContents.send(BAR_STATE_CHANNEL, barState());
}

/** 只有「当前那台」的状态变化才需要推横条（后台保留的连接不必惊动用户） */
function setStatus(entry: PageEntry, status: ConnectionStatus, detail?: string): void {
    const changed = entry.status !== status || entry.detail !== detail;
    if (changed) {
        // 连接状态变化各一条（断了才算异常：warn；其余 info）——诊断「什么时候断的」只看这一条
        const data = {
            endpoint: entry.endpoint,
            from: entry.status,
            to: status,
            ...(detail === undefined ? {} : { detail }),
        };
        if (status === 'disconnected') log.warn('连接状态变化', data);
        else log.info('连接状态变化', data);
    }
    entry.status = status;
    entry.detail = detail;
    if (changed && entry.endpoint === currentKey) pushState();
}

// ── 布局 ────────────────────────────────────────────────────────────────

const PAGE_ORIGIN: PageRect = { x: 0, y: BAR_HEIGHT, width: 0, height: 0 };

function relayout(): void {
    if (!win || !barView || !placeholderView) return;
    const { width, height } = win.getContentBounds();
    const barHeight = Math.min(BAR_HEIGHT, Math.max(0, height));
    barView.setBounds({ x: 0, y: 0, width, height: barHeight });
    const pageBounds: PageRect = {
        x: PAGE_ORIGIN.x,
        y: PAGE_ORIGIN.y,
        width,
        height: Math.max(0, height - BAR_HEIGHT),
    };
    placeholderView.setBounds(pageBounds);
    for (const entry of pages.values()) entry.view.setBounds(pageBounds);
}

/** 判据 3 的结构性证据：横条与页面区是两个独立 webContents，几何上不重叠 */
function shellLayout(): ShellLayout {
    const barBounds = barView?.getBounds() ?? { x: 0, y: 0, width: 0, height: 0 };
    const entry = currentEntry();
    const page =
        entry === null
            ? null
            : { bounds: entry.view.getBounds(), webContentsId: entry.view.webContents.id, endpoint: entry.endpoint };
    const children = (win?.contentView.children ?? []).map((child) => ({
        webContentsId: child instanceof WebContentsView ? child.webContents.id : -1,
        bounds: child.getBounds(),
    }));
    const barId = barView?.webContents.id ?? -1;
    return {
        bar: { bounds: barBounds, webContentsId: barId },
        page,
        children,
        // 横条保护的结构判据：**任何一个**别的视图都不许与横条矩形相交（含隐藏保留的页面）
        overlap: children.some((child) => child.webContentsId !== barId && rectsOverlap(barBounds, child.bounds)),
        windowHeight: win?.getContentBounds().height ?? 0,
    };
}

// ── 页面（连接保留） ─────────────────────────────────────────────────────

function placeholderDataUrl(): string {
    const html = `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8" /><meta name="color-scheme" content="dark" />
<title>diy remote shell</title>
<style>
  html, body { margin: 0; height: 100%; background: #0d1117; color: #8b949e;
    font: 14px/1.7 -apple-system, BlinkMacSystemFont, "PingFang SC", sans-serif; }
  main { display: flex; flex-direction: column; align-items: center; justify-content: center; height: 100%; gap: 6px; }
  strong { color: #c9d1d9; font-size: 15px; }
</style></head>
<body><main data-testid="placeholder">
  <strong>还没有连接实例</strong>
  <div>点上方横条的「＋ 连接…」输入 URL，或从列表里选一个。</div>
  <div>（横条由本机渲染，远程页面改不到它）</div>
</main></body></html>`;
    return `data:text/html;charset=utf-8,${encodeURIComponent(html)}`;
}

function createPage(endpoint: string, displayName: string, named: boolean): PageEntry {
    const view = new WebContentsView({
        webPreferences: {
            preload: SHELL_PRELOAD,
            contextIsolation: true,
            sandbox: true,
            nodeIntegration: false,
            spellcheck: false,
        },
    });
    view.setBackgroundColor('#0d1117');
    const entry: PageEntry = { endpoint, view, displayName, named, status: 'connecting', alive: true };
    const contents = view.webContents;

    contents.on('did-start-loading', () => {
        entry.alive = true;
        setStatus(entry, 'connecting');
    });
    contents.on('did-finish-load', () => {
        entry.alive = true;
        setStatus(entry, 'connected');
    });
    contents.on('did-fail-load', (_event, errorCode, errorDescription, _url, isMainFrame) => {
        // -3 = ERR_ABORTED（切 URL / 停止加载），不是故障
        if (!isMainFrame || errorCode === -3) return;
        entry.alive = true;
        setStatus(entry, 'disconnected', `${errorDescription}（${errorCode}）`);
    });
    contents.on('render-process-gone', (_event, details) => {
        entry.alive = false;
        log.error('渲染进程退出', { endpoint: entry.endpoint, reason: details.reason, exitCode: details.exitCode });
        setStatus(entry, 'disconnected', `渲染进程退出：${details.reason}`);
    });
    contents.on('unresponsive', () => setStatus(entry, 'disconnected', '页面无响应'));
    contents.on('responsive', () => setStatus(entry, 'connected'));

    // 页面永远插在 0 号（最底）：横条本就后加，保持最上（几何上也不重叠，双保险）
    win?.contentView.addChildView(view, 0);
    void contents.loadURL(endpoint).catch((cause: unknown) => {
        entry.alive = true;
        log.error('页面加载失败', { endpoint }, cause);
        setStatus(entry, 'disconnected', messageOf(cause));
    });
    relayout();
    return entry;
}

/** 切到某台（null = 回到占位页）。切走的视图只隐藏，**不销毁**（连接保留） */
function show(endpoint: string | null): void {
    currentKey = endpoint;
    for (const [key, entry] of pages) entry.view.setVisible(key === endpoint);
    placeholderView?.setVisible(endpoint === null);
    relayout();
    pushState();
    refreshTitle();
    const entry = currentEntry();
    if (entry) void probe(entry);
}

/** 连接 = 加载该 endpoint（已知就复用旧 webContents：切回来是原来的状态） */
async function connect(rawEndpoint: string): Promise<void> {
    const endpoint = normalizeEndpoint(rawEndpoint);
    if (endpoint === '') return;
    const known = instances.find((item) => item.endpoint === endpoint);
    const named = known?.displayName != null && known.displayName.trim() !== '';
    const displayName = known === undefined ? displayNameOf({ displayName: null, endpoint }) : displayNameOf(known);

    let entry = pages.get(endpoint);
    // 连接保留的证据：同一 endpoint 复用了还活着的 webContents（页面状态还在）
    const reused = entry !== undefined && entry.alive;
    if (entry !== undefined && !entry.alive) {
        // 渲染进程死过 ⇒ 这个 WebContents 不能再用（地址栏相同也得换一个）
        win?.contentView.removeChildView(entry.view);
        pages.delete(endpoint);
        entry = undefined;
    }
    if (entry === undefined) {
        entry = createPage(endpoint, displayName, named);
        pages.set(endpoint, entry);
    } else {
        // 发现器有名字就用它；发现器没名字（manual 兜底）时**别把 /ping 拿到的名字盖回 host**
        if (named || !entry.named) {
            entry.displayName = displayName;
            entry.named = named;
        }
        if (entry.status === 'disconnected') {
            // 断线后再点一次同一台 = 重新加载；连着的切回来则**不重载**（状态要保留）
            void entry.view.webContents.loadURL(endpoint).catch(() => undefined);
        }
    }
    show(endpoint);
    log.info('切换实例', {
        endpoint,
        displayName: currentEntry()?.displayName ?? displayName,
        reused,
        pages: pages.size,
    });
}

// ── 探活（页面自己不会喊「远程没了」） ─────────────────────────────────────

async function probe(entry: PageEntry): Promise<void> {
    if (!entry.alive) {
        setStatus(entry, 'disconnected', entry.detail ?? '页面已退出');
        return;
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), HEARTBEAT_TIMEOUT_MS);
    try {
        // 任何 HTTP 响应（含 404）= 对端还活着：壳只要「通不通」
        const response = await net.fetch(pingUrl(entry.endpoint), {
            method: 'GET',
            signal: controller.signal,
            cache: 'no-store',
        });
        setStatus(entry, 'connected');
        await adoptPingName(entry, response);
    } catch (cause) {
        log.error('探活失败', { endpoint: entry.endpoint }, cause);
        setStatus(entry, 'disconnected', messageOf(cause));
    } finally {
        clearTimeout(timer);
    }
}

/**
 * `/ping` 里带了 displayName 就采用（##479 的 PingInfo）。
 * 只在「名字还只是 host 兜底」时采纳；不是 JSON（老实例 / 静态站）就当没有 —— **绝不影响连通性判断**。
 */
async function adoptPingName(entry: PageEntry, response: { ok: boolean; json: () => Promise<unknown> }): Promise<void> {
    if (entry.named || !response.ok) return;
    try {
        const info = (await response.json()) as { displayName?: unknown };
        const name = typeof info.displayName === 'string' ? info.displayName.trim() : '';
        if (name === '') return;
        entry.named = true;
        entry.displayName = name;
        if (entry.endpoint === currentKey) {
            pushState();
            refreshTitle();
        }
    } catch {
        // 不是 JSON ⇒ 对端没实现 /ping 的语义，保持 host 兜底
    }
}

// ── 发现（##479 的发现器；包不在时退回手动 URL） ───────────────────────────

async function refreshDiscovery(): Promise<void> {
    if (refreshing) return refreshing;
    refreshing = (async () => {
        const manual = [
            ...parseEndpointList(process.env['DIY_REMOTE_ENDPOINTS']).map((item) => item.endpoint),
            ...(args.url === null ? [] : [args.url]),
        ];
        const result = await discoverInstances({ manual });
        instances = mergeCandidates(result.items);
        discoveryErrors = result.errors;
        // 发现器失败不连坐：每一路失败各一条 warn，汇总一条 info
        for (const error of result.errors) log.warn('发现器失败', { source: error.source, message: error.message });
        log.info('发现完成', { count: instances.length, errors: result.errors.length });
        pushState();
    })();
    try {
        await refreshing;
    } finally {
        refreshing = null;
    }
}

// ── IPC ────────────────────────────────────────────────────────────────

function registerIpc(): void {
    ipcMain.handle(BAR_INVOKE_CHANNEL, async (_event, request: BarRequest) => {
        switch (request?.method) {
            case 'connect':
                await connect(String(request.endpoint ?? ''));
                return null;
            case 'refresh':
                await refreshDiscovery();
                return null;
            case 'layout':
                return shellLayout();
            case 'state':
                return barState();
            default:
                return barState();
        }
    });
    // 远程页面只能问「我在哪」（只读；不给切换）
    ipcMain.handle(SHELL_CURRENT_CHANNEL, () => currentInstance());
}

// ── 装配 ──────────────────────────────────────────────────────────────

function createWindow(): void {
    const created = new BaseWindow({
        width: args.width,
        height: args.height,
        title: TITLE,
        show: false,
        backgroundColor: '#0d1117',
    });

    const bar = new WebContentsView({
        webPreferences: {
            preload: BAR_PRELOAD,
            contextIsolation: true,
            sandbox: true,
            nodeIntegration: false,
            spellcheck: false,
        },
    });
    bar.setBackgroundColor('#1f2430');
    created.contentView.addChildView(bar);
    void bar.webContents.loadURL(barDataUrl());

    const placeholder = new WebContentsView({
        webPreferences: { contextIsolation: true, sandbox: true, nodeIntegration: false },
    });
    placeholder.setBackgroundColor('#0d1117');
    created.contentView.addChildView(placeholder, 0);
    void placeholder.webContents.loadURL(placeholderDataUrl());

    created.on('resize', relayout);
    created.on('closed', () => {
        if (heartbeatTimer !== null) {
            clearInterval(heartbeatTimer);
            heartbeatTimer = null;
        }
        for (const entry of pages.values()) {
            if (!entry.view.webContents.isDestroyed()) entry.view.webContents.close();
        }
        pages.clear();
        if (placeholder && !placeholder.webContents.isDestroyed()) placeholder.webContents.close();
        if (!bar.webContents.isDestroyed()) bar.webContents.close();
        barView = null;
        placeholderView = null;
        win = null;
        currentKey = null;
    });

    win = created;
    barView = bar;
    placeholderView = placeholder;
    relayout();
    created.show();
    log.info('窗口已创建', { width: args.width, height: args.height, barHeight: BAR_HEIGHT });
}

app.whenReady()
    .then(() => {
        registerIpc();
        createWindow();
        heartbeatTimer = setInterval(() => {
            const entry = currentEntry();
            if (entry) void probe(entry);
        }, HEARTBEAT_INTERVAL_MS);
        void refreshDiscovery()
            .catch((cause: unknown) => log.error('发现失败', undefined, cause))
            .then(() => {
                // 有 --url 就直接连（无 --url 留在占位页，等用户从横条选）
                if (args.url !== null) void connect(args.url);
            });
    })
    .catch((cause: unknown) => {
        console.error('✗ 远程壳启动失败：', cause);
        log.error('远程壳启动失败', undefined, cause);
        // 先 flush 再退：close 的 promise 不会 reject（写盘失败走 onError）
        void logger.close().finally(() => app.exit(1));
    });

app.on('window-all-closed', () => {
    log.info('窗口全部关闭，退出', { pages: pages.size });
    void logger.close().finally(() => app.quit());
});

// renderer.ts — dev 启动器的界面（纯 DOM，无框架）。
//
// 数据全部来自 `page:invoke`（主进程插件）：每秒拉一次快照，所以「启动后自己刷新成运行中」
// 不靠额外的推送机制。分隔条来自 @diy-agent/workbench-ui 的 createSplitPane（260–520px）。

import { createSplitPane } from "@diy-agent/workbench-ui";
import {
    BUILD_COMMANDS,
    DEV_METHODS,
    type BuildCommand,
    type CommandSession,
    type DevSnapshot,
    type OpenMode,
    type TargetStatus,
} from "./shared.js";

interface WorkbenchBridge {
    invoke(pageId: string, method: string, args?: unknown): Promise<unknown>;
}

declare global {
    interface Window {
        workbench?: WorkbenchBridge;
    }
}

function requireEl(id: string): HTMLElement {
    const node = document.getElementById(id);
    if (node === null) throw new Error(`index.html 缺 #${id}`);
    return node;
}

const bridge = window.workbench;
if (!bridge) throw new Error("preload 桥没注入 window.workbench");
const tree = requireEl("tree");
const body = requireEl("body");
const runningLabel = requireEl("running");
const repoLabel = requireEl("repo");
const headTitle = requireEl("head-title");
const headBadge = requireEl("head-badge");
const headMeta = requireEl("head-meta");
const toastLabel = requireEl("toast");

const gateway = bridge;

async function invoke<T>(method: string, args?: unknown): Promise<T> {
    return (await gateway.invoke("dev", method, args)) as T;
}

let snapshot: DevSnapshot | null = null;
let session: CommandSession | null = null;
let selectedId: string | null = null;
let polling = false;

// ── DOM 小工具 ───────────────────────────────────────────────

function el<K extends keyof HTMLElementTagNameMap>(
    tag: K,
    className = "",
    text?: string,
): HTMLElementTagNameMap[K] {
    const node = document.createElement(tag);
    if (className !== "") node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
}

function button(label: string, className: string, onclick: () => void): HTMLButtonElement {
    const node = el("button", className, label);
    node.type = "button";
    node.addEventListener("click", (event) => {
        event.stopPropagation();
        onclick();
    });
    return node;
}

function kv(label: string, value: Node | string): [HTMLElement, HTMLElement] {
    const dt = el("dt", "", label);
    const dd = el("dd");
    if (typeof value === "string") dd.textContent = value;
    else dd.append(value);
    return [dt, dd];
}

function formatUptime(ms: number): string {
    const sec = Math.floor(ms / 1000);
    if (sec < 60) return `${sec} 秒`;
    const min = Math.floor(sec / 60);
    if (min < 60) return `${min} 分钟`;
    const hour = Math.floor(min / 60);
    if (hour < 48) return `${hour} 小时 ${min % 60} 分`;
    return `${Math.floor(hour / 24)} 天 ${hour % 24} 小时`;
}

function formatBytes(bytes: number | null): string {
    if (bytes === null) return "—";
    return `${Math.round(bytes / (1024 * 1024))} MB`;
}

function formatStartedAt(iso: string): string {
    const at = new Date(iso);
    if (Number.isNaN(at.getTime())) return iso || "—";
    const pad = (n: number): string => String(n).padStart(2, "0");
    return `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())} ${pad(at.getHours())}:${pad(at.getMinutes())}:${pad(at.getSeconds())}`;
}

function copyText(text: string): void {
    // 先走 Clipboard API（要 secure context + 用户手势）；不行就退回老办法
    const fallback = (): void => {
        const area = document.createElement("textarea");
        area.value = text;
        area.style.position = "fixed";
        area.style.opacity = "0";
        document.body.append(area);
        area.select();
        try {
            document.execCommand("copy");
        } catch {
            /* 两条路都失败：仍要把原文留在面板上（用户可手动选中） */
        }
        area.remove();
    };
    if (navigator.clipboard === undefined) {
        fallback();
        return;
    }
    void navigator.clipboard.writeText(text).catch(fallback);
}

let toastTimer: number | undefined;

function toast(message: string): void {
    // 不用 alert（会打断每秒轮询的焦点）：在顶栏闪一行状态，几秒后自动消失
    toastLabel.textContent = message;
    if (toastTimer !== undefined) window.clearTimeout(toastTimer);
    toastTimer = window.setTimeout(() => {
        toastLabel.textContent = "";
    }, 5000);
}

// ── 左侧树 ───────────────────────────────────────────────────

function shortcutsOf(entry: TargetStatus): HTMLElement {
    const acts = el("div", "acts");
    if (entry.running) {
        acts.append(
            button("聚焦", "", () => void focusEntry(entry)),
            button("关闭", "stop", () => void stopEntry(entry)),
        );
    } else if (entry.starting) {
        acts.append(el("span", "hint", "启动中…"));
    } else {
        acts.append(button("启动", "", () => void startEntry(entry)));
    }
    return acts;
}

function renderTree(): void {
    tree.replaceChildren();
    if (snapshot === null) return;
    const groups = new Map<string, TargetStatus[]>();
    for (const entry of snapshot.entries) {
        const list = groups.get(entry.group);
        if (list === undefined) groups.set(entry.group, [entry]);
        else list.push(entry);
    }
    for (const [group, entries] of groups) {
        tree.append(el("div", "app", group));
        for (const entry of entries) {
            const row = el("div", `entry${entry.id === selectedId ? " sel" : ""}`);
            row.dataset["id"] = entry.id;
            const dot = el("span", `dot ${entry.running ? "on" : entry.starting ? "wait" : "off"}`);
            const name = el("span", "nm", entry.name);
            name.append(el("span", "", entry.homeDisplay));
            row.append(dot, name, shortcutsOf(entry));
            row.addEventListener("click", () => {
                selectedId = entry.id;
                render();
            });
            tree.append(row);
        }
    }
}

// ── 右侧详情 ─────────────────────────────────────────────────

function openButtons(entry: TargetStatus, which: "workdir" | "home"): HTMLElement {
    const wrap = el("span", "open");
    const modes: readonly (readonly [string, OpenMode])[] = [
        ["open", "finder"],
        ["VS Code", "editor"],
        ["终端", "terminal"],
    ];
    for (const [label, mode] of modes) {
        wrap.append(
            button(label, "", () => {
                void invoke<{ ok: boolean; reason: string }>(DEV_METHODS.open, { id: entry.id, which, mode })
                    .then((result) => toast(result.ok ? `已打开：${result.reason}` : `打开失败：${result.reason}`))
                    .catch((error: unknown) => toast(`打开失败：${String(error)}`));
            }),
        );
    }
    return wrap;
}

function card(title: string, extra?: Node): HTMLElement {
    const box = el("div", "card");
    const head = el("h2", "", title);
    if (extra !== undefined) {
        const right = el("span", "r");
        right.append(extra);
        head.append(right);
    }
    box.append(head);
    return box;
}

function renderUriCard(entry: TargetStatus): HTMLElement {
    const box = card("实例 URI（出问题时 copy 给 agent）");
    const uri = el("div", "uri");
    uri.append(document.createTextNode(entry.uri));
    const copy = button("复制", "", () => {
        copyText(entry.uri);
        toast("实例 URI 已复制");
    });
    uri.append(copy);
    box.append(uri);
    return box;
}

function renderParamsCard(entry: TargetStatus): HTMLElement {
    const box = card("启动参数");
    const list = el("dl", "kv");
    for (const [label, path, which] of [
        ["工作目录", entry.cwd, "workdir"],
        ["数据根", entry.home, "home"],
    ] as const) {
        const value = el("span", "", path);
        value.append(openButtons(entry, which));
        list.append(...kv(label, value));
    }
    list.append(...kv("变体", `${entry.variant}（env=development）`));
    list.append(...kv("启动命令", entry.command));
    box.append(list);
    return box;
}

function renderRuntimeCard(entry: TargetStatus): HTMLElement {
    const runtime = entry.runtime;
    if (runtime === null) {
        const box = card("运行时", el("span", "hint", entry.starting ? "启动中" : "未启动"));
        box.append(el("div", "hint", entry.starting ? "进程已拉起，正在等待它写实例注册表……" : "点左上「启动」把它拉起来。"));
        if (!entry.starting) {
            box.append(button("启动", "pri", () => void startEntry(entry)));
        }
        return box;
    }
    const box = card("运行时", el("span", "hint", `已运行 ${formatUptime(runtime.uptimeMs)}`));
    const list = el("dl", "kv");
    const pidValue = el("span", "", String(runtime.pid));
    pidValue.append(
        (() => {
            const wrap = el("span", "open");
            wrap.append(
                button("copy", "", () => {
                    copyText(String(runtime.pid));
                    toast("PID 已复制");
                }),
            );
            return wrap;
        })(),
    );
    list.append(...kv("PID", pidValue));
    list.append(...kv("端口", runtime.port === null ? "—（无 RPC 端口）" : `${runtime.port}（CDP）`));
    list.append(...kv("启动于", formatStartedAt(runtime.startedAt)));
    list.append(...kv("内存", formatBytes(runtime.memBytes)));
    list.append(...kv("命令行", runtime.cmdline || "—"));
    box.append(list);
    const acts = el("div", "acts");
    acts.append(
        button("聚焦窗口", "pri", () => void focusEntry(entry)),
        button("重启", "", () => void restartEntry(entry)),
        button("打开 CDP", "", () => {
            void invoke<{ ok: boolean; reason: string }>(DEV_METHODS.revealCdp, { id: entry.id })
                .then((result) => toast(result.ok ? `已打开：${result.reason}` : `打不开 CDP：${result.reason}`))
                .catch((error: unknown) => toast(`打不开 CDP：${String(error)}`));
        }),
        button("停止", "danger", () => void stopEntry(entry)),
    );
    box.append(acts);
    return box;
}

function renderBuildCard(entry: TargetStatus): HTMLElement {
    const box = card("构建与检查", el("span", "hint", `在 ${entry.cwd} 下执行`));
    const grid = el("div", "cmdgrid");
    for (const command of BUILD_COMMANDS) {
        grid.append(button(command, "", () => void runCommand(entry, command)));
    }
    box.append(grid);
    const acts = el("div", "acts");
    acts.append(
        button("在终端里打开这个目录", "small", () => {
            void invoke<{ ok: boolean; reason: string }>(DEV_METHODS.open, {
                id: entry.id,
                which: "workdir",
                mode: "terminal",
            })
                .then((result) => toast(result.ok ? `已打开：${result.reason}` : `打开失败：${result.reason}`))
                .catch((error: unknown) => toast(`打开失败：${String(error)}`));
        }),
    );
    box.append(acts);
    return box;
}

function renderLogCard(): HTMLElement {
    const clear = button("清空", "small", () => {
        void invoke(DEV_METHODS.clearSession).then(() => {
            session = null;
            render();
        });
    });
    const status = session === null ? "（还没有输出）" : session.running ? "运行中…" : "已结束";
    const box = card(`日志 · ${status}`, clear);
    const log = el("div", "log");
    if (session === null || session.lines.length === 0) {
        log.textContent = session === null ? "点上面的构建按钮，输出会出现在这里。" : "";
    } else {
        log.textContent = session.lines.slice(-300).join("\n");
        // 滚到底（看最新一行）
        requestAnimationFrame(() => {
            log.scrollTop = log.scrollHeight;
        });
    }
    box.append(log);
    return box;
}

function renderDetail(): void {
    body.replaceChildren();
    if (snapshot === null) return;
    const entry = snapshot.entries.find((item) => item.id === selectedId) ?? null;
    if (entry === null) {
        body.append(el("div", "empty", "左侧选一个目标"));
        return;
    }
    headTitle.textContent = `${entry.app} · ${entry.name}`;
    headBadge.className = `badge ${entry.running ? "run" : entry.starting ? "wait" : "stop"}`;
    headBadge.textContent = entry.running ? "● 运行中" : entry.starting ? "● 启动中" : "○ 未启动";
    headMeta.textContent =
        entry.running && entry.runtime !== null
            ? `PID ${entry.runtime.pid}${entry.runtime.port === null ? "" : ` · :${entry.runtime.port}`}`
            : entry.command;
    body.append(
        renderUriCard(entry),
        renderParamsCard(entry),
        renderRuntimeCard(entry),
        renderBuildCard(entry),
        renderLogCard(),
    );
}

function render(): void {
    if (snapshot !== null) {
        runningLabel.textContent = `${snapshot.runningCount} 个在跑`;
        repoLabel.textContent = snapshot.repoRoot;
    }
    renderTree();
    renderDetail();
}

// ── 动作 ─────────────────────────────────────────────────────

async function startEntry(entry: TargetStatus): Promise<void> {
    try {
        const result = await invoke<{ ok: boolean; reason: string }>(DEV_METHODS.start, { id: entry.id });
        toast(result.ok ? `已启动：${result.reason}` : `启动失败：${result.reason}`);
    } catch (error) {
        toast(`启动失败：${String(error)}`);
    }
    await refresh();
}

async function stopEntry(entry: TargetStatus): Promise<void> {
    try {
        const result = await invoke<{ ok: boolean; forced: boolean; reason: string }>(DEV_METHODS.stop, { id: entry.id });
        toast(result.reason);
    } catch (error) {
        toast(`停止失败：${String(error)}`);
    }
    await refresh();
}

async function restartEntry(entry: TargetStatus): Promise<void> {
    await invoke(DEV_METHODS.stop, { id: entry.id });
    await invoke(DEV_METHODS.start, { id: entry.id });
    await refresh();
}

async function focusEntry(entry: TargetStatus): Promise<void> {
    try {
        const result = await invoke<{ ok: boolean; reason: string }>(DEV_METHODS.focus, { id: entry.id });
        toast(result.ok ? `已聚焦：${result.reason}` : `聚焦失败：${result.reason}`);
    } catch (error) {
        toast(`聚焦失败：${String(error)}`);
    }
}

async function runCommand(entry: TargetStatus, command: BuildCommand): Promise<void> {
    try {
        session = await invoke<CommandSession>(DEV_METHODS.run, { id: entry.id, command });
        render();
    } catch (error) {
        toast(`命令启动失败：${String(error)}`);
    }
}

// ── 轮询 ─────────────────────────────────────────────────────

async function refresh(): Promise<void> {
    if (polling) return;
    polling = true;
    try {
        const [next, nextSession] = await Promise.all([
            invoke<DevSnapshot>(DEV_METHODS.snapshot),
            invoke<CommandSession | null>(DEV_METHODS.session),
        ]);
        snapshot = next;
        session = nextSession;
        if (selectedId === null && next.entries.length > 0) selectedId = next.entries[0].id;
        if (selectedId !== null && !next.entries.some((entry) => entry.id === selectedId)) selectedId = null;
        render();
    } catch (error) {
        // 主进程没起来 / 通道断了：别让界面停在「正在读取」而不说话
        body.replaceChildren(el("div", "empty", `读取实例失败：${String(error)}`));
    } finally {
        polling = false;
    }
}

// ── 挂载 ─────────────────────────────────────────────────────

const side = requireEl("side");
const split = createSplitPane(side, { min: 260, max: 520, initial: 360, storageKey: "dev.splitWidth" });
split.handle.id = "split";
side.after(split.handle);

void refresh();
setInterval(() => void refresh(), 1000);

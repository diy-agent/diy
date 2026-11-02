// renderer.ts — dev 启动器的界面（纯 DOM，无框架）。
//
// 四层树（##502 第二轮）：worktree → app → launch → entries。
// 数据全部来自 `page:invoke`（主进程插件）：每秒拉一次快照，所以「启动后自己刷新成运行中」
// 不靠额外推送。分隔条来自 @diy-agent/workbench-ui 的 createSplitPane（260–520px）。

import { createSplitPane } from "@diy-agent/workbench-ui";
import {
    BUILD_COMMANDS,
    DEV_METHODS,
    type BuildCommand,
    type CommandSession,
    type DevSnapshot,
    type LaunchRef,
    type LaunchStatus,
    type OpenMode,
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
let selectedKey: string | null = null;
let polling = false;

// ── DOM 小工具 ───────────────────────────────────────────────

function el<K extends keyof HTMLElementTagNameMap>(tag: K, className = "", text?: string): HTMLElementTagNameMap[K] {
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
            /* 两条路都失败：原文仍在面板上，可手动选中 */
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
    toastLabel.textContent = message;
    if (toastTimer !== undefined) window.clearTimeout(toastTimer);
    toastTimer = window.setTimeout(() => {
        toastLabel.textContent = "";
    }, 5000);
}

function refOf(launch: LaunchStatus): LaunchRef {
    return { worktree: launch.worktree, app: launch.app, launch: launch.launch };
}

function openUrl(url: string): void {
    void invoke<{ ok: boolean; reason: string }>(DEV_METHODS.open, { url })
        .then((result) => toast(result.ok ? `已打开：${result.reason}` : `打开失败：${result.reason}`))
        .catch((error: unknown) => toast(`打开失败：${String(error)}`));
}

function openDir(launch: LaunchStatus, which: "app" | "worktree", mode: OpenMode): void {
    void invoke<{ ok: boolean; reason: string }>(DEV_METHODS.open, {
        worktree: launch.worktree,
        app: launch.app,
        which: which === "app" ? "app" : "worktree",
        mode,
    })
        .then((result) => toast(result.ok ? `已打开：${result.reason}` : `打开失败：${result.reason}`))
        .catch((error: unknown) => toast(`打开失败：${String(error)}`));
}

// ── 左侧树 ───────────────────────────────────────────────────

function hoverActions(launch: LaunchStatus): HTMLElement {
    const acts = el("div", "acts");
    if (launch.running) {
        acts.append(
            button("聚焦", "", () => void focusLaunch(launch)),
            button("关闭", "stop", () => void stopLaunch(launch)),
        );
    } else if (launch.starting) {
        acts.append(el("span", "hint", "启动中…"));
    } else {
        acts.append(button("启动", "", () => void startLaunch(launch)));
    }
    return acts;
}

function renderTree(): void {
    tree.replaceChildren();
    if (snapshot === null) return;

    // worktree → app → launch，保持主进程给的顺序
    const byWorktree = new Map<string, { label: string; running: number; apps: Map<string, { title: string; launches: LaunchStatus[] }> }>();
    for (const launch of snapshot.launches) {
        let wt = byWorktree.get(launch.worktree);
        if (wt === undefined) {
            wt = { label: launch.worktreeLabel, running: 0, apps: new Map() };
            byWorktree.set(launch.worktree, wt);
        }
        if (launch.running) wt.running += 1;
        let app = wt.apps.get(launch.app);
        if (app === undefined) {
            app = { title: launch.appTitle, launches: [] };
            wt.apps.set(launch.app, app);
        }
        app.launches.push(launch);
    }

    for (const [worktree, group] of byWorktree) {
        const head = el("div", "app");
        head.textContent = group.label;
        if (group.running > 0) head.append(el("span", "badge run", `● ${group.running}`));
        tree.append(head);

        for (const [appName, app] of group.apps) {
            const appHead = el("div", "appsub");
            appHead.textContent = `${appName}  ${app.title}`;
            tree.append(appHead);

            for (const launch of app.launches) {
                const row = el("div", `entry${launch.key === selectedKey ? " sel" : ""}${launch.built ? "" : " dim"}`);
                row.dataset["key"] = launch.key;
                const dot = el("span", `dot ${launch.running ? "on" : launch.starting ? "wait" : "off"}`);
                const name = el("span", "nm", launch.launchTitle);
                name.append(el("span", "", launch.command));
                row.append(dot, name, hoverActions(launch));
                row.addEventListener("click", () => {
                    selectedKey = launch.key;
                    render();
                });
                tree.append(row);

                // entries：静态声明（web 的 URL 可点）
                for (const entry of launch.entries) {
                    const leaf = el("div", "leaf");
                    const label = entry.kind === "web" ? "🔗" : "▣";
                    leaf.append(el("span", "leaficon", label));
                    if (entry.kind === "web" && entry.href !== null) {
                        const link = el("a", "link", entry.href);
                        link.href = "#";
                        link.addEventListener("click", (event) => {
                            event.preventDefault();
                            event.stopPropagation();
                            openUrl(entry.href ?? "");
                        });
                        leaf.append(link);
                        if (entry.portMismatch && entry.configuredUrl !== null) {
                            leaf.append(el("span", "muted", `（配置 ${entry.configuredUrl}）`));
                        }
                    } else {
                        leaf.append(el("span", "muted", entry.title ?? "Electron 窗口"));
                    }
                    tree.append(leaf);
                }
            }
        }
        // 视觉分组（最后一个 worktree 之后不再画线）
        void worktree;
    }
}

// ── 右侧详情 ─────────────────────────────────────────────────

function openButtons(launch: LaunchStatus, which: "app" | "worktree"): HTMLElement {
    const wrap = el("span", "open");
    const modes: readonly (readonly [string, OpenMode])[] = [
        ["open", "finder"],
        ["VS Code", "editor"],
        ["终端", "terminal"],
    ];
    for (const [label, mode] of modes) wrap.append(button(label, "", () => openDir(launch, which, mode)));
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

function renderEntriesCard(launch: LaunchStatus): HTMLElement | null {
    if (launch.entries.length === 0) return null;
    const box = card("入口", el("span", "hint", "静态声明（app.yaml）"));
    const list = el("dl", "kv");
    for (const entry of launch.entries) {
        const value = el("span");
        if (entry.kind === "web" && entry.href !== null) {
            const link = el("a", "link", entry.href);
            link.href = "#";
            link.addEventListener("click", (event) => {
                event.preventDefault();
                openUrl(entry.href ?? "");
            });
            value.append(link);
            if (entry.portMismatch && entry.configuredUrl !== null) {
                value.append(el("span", "muted", `（配置 ${entry.configuredUrl}）`));
            }
        } else {
            value.append(document.createTextNode(entry.title ?? "Electron 窗口"));
            value.append(el("span", "muted", "（桌面窗口，用「聚焦」拉前台）"));
        }
        list.append(...kv(entry.kind === "web" ? "浏览器" : "窗口", value));
    }
    box.append(list);
    return box;
}

function renderParamsCard(launch: LaunchStatus): HTMLElement {
    const box = card("启动参数");
    const list = el("dl", "kv");
    const dir = el("span", "", launch.appDir);
    dir.append(openButtons(launch, "app"));
    list.append(...kv("工作目录", dir));
    const wt = el("span", "", launch.worktree);
    wt.append(openButtons(launch, "worktree"));
    list.append(...kv("worktree", wt));
    list.append(...kv("启动命令", launch.command));
    list.append(...kv("构建状态", launch.built ? "已构建" : "未构建（先用下面的「构建」）"));
    box.append(list);
    return box;
}

function renderRuntimeCard(launch: LaunchStatus): HTMLElement {
    const runtime = launch.runtime;
    if (runtime === null) {
        const box = card("运行时", el("span", "hint", launch.starting ? "启动中" : "未启动"));
        box.append(
            el(
                "div",
                "hint",
                launch.starting
                    ? "进程已拉起，正在等待它写实例注册表……"
                    : launch.built
                      ? "点左上「启动」把它拉起来。"
                      : "该 worktree 还没构建过 —— 先点下面「构建」，再启动。",
            ),
        );
        if (!launch.starting) box.append(button("启动", "pri", () => void startLaunch(launch)));
        return box;
    }
    const box = card("运行时", el("span", "hint", `已运行 ${formatUptime(runtime.uptimeMs)}`));
    const list = el("dl", "kv");
    const pidValue = el("span", "", String(runtime.pid));
    const copy = el("span", "open");
    copy.append(
        button("copy", "", () => {
            copyText(String(runtime.pid));
            toast("PID 已复制");
        }),
    );
    pidValue.append(copy);
    list.append(...kv("PID", pidValue));
    list.append(...kv("端口", runtime.port === null ? "—（未回填）" : String(runtime.port)));
    list.append(...kv("启动于", formatStartedAt(runtime.startedAt)));
    list.append(...kv("内存", formatBytes(runtime.memBytes)));
    list.append(...kv("命令行", runtime.cmdline || "—"));
    list.append(...kv("数据根", runtime.diyHome || "—"));
    box.append(list);
    const acts = el("div", "acts");
    acts.append(
        button("聚焦窗口", "pri", () => void focusLaunch(launch)),
        button("重启", "", () => void restartLaunch(launch)),
        button("打开 CDP", "", () => {
            void invoke<{ ok: boolean; reason: string }>(DEV_METHODS.revealCdp, refOf(launch))
                .then((result) => toast(result.ok ? `已打开：${result.reason}` : `打不开 CDP：${result.reason}`))
                .catch((error: unknown) => toast(`打不开 CDP：${String(error)}`));
        }),
        button("停止", "danger", () => void stopLaunch(launch)),
    );
    box.append(acts);
    return box;
}

function renderBuildCard(launch: LaunchStatus): HTMLElement {
    const box = card("构建与检查", el("span", "hint", `在 ${launch.appDir} 下执行`));
    if (!launch.built) {
        const hint = el("div", "hint", "该 worktree 还没有 build/ 目录（未构建）—— 建议先跑 build。");
        box.append(hint);
    }
    const grid = el("div", "cmdgrid");
    for (const command of BUILD_COMMANDS) {
        grid.append(button(command, "", () => void runCommand(launch, command)));
    }
    box.append(grid);
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
    const launch = snapshot.launches.find((item) => item.key === selectedKey) ?? null;
    if (launch === null) {
        body.append(el("div", "empty", "左侧选一个启动项"));
        return;
    }
    headTitle.textContent = `${launch.app} · ${launch.launchTitle}`;
    headBadge.className = `badge ${launch.running ? "run" : launch.starting ? "wait" : "stop"}`;
    headBadge.textContent = launch.running ? "● 运行中" : launch.starting ? "● 启动中" : "○ 未启动";
    headMeta.textContent =
        launch.running && launch.runtime !== null
            ? `PID ${launch.runtime.pid}${launch.runtime.port === null ? "" : ` · :${launch.runtime.port}`}`
            : launch.command;
    const entries = renderEntriesCard(launch);
    if (entries !== null) body.append(entries);
    body.append(renderParamsCard(launch), renderRuntimeCard(launch), renderBuildCard(launch), renderLogCard());
}

function render(): void {
    if (snapshot !== null) {
        runningLabel.textContent = `${snapshot.runningCount} 个在跑`;
        repoLabel.textContent = `${snapshot.worktreeCount} worktree · ${snapshot.appCount} app`;
        if (snapshot.problems.length > 0) {
            repoLabel.title = snapshot.problems.join("\n");
        }
    }
    renderTree();
    renderDetail();
}

// ── 动作 ─────────────────────────────────────────────────────

async function startLaunch(launch: LaunchStatus): Promise<void> {
    try {
        const result = await invoke<{ ok: boolean; reason: string }>(DEV_METHODS.start, refOf(launch));
        toast(result.ok ? `已启动：${result.reason}` : `启动失败：${result.reason}`);
    } catch (error) {
        toast(`启动失败：${String(error)}`);
    }
    await refresh();
}

async function stopLaunch(launch: LaunchStatus): Promise<void> {
    try {
        const result = await invoke<{ ok: boolean; reason: string; forced: boolean }>(DEV_METHODS.stop, refOf(launch));
        toast(result.reason);
    } catch (error) {
        toast(`停止失败：${String(error)}`);
    }
    await refresh();
}

async function restartLaunch(launch: LaunchStatus): Promise<void> {
    await invoke(DEV_METHODS.stop, refOf(launch));
    await invoke(DEV_METHODS.start, refOf(launch));
    await refresh();
}

async function focusLaunch(launch: LaunchStatus): Promise<void> {
    try {
        const result = await invoke<{ ok: boolean; reason: string }>(DEV_METHODS.focus, refOf(launch));
        toast(result.ok ? `已聚焦：${result.reason}` : `聚焦失败：${result.reason}`);
    } catch (error) {
        toast(`聚焦失败：${String(error)}`);
    }
}

async function runCommand(launch: LaunchStatus, command: BuildCommand): Promise<void> {
    try {
        session = await invoke<CommandSession>(DEV_METHODS.run, { ...refOf(launch), command });
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
        if (selectedKey === null && next.launches.length > 0) selectedKey = next.launches[0].key;
        if (selectedKey !== null && !next.launches.some((item) => item.key === selectedKey)) selectedKey = null;
        render();
    } catch (error) {
        body.replaceChildren(el("div", "empty", `读取清单失败：${String(error)}`));
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

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
const filterToggle = requireEl("filter-running");
const gateway = bridge;

async function invoke<T>(method: string, args?: unknown): Promise<T> {
    return (await gateway.invoke("dev", method, args)) as T;
}

let snapshot: DevSnapshot | null = null;
let session: CommandSession | null = null;
let selectedKey: string | null = null;
let polling = false;
/** 「只显示运行中」过滤（titlebar 的 toggle；只影响左侧树） */
let onlyRunning = false;

const FILTER_KEY = "dev.onlyRunning";
try {
    onlyRunning = window.localStorage.getItem(FILTER_KEY) === "1";
} catch {
    onlyRunning = false;
}

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

function openDir(launch: LaunchStatus, which: "app" | "worktree" | "home" | "yaml", mode: OpenMode): void {
    void invoke<{ ok: boolean; reason: string }>(DEV_METHODS.open, {
        worktree: launch.worktree,
        app: launch.app,
        launch: launch.launch,
        which,
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

    // 「只显示运行中」：连祖先一起过滤（没在跑的 launch 不列 ⇒ 它的 app / worktree 也不列）
    const visible = snapshot.launches.filter((item) => !onlyRunning || item.running || item.starting);
    if (visible.length === 0) {
        tree.append(el("div", "empty", onlyRunning ? "没有在跑的 launch" : "（清单为空）"));
        return;
    }

    // 严格四级：repo → worktree → app → launch，每层一行、只放名字
    tree.append(
        el(
            "div",
            "lvl lvl-repo",
            snapshot.repoBranch === null
                ? snapshot.repoName
                : `${snapshot.repoName}（${snapshot.repoBranch}）`,
        ),
    );

    const byWorktree = new Map<string, Map<string, LaunchStatus[]>>();
    const wtOrder: string[] = [];
    for (const launch of visible) {
        let apps = byWorktree.get(launch.worktree);
        if (apps === undefined) {
            apps = new Map();
            byWorktree.set(launch.worktree, apps);
            wtOrder.push(launch.worktree);
        }
        const list = apps.get(launch.app);
        if (list === undefined) apps.set(launch.app, [launch]);
        else list.push(launch);
    }

    let wtIndex = 0;
    for (const worktree of wtOrder) {
        const apps = byWorktree.get(worktree);
        if (apps === undefined) continue;
        const sample = [...apps.values()][0]?.[0];
        if (sample === undefined) continue;
        // 首个 worktree = 主工作树（git worktree list 的第一行），树里用 `.` 表示仓库根本身
        tree.append(el("div", "lvl lvl-wt", wtIndex === 0 ? "." : worktreeName(sample)));
        wtIndex += 1;

        for (const [appName, launches] of apps) {
            tree.append(el("div", "lvl lvl-app", `apps/${appName}`));
            for (const launch of launches) {
                const row = el("div", `entry${launch.key === selectedKey ? " sel" : ""}${launch.built ? "" : " dim"}`);
                row.dataset["key"] = launch.key;
                // 一行只放：绿点 + launch id；其余属性全在右侧面板
                row.append(el("span", `dot ${launch.running ? "on" : launch.starting ? "wait" : "off"}`));
                row.append(el("span", "nm", launch.launch));
                row.append(hoverActions(launch));
                row.addEventListener("click", () => {
                    selectedKey = launch.key;
                    render();
                });
                tree.append(row);
            }
        }
    }
}

/** worktree 行的名字：目录名（分支名与目录名不同时补在括号里） */
function worktreeName(launch: LaunchStatus): string {
    const base = launch.worktreePath.split("/").filter(Boolean).pop() ?? launch.worktreePath;
    return launch.branch !== null && launch.branch !== base ? `${base}（${launch.branch}）` : base;
}

// ── 右侧详情 ─────────────────────────────────────────────────

function openButtons(launch: LaunchStatus, which: "app" | "worktree" | "home" | "yaml"): HTMLElement {
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

function renderUriCard(launch: LaunchStatus): HTMLElement {
    const box = card("实例 URI（出问题时 copy 给 agent）");
    const uri = el("div", "uri");
    if (launch.uri === null) {
        uri.append(
            document.createTextNode(`—（数据根还没有 instance-id：${launch.home}）`),
        );
    } else {
        uri.append(document.createTextNode(launch.uri));
        uri.append(
            button("复制", "", () => {
                copyText(launch.uri ?? "");
                toast("实例 URI 已复制");
            }),
        );
    }
    box.append(uri);
    return box;
}

function renderParamsCard(launch: LaunchStatus): HTMLElement {
    const box = card("启动参数", el("span", "hint", `launch ${launch.launch}`));
    const list = el("dl", "kv");
    list.append(...kv("标题", launch.launchTitle));
    list.append(...kv("启动命令", launch.command));
    // 环境变量（app.yaml 的 env；没有就如实写「无」）
    const envKeys = Object.keys(launch.env);
    list.append(
        ...kv(
            "环境变量",
            envKeys.length === 0
                ? "—（app.yaml 未声明）"
                : envKeys.map((key) => `${key}=${launch.env[key]}`).join("  "),
        ),
    );
    const dir = el("span", "", launch.appDir);
    dir.append(openButtons(launch, "app"));
    list.append(...kv("工作目录", dir));
    const home = el("span", "", launch.home);
    home.append(openButtons(launch, "home"));
    list.append(...kv("数据根", home));
    const yaml = el("span", "", launch.yamlPath);
    yaml.append(openButtons(launch, "yaml"));
    list.append(...kv("app.yaml", yaml));
    const wt = el("span", "", launch.worktree);
    wt.append(openButtons(launch, "worktree"));
    list.append(...kv("worktree", wt));
    list.append(...kv("构建状态", launch.built ? "已构建（有 build/ 产物）" : "未构建（先用下面的「构建」）"));
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
    body.append(
        renderUriCard(launch),
        renderParamsCard(launch),
        renderRuntimeCard(launch),
        renderBuildCard(launch),
        renderLogCard(),
    );
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

// 「只显示运行中」：只改左侧树的可见集，选中项与右侧面板不动
function syncFilterToggle(): void {
    filterToggle.setAttribute("aria-pressed", onlyRunning ? "true" : "false");
    filterToggle.classList.toggle("on", onlyRunning);
    filterToggle.textContent = onlyRunning ? "只显示运行中 · 开" : "只显示运行中";
}
filterToggle.addEventListener("click", () => {
    onlyRunning = !onlyRunning;
    try {
        window.localStorage.setItem(FILTER_KEY, onlyRunning ? "1" : "0");
    } catch {
        /* 隐私模式：本次会话内生效即可 */
    }
    syncFilterToggle();
    renderTree();
});
syncFilterToggle();

void refresh();
setInterval(() => void refresh(), 1000);

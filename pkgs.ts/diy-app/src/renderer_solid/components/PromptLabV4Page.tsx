// components/PromptLabV4Page.tsx — 试验场 VSCode 式布局（观察用，与 V1~V3 共存）
//
// 页面级自由布局案例：左 Views 区（场景/参数/模板树）+ 中央编辑器（标题栏+动作图标+普通/diff）
// + 右 Views 区（实时预览）。单一编辑器模式：树上点开一份，dirty 在树行与标题栏两处标注，
// 保存按钮两处都有。数据模型与 V1~V3 一致（同一套 template.* RPC）。
import { createSignal, createEffect, on, onMount, For, Show } from "solid-js";
import * as Tabs from "@kobalte/core/tabs";
import { diyService } from "../lib/rpc";
import { notificationStore } from "../store/notificationStore";
import { taskStore } from "../store/taskStore";
import { getRendererActions } from "../lib/renderer-actions";
import { LocalChatPage } from "./LocalChatPage";
import { TaskInfoView } from "./TaskDetailPanel";
import { JsonTree } from "./JsonTree";
import { MdEditor } from "./MdEditor";
import { lineDiff, useHoverTip, type PromptEntry, type RequestPreview } from "./promptLabCommon";

const LAB4_LEFT_KEY = "lab4.leftW";
const LAB4_RIGHT_KEY = "lab4.rightW";
function loadW(key: string, def: number, min: number, max: number): number {
    try {
        const v = Number(localStorage.getItem(key));
        if (Number.isFinite(v) && v >= min && v <= max) return v;
    } catch {
        /* 无痕模式等：回默认，不阻断 */
    }
    return def;
}

/** relpath 数组 → 目录树（前端按路径派生，不做人工分类） */
interface DirNode {
    name: string;
    path: string;
    dir: boolean;
    entry?: PromptEntry;
    children: DirNode[];
}
function buildTree(entries: PromptEntry[]): DirNode[] {
    const root: DirNode[] = [];
    const find = (nodes: DirNode[], name: string) => nodes.find((n) => n.name === name);
    for (const e of entries) {
        const parts = e.relpath.split("/");
        let level = root;
        let prefix = "";
        for (let i = 0; i < parts.length; i++) {
            const part = parts[i]!;
            prefix = prefix ? `${prefix}/${part}` : part;
            const last = i === parts.length - 1;
            let node = find(level, part);
            if (!node) {
                node = { name: part, path: prefix, dir: !last, children: [] };
                level.push(node);
            }
            if (last) {
                node.dir = false;
                node.entry = e;
            } else {
                level = node.children;
            }
        }
    }
    const sort = (nodes: DirNode[]): DirNode[] =>
        [...nodes].sort((a, b) => (a.dir === b.dir ? a.name.localeCompare(b.name) : a.dir ? -1 : 1));
    const walk = (nodes: DirNode[]): DirNode[] => sort(nodes).map((n) => ({ ...n, children: walk(n.children) }));
    return walk(root);
}

type EditorMode = "normal" | "diff";

/** 目录树行（递归）：目录可折叠，文件点开进中央编辑器；状态点缀保留，保存只在编辑器 */
export interface HoverTip {
    show: (text: string, e: MouseEvent) => void;
    hide: () => void;
}

function DirRow(props: {
    node: DirNode;
    depth: number;
    selPath: string;
    onPick: (relpath: string) => void;
    dirty: (e: PromptEntry) => boolean;
    dirOpen: (path: string) => boolean;
    onToggleDir: (path: string) => void;
    hov: HoverTip;
}) {
    return (
        <Show
            when={props.node.dir}
            fallback={
                <button
                    class={`flex w-full items-center gap-1 px-2 py-1 text-left hover:bg-base-300 ${props.selPath === props.node.path ? "bg-primary/20" : ""}`}
                    style={{ "padding-left": `${10 + props.depth * 16}px` }}
                    onClick={() => props.onPick(props.node.path)}
                    onMouseOver={(ev) => props.hov.show(props.node.entry?.desc ?? props.node.path, ev)}
                    onMouseLeave={props.hov.hide}
                >
                    <span class="w-4 shrink-0" />
                    <span class="w-4 shrink-0 text-center">{props.node.entry?.overridable === false ? "🔒" : "📄"}</span>
                    <span class="flex-1 truncate">{props.node.name}</span>
                    <Show when={props.node.entry}>
                        {(e) => (
                            <>
                                <Show when={props.dirty(e())}>
                                    <span
                                        class="text-info font-bold"
                                        onMouseOver={(ev) => {
                                            ev.stopPropagation();
                                            props.hov.show("未保存", ev);
                                        }}
                                        onMouseLeave={props.hov.hide}
                                    >
                                        •
                                    </span>
                                </Show>
                                <Show when={e().status === "overridden"}>
                                    <span
                                        class="text-warning font-bold"
                                        onMouseOver={(ev) => {
                                            ev.stopPropagation();
                                            props.hov.show("已覆盖", ev);
                                        }}
                                        onMouseLeave={props.hov.hide}
                                    >
                                        ●
                                    </span>
                                </Show>
                                <Show when={e().stale}>
                                    <span
                                        class="text-error font-bold"
                                        onMouseOver={(ev) => {
                                            ev.stopPropagation();
                                            props.hov.show(`内置已更新（覆盖基于旧版 v${e().baseVersion}）`, ev);
                                        }}
                                        onMouseLeave={props.hov.hide}
                                    >
                                        ▲
                                    </span>
                                </Show>
                            </>
                        )}
                    </Show>
                </button>
            }
        >
            <button
                class="flex w-full items-center gap-1 px-2 py-1 text-left opacity-70 hover:bg-base-300"
                style={{ "padding-left": `${10 + props.depth * 16}px` }}
                onClick={() => props.onToggleDir(props.node.path)}
            >
                <span class="w-4 shrink-0 text-center">{props.dirOpen(props.node.path) ? "▾" : "▸"}</span>
                <span class="w-4 shrink-0 text-center">📁</span>
                <span class="flex-1 truncate font-semibold">{props.node.name}</span>
            </button>
            <Show when={props.dirOpen(props.node.path)}>
                <For each={props.node.children}>
                    {(c) => (
                        <DirRow
                            node={c}
                            depth={props.depth + 1}
                            selPath={props.selPath}
                            onPick={props.onPick}
                            dirty={props.dirty}
                            dirOpen={props.dirOpen}
                            onToggleDir={props.onToggleDir}
                            hov={props.hov}
                        />
                    )}
                </For>
            </Show>
        </Show>
    );
}

export function PromptLabV4Page() {
    const [entries, setEntries] = createSignal<PromptEntry[]>([]);
    const [drafts, setDrafts] = createSignal<Record<string, string>>({});
    const [selPath, setSelPath] = createSignal<string>("000-identity.md");
    // 左右 Views 宽（拖拽可调，localStorage 持久化：纯视图缓存）
    const [leftW, setLeftW] = createSignal(loadW(LAB4_LEFT_KEY, 256, 180, 480));
    const [rightW, setRightW] = createSignal(loadW(LAB4_RIGHT_KEY, 384, 240, 640));
    let zoneRef: HTMLDivElement | undefined;
    // 目录折叠态（默认全开）
    const [openDirs, setOpenDirs] = createSignal<Record<string, boolean>>({});
    const dirOpen = (path: string) => openDirs()[path] !== false;

    /** 拖拽条通用：按 clientX 相对容器算宽 */
    function startDrag(e: MouseEvent, set: (v: number) => void, min: number, max: number, key: string, fromRight = false) {
        e.preventDefault();
        const rect = zoneRef?.getBoundingClientRect();
        if (!rect) return;
        const base = fromRight ? rect.right : rect.left;
        const move = (ev: MouseEvent) => {
            const raw = fromRight ? base - ev.clientX : ev.clientX - base;
            set(Math.min(max, Math.max(min, Math.round(raw))));
        };
        const up = () => {
            window.removeEventListener("mousemove", move);
            window.removeEventListener("mouseup", up);
            try {
                localStorage.setItem(key, String(fromRight ? rightW() : leftW()));
            } catch {
                /* 忽略 */
            }
        };
        window.addEventListener("mousemove", move);
        window.addEventListener("mouseup", up);
    }
    const [mode, setMode] = createSignal<EditorMode>("normal");
    // 任务即场景：taskUri 恒等于当前选中任务，不再手填/跟随/解绑
    const taskUri = () => taskStore.selectedUri ?? "";
    const project = () => taskUri().match(/^projects\/(\d+)\/tasks\/\d+$/)?.[1] ?? "";
    const hov = useHoverTip();
    // 顶层 tab：任务会话 / 任务详情 / agent调参（默认会话，与任务详情抽屉一致）
    const [pageTab, setPageTab] = createSignal("chat");
    const [preview, setPreview] = createSignal<RequestPreview | null>(null);
    // 各 View 折叠态（VSCode 式可收起，纯局部偏好）
    const [views, setViews] = createSignal<Record<string, boolean>>({ tree: true, sysctx: true, reqbody: true });
    // 请求体显示：树形 / 原文
    const [reqMode, setReqMode] = createSignal<"tree" | "raw">("tree");
    const toggleView = (k: string) => setViews((v) => ({ ...v, [k]: !v[k] }));
    const viewHeader = (key: string, label: string, extra?: string) => (
        <button
            class="flex w-full items-center gap-1 bg-base-300 px-2 py-1 text-[11px] font-bold tracking-wide opacity-80 hover:opacity-100"
            onClick={() => toggleView(key)}
        >
            <span>{views()[key] ? "▾" : "▸"}</span>
            <span>{label}</span>
            <Show when={extra}>
                <span class="ml-auto font-mono font-normal opacity-70">{extra}</span>
            </Show>
        </button>
    );
    const sel = () => entries().find((e) => e.relpath === selPath()) ?? null;
    const draftOf = (e: PromptEntry) => drafts()[e.relpath] ?? e.current;
    const dirtyOf = (e: PromptEntry) => drafts()[e.relpath] !== undefined && drafts()[e.relpath] !== e.current;

    async function load() {
        try {
            const list = (await diyService.diy.template.list({ project: project() })) as PromptEntry[];
            setEntries(list);
            setDrafts({});
            if (!list.some((e) => e.relpath === selPath()) && list[0]) setSelPath(list[0].relpath);
        } catch (e) {
            notificationStore.addToast("error", `模版加载失败: ${e instanceof Error ? e.message : e}`);
        }
    }

    async function save(relpath: string) {
        const content = drafts()[relpath];
        if (content === undefined) return;
        try {
            const full = (await diyService.diy.template.save({ project: project(), relpath, content })) as PromptEntry;
            setEntries((es) => es.map((e) => (e.relpath === relpath ? full : e)));
            setDrafts((d) => {
                const n = { ...d };
                delete n[relpath];
                return n;
            });
            notificationStore.addToast("info", `${relpath} 已保存为项目级覆盖`);
        } catch (e) {
            notificationStore.addToast("error", `保存失败: ${e instanceof Error ? e.message : e}`);
        }
    }

    async function restore(relpath: string) {
        try {
            const full = (await diyService.diy.template.restore({ project: project(), relpath })) as PromptEntry;
            setEntries((es) => es.map((e) => (e.relpath === relpath ? full : e)));
            setDrafts((d) => {
                const n = { ...d };
                delete n[relpath];
                return n;
            });
            notificationStore.addToast("info", `${relpath} 已恢复内置`);
        } catch (e) {
            notificationStore.addToast("error", `恢复失败: ${e instanceof Error ? e.message : e}`);
        }
    }

    // 右预览：任一草稿变化 → 防抖自动重算（参数走服务端默认，不再调）
    createEffect(
        on([drafts, project, taskUri, entries], () => {
            const timer = setTimeout(async () => {
                try {
                    const d = drafts();
                    const p = (await diyService.diy.template.preview({
                        project: project(),
                        taskUri: taskUri().trim() || undefined,
                        // 草稿走 RPC（未存盘也进预览）
                        drafts: Object.keys(d).length > 0 ? d : undefined,
                    })) as RequestPreview;
                    setPreview(p);
                } catch (e) {
                    console.warn("[lab4] 预览失败:", e);
                }
            }, 300);
            return () => clearTimeout(timer);
        }),
    );

    onMount(async () => {
        await load();
    });

    return (
        <div class="flex flex-col h-full">
            {hov.node()}
            <Show
                when={!!taskUri()}
                fallback={
                    <div class="flex flex-1 flex-col items-center justify-center gap-3 text-sm opacity-70">
                        <div>先在任务树选一个任务，试验场即以它为场景</div>
                        <button class="btn btn-sm btn-primary" onClick={() => getRendererActions().navigate?.("task")}>
                            去任务树
                        </button>
                    </div>
                }
            >
            {/* 顶：任务即场景（无选择器，详情是啥调啥）+ 页内 tab */}
            <Tabs.Root value={pageTab()} onChange={setPageTab} class="flex min-h-0 flex-1 flex-col">
            <div class="flex items-center gap-2 border-b px-3 py-1.5 text-xs shrink-0">
                <Tabs.List class="tabs tabs-box tabs-sm">
                    <Tabs.Trigger value="chat" class="tab">
                        任务会话
                    </Tabs.Trigger>
                    <Tabs.Trigger value="task" class="tab">
                        任务详情
                    </Tabs.Trigger>
                    <Tabs.Trigger value="lab" class="tab">
                        agent调参
                    </Tabs.Trigger>
                </Tabs.List>
                <Show when={!!taskUri()} fallback={
                    <span class="opacity-60">未选中任务</span>
                }>
                    <span class="badge badge-info badge-sm" title={taskUri()}>
                        📌 {taskUri()}
                    </span>
                </Show>
                <span class="opacity-60 ml-auto">
                    {entries().filter((e) => e.status === "overridden").length} 份覆盖
                    <Show when={Object.keys(drafts()).length > 0}>
                        <span class="text-info font-semibold"> · {Object.keys(drafts()).length} 未保存</span>
                    </Show>
                </span>
            </div>

            <Tabs.Content value="chat" class="flex min-h-0 flex-1 flex-col">
                <LocalChatPage />
            </Tabs.Content>
            <Tabs.Content value="lab" class="flex min-h-0 flex-1 flex-col">
            <div class="flex flex-1 min-h-0" ref={(el) => (zoneRef = el)}>
                {/* 左：模板目录树（场景/参数已删：任务即场景，参数走服务端默认） */}
                <div class="shrink-0 border-r overflow-auto text-xs p-1 space-y-1" style={{ width: `${leftW()}px` }}>
                    <div class="flex items-center px-2 py-1">
                        <span class="text-[11px] font-bold tracking-widest opacity-70">模板</span>
                    </div>
                    <div class="border border-base-300 rounded-lg overflow-hidden">
                        {viewHeader(
                            "tree",
                            "模板",
                            `${entries().length} 份 · ${entries().filter((e) => !e.overridable).length} 只读`,
                        )}
                        <Show when={views()["tree"]}>
                            <div class="bg-base-200 px-1 py-1">
                            <For each={buildTree(entries())}>
                                {(n) => (
                                    <DirRow
                                        node={n}
                                        depth={0}
                                        selPath={selPath()}
                                        onPick={setSelPath}
                                        dirty={dirtyOf}
                                        dirOpen={dirOpen}
                                        onToggleDir={(p) => setOpenDirs((o) => ({ ...o, [p]: !dirOpen(p) }))}
                                        hov={hov}
                                    />
                                )}
                            </For>
                            </div>
                        </Show>
                    </div>
                </div>

                {/* 拖拽条：左 Views 宽（双击回默认） */}
                <div
                    class="w-1.5 shrink-0 cursor-col-resize hover:bg-primary/50 active:bg-primary"
                    title="拖拽调整左栏宽度（双击恢复默认）"
                    onDblClick={() => {
                        setLeftW(256);
                        try {
                            localStorage.removeItem(LAB4_LEFT_KEY);
                        } catch {
                            /* 忽略 */
                        }
                    }}
                    onMouseDown={(e) => startDrag(e, setLeftW, 180, 480, LAB4_LEFT_KEY)}
                />
                {/* 中央编辑器 */}
                <div class="flex-1 flex flex-col min-w-0">
                    <Show when={sel()} fallback={<div class="p-4 opacity-60 text-sm">左侧模板树点开一份</div>}>
                        {(s) => (
                            <>
                                {/* 标题栏：文件名 + dirty + 右侧动作图标 */}
                                <div class="flex items-center gap-1 border-b px-3 py-1.5 text-xs shrink-0">
                                    <span class="font-mono font-semibold">
                                        {s().relpath}
                                        <Show when={dirtyOf(s())}>
                                            <span class="text-info"> •</span>
                                        </Show>
                                    </span>
                                    <span class="opacity-50">
                                        {s().title} v{s().version}
                                    </span>
                                    <div class="ml-auto flex items-center gap-1">
                                        <button
                                            class={`btn btn-xs ${mode() === "diff" ? "btn-active" : "btn-ghost"}`}
                                            title="普通 / diff 模式切换"
                                            onClick={() => setMode((m) => (m === "diff" ? "normal" : "diff"))}
                                        >
                                            ⇄
                                        </button>
                                        <button
                                            class="btn btn-xs btn-ghost"
                                            title={s().overridable ? `保存 ${s().relpath} 的覆盖` : s().tip}
                                            disabled={!s().overridable || !dirtyOf(s())}
                                            onClick={() => void save(s().relpath)}
                                        >
                                            💾
                                        </button>
                                        <button
                                            class="btn btn-xs btn-ghost"
                                            disabled={s().status !== "overridden"}
                                            title={s().status === "overridden" ? "删除覆盖，回退内置" : "无可撤销的内容"}
                                            onClick={() => void restore(s().relpath)}
                                        >
                                            ↩
                                        </button>
                                    </div>
                                </div>
                                {/* 锁卡说明条（不可编辑时顶置，不用悬浮找原因） */}
                                <Show when={!s().overridable}>
                                    <div class="alert alert-warning mx-3 mt-2 px-3 py-1.5 text-xs shrink-0">
                                        <span>🔒</span>
                                        <span>{s().tip}</span>
                                    </div>
                                </Show>
                                {/* 内容：普通（CodeMirror，内部滚动） / diff */}
                                <div class="flex min-h-0 flex-1 flex-col p-3">
                                    <Show
                                        when={mode() === "diff"}
                                        fallback={
                                            <div class="min-h-0 flex-1 overflow-hidden rounded border border-base-300">
                                                <MdEditor
                                                    value={draftOf(s())}
                                                    editable={!!s().overridable}
                                                    onChange={(v) => setDrafts((d) => ({ ...d, [s().relpath]: v }))}
                                                />
                                            </div>
                                        }
                                    >
                                        <div class="min-h-0 flex-1 overflow-auto rounded bg-base-200 p-2 font-mono text-xs leading-relaxed">
                                            <For each={lineDiff(s().builtin, draftOf(s()))}>
                                                {(l) => (
                                                    <div
                                                        class={
                                                            l.t === "-"
                                                                ? "bg-error/20"
                                                                : l.t === "+"
                                                                  ? "bg-success/20"
                                                                  : ""
                                                        }
                                                    >
                                                        <span class="opacity-50 mr-1">{l.t}</span>
                                                        {l.s || " "}
                                                    </div>
                                                )}
                                            </For>
                                        </div>
                                    </Show>
                                </div>
                            </>
                        )}
                    </Show>
                </div>

                {/* 拖拽条：右 Views 宽（双击回默认） */}
                <div
                    class="w-1.5 shrink-0 cursor-col-resize hover:bg-primary/50 active:bg-primary"
                    title="拖拽调整右栏宽度（双击恢复默认）"
                    onDblClick={() => {
                        setRightW(384);
                        try {
                            localStorage.removeItem(LAB4_RIGHT_KEY);
                        } catch {
                            /* 忽略 */
                        }
                    }}
                    onMouseDown={(e) => startDrag(e, setRightW, 240, 640, LAB4_RIGHT_KEY, true)}
                />
                {/* 右：系统上下文 + 仿真请求体（request.json 同形，所见即所得） */}
                <div class="shrink-0 overflow-auto p-1 space-y-1" style={{ width: `${rightW()}px` }}>
                    <div class="flex items-center px-2 py-1">
                        <span class="text-[11px] font-bold tracking-widest opacity-70">预览</span>
                    </div>
                    <div class="border border-base-300 rounded-lg overflow-hidden">
                        {viewHeader("sysctx", "系统上下文预览", "随草稿自动重算")}
                        <Show when={views()["sysctx"]}>
                        <div class="bg-base-200 px-2 py-2">
                    <Show when={preview()} fallback={<div class="text-xs opacity-60">渲染中…</div>}>
                        {(p) => (
                            <>
                                <Show when={p().overBudget}>
                                    <div class="alert alert-error text-xs py-1 mb-2">
                                        超出预算：{(p().overBudget!.used / 1024).toFixed(1)} KB /{" "}
                                        {(p().overBudget!.budget / 1024).toFixed(0)} KB —— 不会发送，请精简模版
                                    </div>
                                </Show>
                                <Show when={p().unknownVars.length > 0}>
                                    <div class="alert alert-warning text-xs py-1 mb-2">
                                        未知变量：{p().unknownVars.join(", ")}
                                    </div>
                                </Show>
                                <pre class="whitespace-pre-wrap rounded bg-base-200 p-2 font-mono text-xs leading-relaxed">
                                    {p().system}
                                </pre>
                            </>
                        )}
                    </Show>
                        </div>
                        </Show>
                    </div>
                    <div class="border border-base-300 rounded-lg overflow-hidden">
                        <div class="flex w-full items-center gap-1 bg-base-300 px-2 py-1 text-[11px] font-bold tracking-wide">
                            <button class="opacity-80 hover:opacity-100" onClick={() => toggleView("reqbody")}>
                                {views()["reqbody"] ? "▾" : "▸"}
                            </button>
                            <button
                                class="opacity-80 hover:opacity-100"
                                onClick={() => toggleView("reqbody")}
                                title={preview()?.requestNote ?? ""}
                            >
                                请求预览
                            </button>
                            <span class="ml-auto join join-horizontal">
                                <button
                                    class={`btn btn-xs join-item ${reqMode() === "tree" ? "btn-active" : "btn-ghost"}`}
                                    onClick={() => setReqMode("tree")}
                                >
                                    树
                                </button>
                                <button
                                    class={`btn btn-xs join-item ${reqMode() === "raw" ? "btn-active" : "btn-ghost"}`}
                                    onClick={() => setReqMode("raw")}
                                >
                                    原文
                                </button>
                            </span>
                        </div>
                        <Show when={views()["reqbody"]}>
                        <div class="bg-base-200 px-2 py-2">
                    <Show when={preview()?.requestBody} fallback={<div class="text-xs opacity-60">随任务场景生成…</div>}>
                        {(b) => (
                            <>
                                {/* 树常驻（hidden 藏），切原文不卸载 → 折叠态保留 */}
                                <div classList={{ hidden: reqMode() !== "tree" }}>
                                    <JsonTree data={b()} />
                                </div>
                                <Show when={reqMode() === "raw"}>
                                    <pre class="whitespace-pre-wrap rounded bg-base-200 p-2 font-mono text-[11px] leading-relaxed break-all">
                                        {JSON.stringify(b(), null, 1)}
                                    </pre>
                                </Show>
                            </>
                        )}
                    </Show>
                        </div>
                        </Show>
                    </div>
                </div>
            </div>
            </Tabs.Content>
            <Tabs.Content value="task" class="min-h-0 flex-1 overflow-auto p-4">
                {/* 与详情抽屉同源：keyed 保证每任务独立编辑态/草稿 */}
                <Show when={taskStore.selectedTask} keyed fallback={<div class="text-sm opacity-60">加载中…</div>}>
                    {(t) => (
                        <div class="max-w-3xl">
                            <TaskInfoView task={t} />
                        </div>
                    )}
                </Show>
            </Tabs.Content>
            </Tabs.Root>
            </Show>
        </div>
    );
}

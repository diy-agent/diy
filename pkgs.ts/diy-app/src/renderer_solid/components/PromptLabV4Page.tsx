// components/PromptLabV4Page.tsx — 试验场 VSCode 式布局（观察用，与 V1~V3 共存）
//
// 页面级自由布局案例：左 Views 区（场景/参数/模板树）+ 中央编辑器（标题栏+动作图标+普通/diff）
// + 右 Views 区（实时预览）。单一编辑器模式：树上点开一份，dirty 在树行与标题栏两处标注，
// 保存按钮两处都有。数据模型与 V1~V3 一致（同一套 template.* RPC）。
import { createSignal, createMemo, createEffect, on, For, Show } from "solid-js";
import { analyze } from "@diy/template";
import * as Tabs from "@kobalte/core/tabs";
import { diyService } from "../lib/rpc";
import { notificationStore } from "../store/notificationStore";
import { taskStore } from "../store/taskStore";
import { localChatStore } from "../store/localChatStore";
import { getRendererActions } from "../lib/renderer-actions";
import { Caches } from "../lib/ui-state";
import { projectFromUri } from "../../shared/task-uri";
import { LocalChatPage } from "./LocalChatPage";
import { TaskInfoView } from "./TaskDetailPanel";
import { JsonTree } from "./JsonTree";
import { MdEditor } from "./MdEditor";
import { lineDiff, useHoverTip, type PromptEntry } from "./promptLabCommon";
import type { RequestPreview, TraceNode } from "../../shared/prompt-schema";
import { AssembleGlobalsSchema } from "../../shared/prompt-schema";
import { buildValueTree, buildVarTree, flattenVars, type ValueNode, type VarNode } from "../../shared/var-tree";

// 变量契约在 renderer 侧直接从 schema 派生（单一真源，零 RPC 往返）：
//   SYSTEM_VARS → 引擎静态校验；VAR_TREE → 「可用变量」view 的二维树
const SYSTEM_VARS = flattenVars(AssembleGlobalsSchema);
const VAR_TREE = buildVarTree(AssembleGlobalsSchema);

// 未存盘草稿放在模块级（按 project 分桶）：App.tsx 用 <Show> 挂页面，
// 切到别的页就卸载组件，signal 里的半编辑内容会直接丢（历史问题）。
// 落地在 Caches.diy_lab_drafts（localStorage 单入口），重启也能接着编。
const [draftsByProject, setDraftsByProject] = createSignal<Record<string, Record<string, string>>>(
    Caches.diy_lab_drafts.get(),
);
function patchDrafts(pid: string, mut: (d: Record<string, string>) => Record<string, string>): void {
    setDraftsByProject((all) => {
        const next = { ...all };
        const bucket = mut(all[pid] ?? {});
        if (Object.keys(bucket).length === 0) delete next[pid];
        else next[pid] = bucket;
        Caches.diy_lab_drafts.set(next);
        return next;
    });
}

/** 试验场内层 tab（chat=任务会话 / task=任务详情 / lab=agent调参）：模块级 + 落 Caches */
export const [labTab, setLabTab] = createSignal(Caches.diy_lab_tab.get());
createEffect(() => Caches.diy_lab_tab.set(labTab()));

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
                    <span class="w-4 shrink-0 text-center">
                        {props.node.entry?.role === "entry" ? "🧭" : props.node.entry?.locked ? "🔒" : "📄"}
                    </span>
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

/** 字节数格式化（结构树用） */
function fmtBytes(n: number): string {
    if (n < 1024) return `${n} B`;
    return `${(n / 1024).toFixed(1)} KB`;
}

/** 从模版正文推断它包裹的标签（UI 只读展示；不再要求 frontmatter 维护 tag，避免两处漂移） */
function wrapsTag(body: string): string | undefined {
    return /(?:^|\n)<([a-z_][\w-]*)[\s>]/.exec(body)?.[1];
}

/**
 * 可用变量 view 的一行（名字 + 说明）
 */
function VarRow(props: { name: string; note?: string }) {
    return (
        <div class="flex items-baseline gap-2 px-2 py-0.5">
            <span class="font-mono text-info">{props.name}</span>
            <Show when={props.note}>
                <span class="truncate opacity-60">{props.note}</span>
            </Show>
        </div>
    );
}

/**
 * 结构树（table-tree，4 列）：**节点 | 参数 | 值 | 字节**。
 * 「参数」= 模版里写的（表达式/relpath/字面量），「值」= 求值后的结果 —— 这样
 * `:if-not(.f.isFirst)` 为什么进/不进，一眼能对着参数与值看明白（原因放 hover）。
 */
function TraceRows(props: {
    nodes: TraceNode[];
    depth: number;
    path: string;
    open: Record<string, boolean>;
    onToggle: (k: string, open: boolean) => void;
}) {
    return (
        <For each={props.nodes}>
            {(n, i) => {
                const key = `${props.path}/${i()}`;
                const kids = () => n.children ?? [];
                const hasKids = () => kids().length > 0;
                const isOpen = () => props.open[key] ?? props.depth < 2; // 默认展开两层
                const skipped = () => n.kind === "if" && n.result === false;
                return (
                    <>
                        <tr class={`hover:bg-base-300/40 ${skipped() ? "opacity-40" : ""}`}>
                            <td class="py-0.5 pr-1 align-top">
                                <span
                                    class="flex items-center gap-1 overflow-hidden whitespace-nowrap"
                                    style={{ "padding-left": `${props.depth * 10}px` }}
                                >
                                    <button
                                        class="w-3 shrink-0 text-left opacity-60 disabled:opacity-20"
                                        disabled={!hasKids()}
                                        onClick={() => hasKids() && props.onToggle(key, isOpen())}
                                    >
                                        {hasKids() ? (isOpen() ? "▾" : "▸") : "·"}
                                    </button>
                                    <span class="truncate">{n.name ?? n.kind}</span>
                                </span>
                            </td>
                            <td class="truncate py-0.5 pr-1 align-top font-mono" title={n.arg}>
                                {n.arg ?? ""}
                            </td>
                            <td class="truncate py-0.5 pr-1 align-top font-mono" title={n.reason ?? n.value}>
                                {n.value ?? ""}
                                <Show when={n.result !== undefined}>
                                    <span class={n.result ? "text-success" : "text-error"}>
                                        {n.result ? " ✓" : " ✗"}
                                    </span>
                                </Show>
                            </td>
                            <td class="whitespace-nowrap py-0.5 text-right align-top opacity-50">
                                {fmtBytes(n.bytes)}
                            </td>
                        </tr>
                        <Show when={hasKids() && isOpen()}>
                            <TraceRows
                                nodes={kids()}
                                depth={props.depth + 1}
                                path={key}
                                open={props.open}
                                onToggle={props.onToggle}
                            />
                        </Show>
                    </>
                );
            }}
        </For>
    );
}

/**
 * 变量值（table-tree，2 列）：**变量 | 值**。结构来自契约（schema），值来自本次注入。
 * 数组按实际元素展开（chain → [0]/[1] → path/scope/content），一眼能看出这次到底喂了什么。
 */
function ValueTree(props: {
    nodes: ValueNode[];
    path: string;
    open: Record<string, boolean>;
    onToggle: (k: string, open: boolean) => void;
    depth: number;
}) {
    return (
        <For each={props.nodes}>
            {(n, i) => {
                const key = `${props.path}/${i()}`;
                const full = () => (props.path ? `${props.path}.${n.name}` : n.name);
                const kids = () => n.children ?? [];
                const hasKids = () => kids().length > 0;
                const isOpen = () => props.open[key] ?? true;
                return (
                    <>
                        <tr class="hover:bg-base-300/40">
                            <td class="py-0.5 pr-1 align-top">
                                <span
                                    class="flex items-center gap-1 overflow-hidden whitespace-nowrap"
                                    style={{ "padding-left": `${props.depth * 10}px` }}
                                >
                                    <button
                                        class="w-3 shrink-0 text-left opacity-60 disabled:opacity-20"
                                        disabled={!hasKids()}
                                        onClick={() => hasKids() && props.onToggle(key, isOpen())}
                                    >
                                        {hasKids() ? (isOpen() ? "▾" : "▸") : "·"}
                                    </button>
                                    <span class={`truncate font-mono ${n.missing ? "opacity-50" : ""}`} title={full()}>
                                        {n.name}
                                    </span>
                                    <span class="badge badge-xs badge-ghost shrink-0 font-mono">{n.type}</span>
                                </span>
                            </td>
                            <td class="w-full max-w-0 py-0.5 align-top font-mono">
                                <span
                                    class={`block truncate ${n.missing ? "opacity-50" : ""}`}
                                    title={n.desc ? `${n.desc}｜${n.value}` : n.value}
                                >
                                    {n.value}
                                </span>
                            </td>
                        </tr>
                        <Show when={hasKids() && isOpen()}>
                            <ValueTree
                                nodes={kids()}
                                path={full()}
                                open={props.open}
                                onToggle={props.onToggle}
                                depth={props.depth + 1}
                            />
                        </Show>
                    </>
                );
            }}
        </For>
    );
}

/**
 * 变量树（table-tree，2 列）：第 1 列 = 名字 + 类型徽标（可展开），第 2 列 = 说明。
 * 每个路径段都是一个节点：diy → cli；chain → [ChainEntry] → path/scope/content。
 */
function VarTree(props: {
    nodes: VarNode[];
    /** 已发生的路径前缀（数组元素节点不参与路径拼接：chain 的 [ChainEntry] 仍属于 chain） */
    path: string;
    used: (path: string) => boolean;
    open: Record<string, boolean>;
    onToggle: (k: string, open: boolean) => void;
    depth: number;
}) {
    return (
        <For each={props.nodes}>
            {(n, i) => {
                const key = `${props.path}/${i()}`;
                const isElement = n.name.startsWith("[");
                const full = () => (props.path && !isElement ? `${props.path}.${n.name}` : props.path || n.name);
                const kids = () => n.children ?? [];
                const hasKids = () => kids().length > 0;
                const isOpen = () => props.open[key] ?? true; // 树不大 → 默认全展开
                return (
                    <>
                        <tr class="hover:bg-base-300/40">
                            {/* 单行不换行：table-fixed + truncate + title（完整信息靠 hover，不撑高行高、不出横向滚动条） */}
                            <td class="py-0.5 pr-2 align-top">
                                <span
                                    class="flex items-center gap-1 overflow-hidden whitespace-nowrap"
                                    style={{ "padding-left": `${props.depth * 10}px` }}
                                >
                                    <button
                                        class="w-3 shrink-0 text-left opacity-60 disabled:opacity-20"
                                        disabled={!hasKids()}
                                        onClick={() => hasKids() && props.onToggle(key, isOpen())}
                                    >
                                        {hasKids() ? (isOpen() ? "▾" : "▸") : "·"}
                                    </button>
                                    <Show when={!isElement && props.used(full())}>
                                        <span class="shrink-0 text-info" title="本模版用到了">
                                            ●
                                        </span>
                                    </Show>
                                    <span class="truncate font-mono" title={full()}>
                                        {n.name}
                                    </span>
                                    <span class="badge badge-xs badge-ghost shrink-0 font-mono">
                                        {n.type}
                                        {n.optional ? "?" : ""}
                                    </span>
                                </span>
                            </td>
                            <td class="w-full max-w-0 py-0.5 align-top text-[11px] opacity-70">
                                <span class="block truncate" title={n.desc ?? ""}>
                                    {n.desc ?? ""}
                                </span>
                            </td>
                        </tr>
                        <Show when={hasKids() && isOpen()}>
                            <VarTree
                                nodes={kids()}
                                path={isElement ? props.path : full()}
                                used={props.used}
                                open={props.open}
                                onToggle={props.onToggle}
                                depth={props.depth + 1}
                            />
                        </Show>
                    </>
                );
            }}
        </For>
    );
}

/** 可用变量 view 的分组标题 */
function VarGroup(props: { title: string; children: unknown }) {
    return (
        <>
            <div class="px-2 pt-1.5 font-bold tracking-wide opacity-70">{props.title}</div>
            {props.children as never}
        </>
    );
}


export function PromptLabV4Page() {
    const [entries, setEntries] = createSignal<PromptEntry[]>([]);
    const [selPath, setSelPath] = createSignal<string>("identity.md");
    // 左右 Views 宽（拖拽可调，走 ui-state 字段池：范围校验定义即生效，「重置界面状态」能清）
    const [leftW, setLeftW] = createSignal(Caches.diy_lab_left_width.get());
    const [rightW, setRightW] = createSignal(Caches.diy_lab_right_width.get());
    let zoneRef: HTMLDivElement | undefined;
    // 目录折叠态（默认全开）
    const [openDirs, setOpenDirs] = createSignal<Record<string, boolean>>({});
    const dirOpen = (path: string) => openDirs()[path] !== false;

    /** 拖拽条通用：按 clientX 相对容器算宽。宽度落 Caches（localStorage 单入口），
     *  不再裸写 localStorage（否则「重置界面状态」清不掉）。 */
    function startDrag(e: MouseEvent, set: (v: number) => void, min: number, max: number, field: { set(v: number): void }, fromRight = false) {
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
            field.set(fromRight ? rightW() : leftW());
        };
        window.addEventListener("mousemove", move);
        window.addEventListener("mouseup", up);
    }
    const [mode, setMode] = createSignal<EditorMode>("normal");
    // 任务即场景：taskUri 恒等于当前选中任务，不再手填/跟随/解绑
    const taskUri = () => taskStore.selectedUri ?? "";
    // project 与 main 侧同一个解析函数（shared/task-uri）：两份正则口径不同曾导致
    // 非数字 pid 在 renderer 侧退化成空串 → 覆盖写到 $DIY_HOME/projects/template
    const project = () => projectFromUri(taskUri());
    const hov = useHoverTip();
    // 顶层 tab：任务会话 / 任务详情 / agent调参（默认会话，与任务详情抽屉一致）
    // 内层 tab 用模块级 signal（不是组件内）：页面卸载后要记住；且 CLI 导航要能直接切到 agent调参
    const pageTab = labTab;
    const setPageTab = setLabTab;
    const [preview, setPreview] = createSignal<RequestPreview | null>(null);
    // 各 View 折叠态（VSCode 式可收起，纯局部偏好）
    const [views, setViews] = createSignal<Record<string, boolean>>({
        // 左栏：模板 / 可用变量（契约）/ 变量值（实际注入）/ 结构树（分析）；右栏：预览 / 请求
        tree: true,
        vars: true,
        vals: true,
        trace: true,
        sysctx: true,
        reqbody: true,
    });
    // 结构树展开态（key = 路径索引链，默认前两层展开）
    const [traceOpen, setTraceOpen] = createSignal<Record<string, boolean>>({});
    // 变量树展开态（默认全展开）
    const [varsOpen, setVarsOpen] = createSignal<Record<string, boolean>>({});
    // 变量值树展开态（默认全展开）
    const [valsOpen, setValsOpen] = createSignal<Record<string, boolean>>({});
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
    // 草稿按 project 分桶：切项目不会看到/写入上一个项目的草稿（曾经的静默写错项目）
    const drafts = () => draftsByProject()[project()] ?? {};
    const draftOf = (e: PromptEntry) => drafts()[e.relpath] ?? e.current;
    const dirtyOf = (e: PromptEntry) => drafts()[e.relpath] !== undefined && drafts()[e.relpath] !== e.current;
    // 「变量值」view 的数据源：契约（结构）+ 本次注入（值）
    const valueTree = createMemo(() => {
        const vals = preview()?.values;
        return vals ? buildValueTree(AssembleGlobalsSchema, vals) : [];
    });

    // 「可用变量」view 的数据源：对**当前草稿**做静态分析（renderer 侧直接跑引擎 → 随打字实时更新）
    const analysis = createMemo(() => {
        const s = sel();
        if (!s) return null;
        try {
            // 契约从 shared schema 派生（单一真源）→ 静态校验随打字实时
            return { a: analyze(draftOf(s), { file: s.relpath, vars: SYSTEM_VARS }) };
        } catch (e) {
            return { error: e instanceof Error ? e.message : String(e) };
        }
    });
    /** globals 引用按 namespace 分组：namespace → 该 namespace 下的完整路径（去重） */
    const globalPathsOf = (ns: string, paths: Array<{ path: string; scope: string }>): string[] =>
        [...new Set(paths.filter((p) => p.scope === "global" && (p.path === ns || p.path.startsWith(`${ns}.`))).map((p) => p.path))];

    async function load() {
        const pid = project();
        if (!pid) {
            setEntries([]);
            return;
        }
        try {
            const list = (await diyService.diy.template.list({ project: pid })) as PromptEntry[];
            setEntries(list);
            if (!list.some((e) => e.relpath === selPath()) && list[0]) setSelPath(list[0].relpath);
        } catch (e) {
            notificationStore.addToast("error", `模版加载失败: ${e instanceof Error ? e.message : e}`);
        }
    }

    // 切项目（选中另一个项目下的任务）→ 必须重载 + 丢掉上一个项目的草稿视图，
    // 否则列表/编辑器还是 A 项目的状态，而 save/preview 用的是 B 的 project
    createEffect(
        on(project, () => {
            void load();
        }),
    );

    async function save(relpath: string) {
        const content = drafts()[relpath];
        if (content === undefined) return;
        const pid = project();
        try {
            const full = (await diyService.diy.template.save({ project: pid, relpath, content })) as PromptEntry;
            setEntries((es) => es.map((e) => (e.relpath === relpath ? full : e)));
            patchDrafts(pid, (d) => {
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
        const pid = project();
        try {
            const full = (await diyService.diy.template.restore({ project: pid, relpath })) as PromptEntry;
            setEntries((es) => es.map((e) => (e.relpath === relpath ? full : e)));
            patchDrafts(pid, (d) => {
                const n = { ...d };
                delete n[relpath];
                return n;
            });
            notificationStore.addToast("info", `${relpath} 已恢复内置`);
        } catch (e) {
            notificationStore.addToast("error", `恢复失败: ${e instanceof Error ? e.message : e}`);
        }
    }

    // 右预览：草稿/项目/任务/条目变化 → 防抖自动重算。
    // model 传会话实际选的模型 —— 不传服务端只能退回 DEFAULT_MODEL，「试的就是真发的」就对不上。
    createEffect(
        on([() => draftsByProject(), project, taskUri, entries], () => {
            const timer = setTimeout(async () => {
                try {
                    const d = drafts();
                    const p = (await diyService.diy.template.preview({
                        project: project(),
                        taskUri: taskUri().trim() || undefined,
                        model: localChatStore.activeModel || undefined,
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

    // 首屏 + 切项目都靠上面那个 createEffect(on(project)) 触发 load()（Solid 首次 flush 即跑）

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
                    {/* 口径与树行圆点一致（dirtyOf）：否则只浏览不改内容也会因为 drafts 有条目而误报「未保存」 */}
                    <Show when={entries().some((e) => dirtyOf(e))}>
                        <span class="text-info font-semibold"> · {entries().filter((e) => dirtyOf(e)).length} 未保存</span>
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
                            `${entries().length} 份 · ${entries().filter((e) => e.locked).length} 只读`,
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
                    {/* 可用变量 view：本模版引用的变量/循环/条件/include + lint（renderer 侧实时分析草稿） */}
                    <div class="border border-base-300 rounded-lg overflow-hidden">
                        {viewHeader("vars", "可用变量", sel() ? sel()!.relpath : "未选模版")}
                        <Show when={views()["vars"]}>
                            <div class="bg-base-200 px-0 py-1 font-mono text-[11px]">
                                <Show when={analysis()} fallback={<div class="px-2 py-1 opacity-60">左侧点开一份模版</div>}>
                                    {(an) => (
                                        <Show when={an().a} fallback={<div class="px-2 py-1 text-error">{an().error}</div>}>
                                            {(a) => (
                                                <>
                                                    <VarGroup title="宿主提供（变量契约，树形展开）">
                                                        {/* 自适应列宽（不固定百分比）：名字列按内容自然宽，说明列吃满剩余 + 单行省略 */}
                                                        <table class="table table-xs w-full">
                                                            <thead>
                                                                <tr>
                                                                    <th>变量</th>
                                                                    <th>说明</th>
                                                                </tr>
                                                            </thead>
                                                            <tbody>
                                                                <VarTree
                                                                    nodes={VAR_TREE}
                                                                    path=""
                                                                    used={(path) =>
                                                                        a().paths.some(
                                                                            (pp) =>
                                                                                pp.path === path ||
                                                                                pp.path.startsWith(`${path}.`),
                                                                        )
                                                                    }
                                                                    open={varsOpen()}
                                                                    onToggle={(k, open) =>
                                                                        setVarsOpen((o) => ({ ...o, [k]: !open }))
                                                                    }
                                                                    depth={0}
                                                                />
                                                            </tbody>
                                                        </table>
                                                    </VarGroup>
                                                    <Show when={a().globals.length > 0} fallback={<VarGroup title="引用 globals"><div class="px-2 opacity-60">（无）</div></VarGroup>}>
                                                        <VarGroup title="引用 globals">
                                                            <For each={a().globals}>
                                                                {(ns) => (
                                                                    <VarRow name={`${ns}.*`} note={globalPathsOf(ns, a().paths).join(" ")} />
                                                                )}
                                                            </For>
                                                        </VarGroup>
                                                    </Show>
                                                    <Show when={a().dynamics.length > 0}>
                                                        <VarGroup title="动态名（:for 信封 / include 参数）">
                                                            <VarRow name={a().dynamics.map((d) => `.${d}`).join(" ")} />
                                                        </VarGroup>
                                                    </Show>
                                                    <Show when={a().loops.length > 0}>
                                                        <VarGroup title="循环">
                                                            <For each={a().loops}>
                                                                {(l) => <VarRow name={`:for={{${l.source}}}`} note={`:as="${l.as}"`} />}
                                                            </For>
                                                        </VarGroup>
                                                    </Show>
                                                    <Show when={a().conditions.length > 0}>
                                                        <VarGroup title="条件">
                                                            <For each={a().conditions}>
                                                                {(c) => <VarRow name={`${c.negate ? ":if-not" : ":if"}({{${c.path}}})`} />}
                                                            </For>
                                                        </VarGroup>
                                                    </Show>
                                                    <Show when={a().includes.length > 0}>
                                                        <VarGroup title="include">
                                                            <For each={a().includes}>
                                                                {(inc) => (
                                                                    <VarRow
                                                                        name={inc.relpath}
                                                                        note={inc.args.length > 0 ? inc.args.map((g) => g.name).join(" ") : "无参数"}
                                                                    />
                                                                )}
                                                            </For>
                                                        </VarGroup>
                                                    </Show>
                                                    <Show when={a().lint.length > 0}>
                                                        <VarGroup title="lint">
                                                            <For each={a().lint}>
                                                                {(is) => (
                                                                    <div class="px-2 py-0.5 text-warning">
                                                                        {is.loc.line}:{is.loc.col} {is.message}
                                                                    </div>
                                                                )}
                                                            </For>
                                                        </VarGroup>
                                                    </Show>
                                                </>
                                            )}
                                        </Show>
                                    )}
                                </Show>
                            </div>
                        </Show>
                    </div>
                    {/* 变量值 view：本次**实际注入**的 globals（值随任务/草稿变化；结构来自契约） */}
                    <div class="border border-base-300 rounded-lg overflow-hidden">
                        {viewHeader("vals", "变量值", "本次注入的实际值（随任务变化）")}
                        <Show when={views()["vals"]}>
                            <div class="bg-base-200 px-0 py-1 text-[11px]">
                                <Show
                                    when={preview()}
                                    fallback={<div class="px-2 py-1 opacity-60">渲染中…</div>}
                                >
                                    <table class="table table-xs table-fixed w-full">
                                        <colgroup>
                                            <col class="w-[42%]" />
                                            <col />
                                        </colgroup>
                                        <thead>
                                            <tr>
                                                <th>变量</th>
                                                <th>值</th>
                                            </tr>
                                        </thead>
                                        <tbody>
                                            <ValueTree
                                                nodes={valueTree()}
                                                path=""
                                                open={valsOpen()}
                                                onToggle={(k, open) => setValsOpen((o) => ({ ...o, [k]: !open }))}
                                                depth={0}
                                            />
                                        </tbody>
                                    </table>
                                </Show>
                            </div>
                        </Show>
                    </div>
                    {/* 结构树 view：与预览同源的 trace（节点 | 参数 | 值 | 字节） */}
                    <div class="border border-base-300 rounded-lg overflow-hidden">
                        {viewHeader(
                            "trace",
                            "结构树",
                            preview()?.trace ? `${preview()!.trace!.length} 顶层节点` : "随预览重算",
                        )}
                        <Show when={views()["trace"]}>
                            <div class="bg-base-200 px-0 py-1 text-[11px]">
                                <Show when={preview()?.trace} fallback={<div class="px-2 py-1 opacity-60">渲染中…</div>}>
                                    {(tr) => (
                                        <table class="table table-xs table-fixed w-full">
                                            <colgroup>
                                                <col class="w-[30%]" />
                                                <col class="w-[30%]" />
                                                <col class="w-[24%]" />
                                                <col class="w-[16%]" />
                                            </colgroup>
                                            <thead>
                                                <tr>
                                                    <th>节点</th>
                                                    <th>参数</th>
                                                    <th>值</th>
                                                    <th class="text-right">字节</th>
                                                </tr>
                                            </thead>
                                            <tbody>
                                                <TraceRows
                                                    nodes={tr()!}
                                                    depth={0}
                                                    path=""
                                                    open={traceOpen()}
                                                    onToggle={(k, open) => setTraceOpen((o) => ({ ...o, [k]: !open }))}
                                                />
                                            </tbody>
                                        </table>
                                    )}
                                </Show>
                            </div>
                        </Show>
                    </div>
                </div>

                {/* 拖拽条：左 Views 宽（双击回默认） */}
                <div
                    class="w-1.5 shrink-0 cursor-col-resize hover:bg-primary/50 active:bg-primary"
                    title="拖拽调整左栏宽度（双击恢复默认）"
                    onDblClick={() => {
                        setLeftW(336);
                        Caches.diy_lab_left_width.reset();
                    }}
                    onMouseDown={(e) => startDrag(e, setLeftW, 180, 480, Caches.diy_lab_left_width)}
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
                                    {/* 结构也可视化：这个节会包在什么标签里 / 它是不是片段模版 */}
                                    <Show when={wrapsTag(s().current)}>
                                        <span class="badge badge-xs badge-ghost font-mono">&lt;{wrapsTag(s().current)}&gt;</span>
                                    </Show>
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
                                            title={s().locked ? s().lockTip : `保存 ${s().relpath} 的覆盖`}
                                            disabled={s().locked || !dirtyOf(s())}
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
                                <Show when={s().locked}>
                                    <div class="alert alert-warning mx-3 mt-2 px-3 py-1.5 text-xs shrink-0">
                                        <span>🔒</span>
                                        <span>{s().lockTip}</span>
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
                                                    editable={!s().locked}
                                                    onChange={(v) => patchDrafts(project(), (d) => ({ ...d, [s().relpath]: v }))}
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
                        Caches.diy_lab_right_width.reset();
                    }}
                    onMouseDown={(e) => startDrag(e, setRightW, 240, 640, Caches.diy_lab_right_width, true)}
                />
                {/* 右：预览（系统上下文 + 仿真请求体；结构化观察在左栏，这里只回答"发出去的是什么"） */}
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
                                <Show when={p().warnings.length > 0}>
                                    <div class="alert alert-warning text-xs py-1 mb-2">
                                        {p().warnings.map((w) => (
                                            <span>⚠️ {w}</span>
                                        ))}
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
                            <Show when={preview()?.requestNote}>
                                <div class="px-2 pt-1 text-[11px] opacity-60">{preview()!.requestNote}</div>
                            </Show>
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

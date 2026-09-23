// components/PromptLabV4Page.tsx — 试验场 VSCode 式布局（观察用，与 V1~V3 共存）
//
// 页面级自由布局案例：左 Views 区（场景/参数/模板树）+ 中央编辑器（标题栏+动作图标+普通/diff）
// + 右 Views 区（实时预览）。单一编辑器模式：树上点开一份，dirty 在树行与标题栏两处标注，
// 保存按钮两处都有。数据模型与 V1~V3 一致（同一套 template.* RPC）。
import { createSignal, createMemo, createEffect, on, For, Show } from "solid-js";
import { analyze } from "@diy/template";
import { diyService } from "../lib/rpc";
import { notificationStore } from "../store/notificationStore";
import { taskStore } from "../store/taskStore";
import { localChatStore } from "../store/localChatStore";
import { ViewGrid } from "./ViewGrid";
import type { JSX } from "solid-js";
import { areasWithViews, findPage } from "../../shared/view-registry";
import { layoutStore } from "../store/layoutStore";
import { Caches, type CacheField } from "../lib/ui-state";
import { projectFromUri } from "../../shared/task-uri";
import { JsonTree } from "./JsonTree";
import { MdEditor } from "./MdEditor";
import { EditorThemePicker } from "./EditorThemePicker";
import { collectTags } from "../../shared/xml-tags";
import { lineDiff, useHoverTip, type PromptEntry } from "./promptLabCommon";
import type { RequestPreview, TraceNode } from "../../shared/prompt-schema";
import { AssembleGlobalsSchema } from "../../shared/prompt-schema";
import { buildValueTree, buildVarTree, flattenVars, type ValueNode, type VarNode } from "../../shared/var-tree";
import type { HlLines } from "./MdEditor";
import { lineNumbersOf, type HlSpan } from "../../shared/hl-lines";

// 变量契约在 renderer 侧直接从 schema 派生（单一真源，零 RPC 往返）：
//   SYSTEM_VARS → 引擎静态校验；VAR_TREE → 「变量定义」view 的二维树
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

/** 试验场内层 tab（lab=系统提示词 / req=请求预览）：模块级 + 落 Caches。
 *  注：会话与任务详情已上移为 task-run page 的 area（不再是本视图内部的 tab） */

/**
 * 各 view 的展开态（模块级：`ui view expand` 可能在页面还没挂载时就设置）。
 * 默认只展开「模板」，其余按需点开 —— 否则左栏一屏塞满、真正要看的表全在折叠下面。
 */
export const [labViews, setLabViews] = createSignal<Record<string, boolean>>({
    tree: true,
    trace: false,
    vars: false,
    vals: false,
    sysctx: true,
    reqbody: true,
});
export function setLabView(key: string, open: boolean): void {
    setLabViews((v) => ({ ...v, [key]: open }));
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
                    // 选中行自带 hover 色：否则 hover 的中性灰会盖掉选中背景（与表格里同一个坑）
                    class={`flex w-full items-center gap-1 px-2 py-1 text-left ${
                        props.selPath === props.node.path
                            ? "bg-primary/25 hover:bg-primary/40"
                            : "hover:bg-base-300"
                    }`}
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

/** 一张表的列宽状态：本地 signal（拖动即时重渲染）+ Caches（持久化，重启/重置可控） */
type ColsState = {
    w: () => number[];
    resize: (i: number, px: number) => void;
    reset: (i: number) => void;
};

/**
 * 可调列宽的表头单元：右边缘 3px 把手拖动改列宽（双击恢复默认）。
 * 表宽 = 各列宽之和（px）→ **拖动左栏不会改变列宽**；表比可视区宽时左栏出横向滚动条。
 */
function Th(props: { label: string; cols: ColsState; index: number; right?: boolean }) {
    return (
        <th class={`relative select-none py-1 ${props.right ? "text-right" : ""}`}>
            <span>{props.label}</span>
            <span
                class="absolute right-0 top-0 h-full w-[3px] cursor-col-resize hover:bg-primary/60 active:bg-primary"
                title="拖动调整列宽（双击恢复默认）"
                onDblClick={() => props.cols.reset(props.index)}
                onMouseDown={(e) => {
                    e.preventDefault();
                    const startX = e.clientX;
                    const startW = props.cols.w()[props.index] ?? 0;
                    const move = (ev: MouseEvent) =>
                        props.cols.resize(props.index, Math.round(startW + ev.clientX - startX));
                    const up = () => {
                        window.removeEventListener("mousemove", move);
                        window.removeEventListener("mouseup", up);
                    };
                    window.addEventListener("mousemove", move);
                    window.addEventListener("mouseup", up);
                }}
            />
        </th>
    );
}

/**
 * **动态菜单条**（DynamicBar）—— 一种可复用的视图元素/技巧：
 *   · 只在"有上下文"时存在（这里是：选中了模版里的某一段），没有上下文就**完全不渲染**
 *     —— 不做"空条常驻"，否则取消选中后还留一条空横条，看着像坏了
 *   · 内容随上下文变化（这里：↑/↓ 在出现处之间跳焦点 + `1/3` 计数 + 选中项名字 + ✕ 取消）
 *   · 操作都是"针对当前上下文"的（清除 = 取消选中，也就等于关掉这条菜单条）
 * 形态选 find-bar（细条 + join 按钮组 + 计数）而不是 daisyUI 的 alert：
 * alert 的语义是"消息"（role=alert + 彩色块），当工具栏会喧宾夺主，读屏还会当通知播报。
 */
function DynamicBar(props: {
    /** 选中的是什么（节点名 / 变量路径） */
    label: string;
    count: number;
    index: number;
    onPrev: () => void;
    onNext: () => void;
    onClear: () => void;
}) {
    return (
        // 底色与"标注色"同系（高亮用 warning）→ 一眼看出这条菜单条是给高亮用的；
        // 将来别的动态菜单条换别的色系即可互相区隔
        <div class="flex shrink-0 items-center gap-2 border-b border-warning/30 bg-warning/15 px-2 py-0.5 text-[11px]">
            <span class="join join-horizontal">
                <button
                    class="btn btn-xs join-item"
                    title="上一个（Shift+↑）"
                    disabled={props.count === 0}
                    onClick={props.onPrev}
                >
                    ↑
                </button>
                <button
                    class="btn btn-xs join-item"
                    title="下一个（Shift+↓）"
                    disabled={props.count === 0}
                    onClick={props.onNext}
                >
                    ↓
                </button>
            </span>
            <span class="badge badge-xs badge-ghost font-mono" title="第几个 / 共几个">
                {`${props.index + 1}/${props.count}`}
            </span>
            <span class="truncate font-mono opacity-70" title={props.label}>
                {props.label}
            </span>
            <button class="btn btn-xs btn-ghost ml-auto" title="清除高亮" onClick={props.onClear}>
                ✕
            </button>
        </div>
    );
}

/** 字节数格式化（模版结构树用） */
function fmtBytes(n: number): string {
    if (n < 1024) return `${n} B`;
    return `${(n / 1024).toFixed(1)} KB`;
}


/**
 * 变量定义 view 的一行（名字 + 说明）
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
 * 模版结构树（table-tree，4 列）：**节点 | 参数 | 值 | 字节**。
 * 「参数」= 模版里写的（表达式/relpath/字面量），「值」= 求值后的结果 —— 这样
 * `:if-not(.f.isFirst)` 为什么进/不进，一眼能对着参数与值看明白（原因放 hover）。
 */
function TraceRows(props: {
    nodes: TraceNode[];
    depth: number;
    path: string;
    /** 本层节点所属模版（顶层是 _system.md；进入 include 的子节点后换成被调模版） */
    file: string;
    /** 当前选中的 key 链（画选中态） */
    pickedKey?: string;
    onPick: (n: TraceNode, file: string, key: string) => void;
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
                // include 的子节点属于**被调模版**（源码区间相对那份 body）
                const childFile = () => (n.kind === "include" && n.arg ? n.arg.replace(/^\.\//, "") : props.file);
                return (
                    <>
                        <tr
                            // 选中行必须自己给 hover 色：否则 hover 的 bg 会盖掉选中背景，
                            // 看起来"选中的行"和"随便划过的行"一个样（曾因此误判选中没生效）
                            class={`cursor-pointer ${
                                props.pickedKey === key
                                    ? "bg-primary/25 hover:bg-primary/40"
                                    : "hover:bg-base-300/40"
                            } ${skipped() ? "opacity-40" : ""}`}
                            onClick={() => props.onPick(n, props.file, key)}
                            title="点一下：高亮模版里这段源码与预览里这段产出"
                        >
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
                                file={childFile()}
                                pickedKey={props.pickedKey}
                                onPick={props.onPick}
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
    /** 点行 → 定位（普通行 = 该变量的所有出现处；`[i]` 行 = 第 i 次迭代的产出） */
    onPick: (sel: { kind: "var"; path: string } | { kind: "iter"; arrayPath: string; index: number }) => void;
    /** 当前选中的行标识（只亮一行） */
    picked?: string;
    open: Record<string, boolean>;
    onToggle: (k: string, open: boolean) => void;
    depth: number;
}) {
    return (
        <For each={props.nodes}>
            {(n, i) => {
                const key = `${props.path}/${i()}`;
                const isIndex = /^\[\d+\]$/.test(n.name);
                const full = () => (props.path ? `${props.path}.${n.name}` : n.name);
                const selKey = () =>
                    isIndex ? `iter:${props.path}:${n.name}` : `var:${props.path || n.name}`;
                const kids = () => n.children ?? [];
                const hasKids = () => kids().length > 0;
                const isOpen = () => props.open[key] ?? true;
                return (
                    <>
                        <tr
                            class={`cursor-pointer ${
                                props.picked === selKey()
                                    ? "bg-primary/25 hover:bg-primary/40"
                                    : "hover:bg-base-300/40"
                            }`}
                            title={
                                isIndex
                                    ? `点一下：定位到第 ${n.name.slice(1, -1)} 次迭代的产出`
                                    : `点一下：高亮 ${props.path || n.name} 的所有出现处`
                            }
                            onClick={() =>
                                props.onPick(
                                    isIndex
                                        ? { kind: "iter", arrayPath: props.path, index: Number(n.name.slice(1, -1)) }
                                        : { kind: "var", path: props.path || n.name },
                                )
                            }
                        >
                            <td class="py-0.5 pr-1 align-top">
                                <span
                                    class="flex items-center gap-1 overflow-hidden whitespace-nowrap"
                                    style={{ "padding-left": `${props.depth * 10}px` }}
                                >
                                    <button
                                        class="w-3 shrink-0 text-left opacity-60 disabled:opacity-20"
                                        disabled={!hasKids()}
                                        onClick={(e) => {
                                            e.stopPropagation(); // 别连带把这一行也选中了
                                            if (hasKids()) props.onToggle(key, isOpen());
                                        }}
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
                                onPick={props.onPick}
                                picked={props.picked}
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
    /** 元素类型行：这个数组的 item 类型在模版里被用到没有（决定蓝点） */
    usedItem: (arrayPath: string) => boolean;
    /** 点整行（任意列）→ 高亮它的所有出现处；元素类型行是独立的一种选择 */
    onPick: (sel: { kind: "var"; path: string } | { kind: "item"; arrayPath: string; elName: string }) => void;
    /** 当前选中的行（`var:chain` / `item:chain:[ChainEntry]`）——只亮一行 */
    picked?: string;
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
                // 选中标识：元素行与它所属的数组行**必须不同**（否则一次点击两行同时亮）
                const selKey = () => (isElement ? `item:${props.path}:${n.name}` : `var:${full()}`);
                const kids = () => n.children ?? [];
                const hasKids = () => kids().length > 0;
                const isOpen = () => props.open[key] ?? true; // 树不大 → 默认全展开
                return (
                    <>
                        <tr
                            class={`cursor-pointer ${
                                props.picked === selKey()
                                    ? "bg-primary/25 hover:bg-primary/40"
                                    : "hover:bg-base-300/40"
                            }`}
                            title={
                                isElement
                                    ? `点一下：高亮用到 ${n.name} 这个元素类型的文本`
                                    : `点一下：高亮 ${full()} 的所有出现处`
                            }
                            onClick={() =>
                                props.onPick(
                                    isElement
                                        ? { kind: "item", arrayPath: props.path, elName: n.name }
                                        : { kind: "var", path: full() },
                                )
                            }
                        >
                            {/* 单行不换行：table-fixed + truncate + title（完整信息靠 hover，不撑高行高、不出横向滚动条） */}
                            <td class="py-0.5 pr-2 align-top">
                                <span
                                    class="flex items-center gap-1 overflow-hidden whitespace-nowrap"
                                    style={{ "padding-left": `${props.depth * 10}px` }}
                                >
                                    <button
                                        class="w-3 shrink-0 text-left opacity-60 disabled:opacity-20"
                                        disabled={!hasKids()}
                                        onClick={(e) => {
                                            e.stopPropagation(); // 别连带把这一行也选中了
                                            if (hasKids()) props.onToggle(key, isOpen());
                                        }}
                                    >
                                        {hasKids() ? (isOpen() ? "▾" : "▸") : "·"}
                                    </button>
                                    <Show when={isElement ? props.usedItem(props.path) : props.used(full())}>
                                        <span class="shrink-0 text-info" title="本模版用到了">
                                            ●
                                        </span>
                                    </Show>
                                    <span class="truncate font-mono">{n.name}</span>
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
                                usedItem={props.usedItem}
                                onPick={props.onPick}
                                picked={props.picked}
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

/** 变量定义 view 的分组标题 */
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
    // 目录折叠态（默认全开）
    const [openDirs, setOpenDirs] = createSignal<Record<string, boolean>>({});
    const dirOpen = (path: string) => openDirs()[path] !== false;

    const [mode, setMode] = createSignal<EditorMode>("normal");
    // 任务即场景：taskUri 恒等于当前选中任务，不再手填/跟随/解绑
    const taskUri = () => taskStore.selectedUri ?? "";
    // project 与 main 侧同一个解析函数（shared/task-uri）：两份正则口径不同曾导致
    // 非数字 pid 在 renderer 侧退化成空串 → 覆盖写到 $DIY_HOME/projects/template
    const project = () => projectFromUri(taskUri());
    const hov = useHoverTip();
    const [preview, setPreview] = createSignal<RequestPreview | null>(null);
    // 各 View 折叠态（VSCode 式可收起，纯局部偏好）
    const views = labViews;
    const setViews = setLabViews;
    /**
     * 选中联动（正向：模版结构树 / 变量行 → 模版高亮 + 预览高亮）。
     * 只存"身份"（模版结构树节点的 key 链 / 变量路径），区间每次从**最新** trace 与静态分析里重算：
     * 预览随草稿重算后选区照样跟着走，不会指着过期的偏移。
     */
    const [hlSel, setHlSel] = createSignal<
        | { kind: "node"; key: string; file: string }
        | { kind: "var"; path: string }
        /** 数组的 item 类型行：高亮"用到这个元素类型"的文本（循环体里对它的字段引用） */
        | { kind: "item"; arrayPath: string; elName: string }
        /** 变量值里的 `[i]` 行：定位到"第 i 次迭代的产出"（模版侧仍是循环那一段） */
        | { kind: "iter"; arrayPath: string; index: number }
        | null
    >(null);

    /**
     * key 链（"/2/0"）在最新 trace 里找回节点，并算出**它自己**属于哪份模版。
     * 注意 include 节点自己的 `src` 区间在**调用方**文件里（它只是那句 include 语句）；
     * 只有它的**子节点**才换成被调模版 —— 这里按层记录，别把 include 自己也划过去。
     */
    const resolveNode = (key: string): { node: TraceNode; file: string } | null => {
        let list: TraceNode[] = preview()?.trace ?? [];
        let file = "_system.md";
        let found: { node: TraceNode; file: string } | null = null;
        for (const part of key.split("/").filter((x) => x !== "")) {
            const node = list[Number(part)];
            if (!node) return null;
            found = { node, file };
            list = node.children ?? [];
            if (node.kind === "include" && node.arg) file = node.arg.replace(/^\.\//, "");
        }
        return found;
    };
    const picked = createMemo(() => {
        const cur = hlSel();
        if (!cur || cur.kind !== "node") return null;
        const r = resolveNode(cur.key);
        return r ? { ...r, key: cur.key } : null;
    });

    /**
     * 已知节标签集合：从**各模版正文**自动收集（草稿优先 → 刚写下还没保存的新标签也认）。
     * 编辑器据此给输出侧伪 XML 标签着色；新增 `<diy-new>` 不需要改任何代码。
     */
    const knownTags = createMemo(() => collectTags(entries().map((e) => draftOf(e))));

    /** 该模版当前的正文（草稿优先）——区间是相对它的，行号也必须按它算 */
    const bodyOf = (relpath: string): string => {
        const e = entries().find((x) => x.relpath === relpath);
        return e ? draftOf(e) : "";
    };

    /**
     * item 类型选择 → 相关循环的 `:as` 名。
     * 语义：`chain` 是 array，item 是 ChainEntry；模版里"用到这个 item 类型"的地方
     * 就是**以 chain 为源的那些循环体里对 `.f.value.*` 的引用**（引擎的静态分析给了这些动态路径）。
     */
    const itemAsNames = createMemo<string[]>(() => {
        const cur = hlSel();
        if (cur?.kind !== "item") return [];
        const a = analysis()?.a;
        if (!a) return [];
        const hit = (p: string) => p === cur.arrayPath || p.startsWith(`${cur.arrayPath}.`);
        return [...new Set(a.loops.filter((l) => hit(l.source)).map((l) => l.as))];
    });
    /** 该数组的 item 类型是否被用到（蓝点）：有循环且循环体里出现了 `.as.` 引用 */
    const usedItem = (arrayPath: string): boolean => {
        const a = analysis()?.a;
        if (!a) return false;
        const hit = (p: string) => p === arrayPath || p.startsWith(`${arrayPath}.`);
        const names = a.loops.filter((l) => hit(l.source)).map((l) => l.as);
        if (names.length === 0) return false;
        return a.paths.some((p) => p.scope === "dynamic" && names.some((as) => p.path.startsWith(`.${as}.`) || p.path === `.${as}`));
    };

    /** 模版侧：选中的"这一段"在所属模版里的所有出现处（区间） */
    const hlSrc = createMemo<HlSpan[]>(() => {
        const cur = hlSel();
        if (!cur) return [];
        if (cur.kind === "node") {
            const n = picked()?.node;
            return n?.src ? [n.src] : [];
        }
        const a = analysis()?.a;
        if (!a) return [];
        if (cur.kind === "item") {
            // 循环体里对 `.as.*` 的引用（就是"用到这个 item 类型"的地方）
            const names = itemAsNames();
            return a.paths
                .filter((p) => p.scope === "dynamic" && names.some((as) => p.path.startsWith(`.${as}`)))
                .map((p) => ({ from: p.loc.offset, to: p.end }));
        }
        const path = cur.kind === "iter" ? cur.arrayPath : cur.path; // iter 与 var 同源（循环那段源码）
        const hit = (p: string) => p === path || p.startsWith(`${path}.`);
        const all = [
            ...a.paths.filter((p) => hit(p.path)).map((p) => ({ from: p.loc.offset, to: p.end })),
            ...a.loops.filter((l) => hit(l.source)).map((l) => ({ from: l.loc.offset, to: l.end })),
            ...a.conditions.filter((c) => hit(c.path)).map((c) => ({ from: c.loc.offset, to: c.end })),
        ];
        // `:for={{chain}}` 会同时进 paths（源表达式）与 loops（循环）→ 同一段文本去重，别算两处
        return [...new Map(all.map((r) => [`${r.from}-${r.to}`, r])).values()].sort((x, y) => x.from - y.from);
    });
    /** 预览侧：所有解析它的节点的产出区间 */
    const hlOut = createMemo<HlSpan[]>(() => {
        const cur = hlSel();
        if (!cur) return [];
        if (cur.kind === "node") {
            const out = picked()?.node.out;
            return out && out.to > out.from ? [out] : [];
        }
        const flat: TraceNode[] = [];
        const walk = (ns: TraceNode[]): void => {
            for (const n of ns) {
                flat.push(n);
                walk(n.children ?? []);
            }
        };
        walk(preview()?.trace ?? []);
        if (cur.kind === "iter") {
            // 第 i 次迭代：找 `:for` 节点的第 i 个 for-item，只高亮它的产出
            const hit = (p: string) => p === cur.arrayPath || p.startsWith(`${cur.arrayPath}.`);
            const forNode = flat.find((n) => n.kind === "for" && hit((n.arg ?? "").split(" ")[0]!));
            const item = forNode?.children?.[cur.index];
            return item?.out && item.out.to > item.out.from ? [item.out] : [];
        }
        if (cur.kind === "item") {
            // 预览侧：这些 `.as.*` 引用的产出（就是"用到这个 item 类型"的文本）
            const names = itemAsNames();
            return flat
                .filter(
                    (n) =>
                        n.kind === "interp" &&
                        names.some((as) => (n.arg ?? "").startsWith(`.${as}`)) &&
                        n.out &&
                        n.out.to > n.out.from,
                )
                .map((n) => n.out!);
        }
        const hit = (p: string) => p === cur.path || p.startsWith(`${cur.path}.`);
        return flat
            .filter((n) => {
                const arg = n.kind === "for" ? (n.arg ?? "").split(" ")[0]! : (n.arg ?? "");
                return (
                    (n.kind === "interp" || n.kind === "if" || n.kind === "for") &&
                    hit(arg) &&
                    n.out &&
                    n.out.to > n.out.from
                );
            })
            .map((n) => n.out!);
    });

    /** 焦点：每个编辑器各自一个下标（两侧出现处个数可以不同），换选中就归零 */
    const [focusAt, setFocusAt] = createSignal({ src: 0, out: 0 });
    createEffect(
        on(hlSel, () => {
            setFocusAt({ src: 0, out: 0 });
        }),
    );
    const step = (side: "src" | "out", delta: number, count: number): void => {
        setFocusAt((f) => ({ ...f, [side]: count > 0 ? (f[side] + delta + count) % count : 0 }));
    };

    const hlLabel = createMemo<string | null>(() => {
        const cur = hlSel();
        if (!cur) return null;
        if (cur.kind === "var") return `{{${cur.path}}}`;
        if (cur.kind === "item") return `${cur.elName}（${cur.arrayPath} 的 item）`;
        if (cur.kind === "iter") return `${cur.arrayPath}[${cur.index}]（第 ${cur.index} 次迭代）`;
        const n = picked()?.node;
        return n ? `${n.name ?? n.kind}${n.arg ? ` ${n.arg}` : ""}` : null;
    });

    /** 模版侧高亮（整行）：浅色 = 全部出现处，深色 = 焦点那一处 */
    const srcHl = createMemo<HlLines | null>(() => {
        const occ = hlSrc();
        if (occ.length === 0) return null;
        const file = picked()?.file ?? selPath();
        const text = bodyOf(file);
        const i = Math.min(focusAt().src, occ.length - 1);
        return {
            lines: lineNumbersOf(text, occ),
            focusLines: lineNumbersOf(text, [occ[i]!]),
            focusPos: occ[i]!.from, // 横向也要滚到位（长行不折行）
            focusEnd: occ[i]!.to,
        };
    });
    /** 预览侧高亮（整行）：同上 */
    const outHl = createMemo<HlLines | null>(() => {
        const occ = hlOut();
        if (occ.length === 0) return null;
        const text = preview()?.system ?? "";
        const i = Math.min(focusAt().out, occ.length - 1);
        return {
            lines: lineNumbersOf(text, occ),
            focusLines: lineNumbersOf(text, [occ[i]!]),
            focusPos: occ[i]!.from,
            focusEnd: occ[i]!.to,
        };
    });

    /** 点模版结构树行：切到该节点所属模版（草稿按 project 存，切文件不丢内容），再选中 */
    const pickTrace = (n: TraceNode, file: string, key: string) => {
        if (hlSel()?.kind === "node" && (hlSel() as { key: string }).key === key) {
            setHlSel(null); // 再点一次 = 取消
            return;
        }
        if (file !== selPath() && entries().some((e) => e.relpath === file)) setSelPath(file);
        setHlSel({ kind: "node", key, file });
    };
    /** 变量定义 / 变量值 行的点击（整行）：同一行再点一次 = 取消 */
    const pickVarRow = (
        sel:
            | { kind: "var"; path: string }
            | { kind: "item"; arrayPath: string; elName: string }
            | { kind: "iter"; arrayPath: string; index: number },
    ) => {
        const cur = hlSel();
        const same =
            cur?.kind === sel.kind &&
            JSON.stringify({ ...cur, kind: "" }) === JSON.stringify({ ...sel, kind: "" });
        setHlSel(same ? null : sel);
    };

    // 三张表的列宽（px，可拖可持久化；与容器宽度解耦 → 拖动左栏不改列宽）
    const colsState = (field: CacheField<number[]>): ColsState => {
        const [w, setW] = createSignal(field.get());
        const resize = (i: number, px: number) => {
            const next = [...w()];
            next[i] = Math.min(1200, Math.max(32, px));
            setW(next);
            field.set(next);
        };
        return { w, resize, reset: (i) => resize(i, field.defaultValue[i] ?? 32) };
    };
    const cols = {
        vars: colsState(Caches.diy_lab_cols_vars),
        vals: colsState(Caches.diy_lab_cols_vals),
        trace: colsState(Caches.diy_lab_cols_trace),
    };
    const tableW = (c: ColsState) => `${c.w().reduce((a, b) => a + b, 0)}px`;
    // 模版结构树展开态（key = 路径索引链，默认前两层展开）
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

    // 「变量定义」view 的数据源：对**当前草稿**做静态分析（renderer 侧直接跑引擎 → 随打字实时更新）
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

    /**
     * 全量刷新（debug UI 的主交互：**按需重算**，不订阅外部事件流）。
     * 重新拉：任务树（外部 CLI 可能刚改过）→ 模版列表（覆盖/过期状态）→ 强制重算预览。
     * 不动的：未保存草稿、当前选中模版、高亮选区 —— 选区只存"身份"，预览重算后自动跟着走。
     */
    const [tick, setTick] = createSignal(0);
    const [refreshing, setRefreshing] = createSignal(false);
    async function refresh() {
        if (refreshing()) return;
        setRefreshing(true);
        try {
            taskStore.loadTree();
            await load();
            setTick((n) => n + 1);
        } finally {
            setRefreshing(false);
        }
    }

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
        on([() => draftsByProject(), project, taskUri, entries, tick], () => {
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

    /** 提示词页（子页面）的 page 定义 */
    const LAB_PAGE = findPage("lab")!;
    const CIRCLED = ["①", "②", "③", "④", "⑤", "⑥", "⑦", "⑧"];
    /** 菜单条上的 area 按钮 = 只列本 page 实例下有 view 的 area（空 area 点了没反应） */
    const menuAreas = () => {
        const has = areasWithViews(LAB_PAGE, taskUri(), layoutStore.bindingFor(LAB_PAGE, taskUri()));
        return LAB_PAGE.layout.areas.map((a, idx) => ({ area: a, idx })).filter((x) => has.has(x.area.id));
    };
    /** 右栏 area 内的两个 view 互斥（tab 属于 area，不属于 page）。
     *  落 Caches：area 内 tab 是**用户选择**，切页/重开不该回到默认（模块级 signal 做不到
     *  跨页面卸载保留，且「重置界面状态」要能一起清掉 —— 故走 ui-state 单一入口）。 */
    const [rightTab, setRightTabSig] = createSignal<"system" | "request">(Caches.diy_lab_right_tab.get());
    const setRightTab = (v: "system" | "request") => {
        setRightTabSig(v);
        Caches.diy_lab_right_tab.set(v);
    };

    // 首屏 + 切项目都靠上面那个 createEffect(on(project)) 触发 load()（Solid 首次 flush 即跑）

    /** area → 内容。四个 area 的内容都在本闭包内，共享全部状态（不拆 context） */
    const parts: Record<string, () => JSX.Element> = {
        "lab.inspector": () => (
            <>
<div class="h-full overflow-x-auto overflow-y-auto text-xs p-1 space-y-1">
    <div class="border border-base-300 rounded-lg">
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
    {/* 模版结构树 view：与预览同源的 trace（节点 | 参数 | 值 | 字节） */}
    <div class="border border-base-300 rounded-lg">
        {viewHeader(
            "trace",
            "模版结构树",
            preview()?.trace ? `${preview()!.trace!.length} 顶层节点` : "随预览重算",
        )}
        <Show when={views()["trace"]}>
            <div class="overflow-x-auto bg-base-200 px-0 py-1 text-[11px]">
                <Show when={preview()?.trace} fallback={<div class="px-2 py-1 opacity-60">渲染中…</div>}>
                    {(tr) => (
                        <table class="table table-xs table-fixed" style={{ width: tableW(cols.trace) }}>
                            <colgroup>
                                <For each={cols.trace.w()}>
                                    {(w) => <col style={{ width: `${w}px` }} />}
                                </For>
                            </colgroup>
                            <thead>
                                <tr>
                                    <Th label="节点" cols={cols.trace} index={0} />
                                    <Th label="参数" cols={cols.trace} index={1} />
                                    <Th label="值" cols={cols.trace} index={2} />
                                    <Th label="字节" cols={cols.trace} index={3} right />
                                </tr>
                            </thead>
                            <tbody>
                                <TraceRows
                                    nodes={tr()!}
                                    depth={0}
                                    path=""
                                    file="_system.md"
                                    pickedKey={hlSel()?.kind === "node" ? (hlSel() as { key: string }).key : undefined}
                                    onPick={pickTrace}
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

    {/* 变量定义 view：本模版引用的变量/循环/条件/include + lint（renderer 侧实时分析草稿） */}
    <div class="border border-base-300 rounded-lg">
        {viewHeader("vars", "变量定义", sel() ? sel()!.relpath : "未选模版")}
        <Show when={views()["vars"]}>
            <div class="bg-base-300/40 px-2 py-0.5 text-[10px] opacity-70">
                <span class="text-info">●</span> = 本模版用到；点整行 = 高亮它的所有出现处；点
                <span class="font-mono">[类型]</span> 行 = 高亮用到该类型的文本
            </div>
        </Show>
        <Show when={views()["vars"]}>
            <div class="overflow-x-auto bg-base-200 px-0 py-1 font-mono text-[11px]">
                <Show when={analysis()} fallback={<div class="px-2 py-1 opacity-60">左侧点开一份模版</div>}>
                    {(an) => (
                        <Show when={an().a} fallback={<div class="px-2 py-1 text-error">{an().error}</div>}>
                            {(a) => (
                                <>
                                    <VarGroup title="宿主提供（变量契约，树形展开）">
                                        {/* 列宽固定（px，可拖）：拖动左栏不改列宽；表更宽时左栏横向滚动 */}
                                        <table class="table table-xs table-fixed" style={{ width: tableW(cols.vars) }}>
                                            <colgroup>
                                                <For each={cols.vars.w()}>
                                                    {(w) => <col style={{ width: `${w}px` }} />}
                                                </For>
                                            </colgroup>
                                            <thead>
                                                <tr>
                                                    <Th label="变量" cols={cols.vars} index={0} />
                                                    <Th label="说明" cols={cols.vars} index={1} />
                                                </tr>
                                            </thead>
                                            <tbody>
                                                <VarTree
                                                    nodes={VAR_TREE}
                                                    path=""
                                                    onPick={pickVarRow}
                                                    usedItem={usedItem}
                                                    picked={(() => {
                                                        const cur = hlSel();
                                                        if (cur?.kind === "var") return `var:${cur.path}`;
                                                        if (cur?.kind === "item")
                                                            return `item:${cur.arrayPath}:${cur.elName}`;
                                                        return undefined;
                                                    })()}
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
    <div class="border border-base-300 rounded-lg">
        {viewHeader("vals", "变量值", "本次注入的实际值（随任务变化）")}
        <Show when={views()["vals"]}>
            <div class="overflow-x-auto bg-base-200 px-0 py-1 text-[11px]">
                <Show
                    when={preview()}
                    fallback={<div class="px-2 py-1 opacity-60">渲染中…</div>}
                >
                    <table class="table table-xs table-fixed" style={{ width: tableW(cols.vals) }}>
                        <colgroup>
                            <For each={cols.vals.w()}>
                                {(w) => <col style={{ width: `${w}px` }} />}
                            </For>
                        </colgroup>
                        <thead>
                            <tr>
                                <Th label="变量" cols={cols.vals} index={0} />
                                <Th label="值" cols={cols.vals} index={1} />
                            </tr>
                        </thead>
                        <tbody>
                            <ValueTree
                                nodes={valueTree()}
                                path=""
                                onPick={pickVarRow}
                                picked={(() => {
                                    const cur = hlSel();
                                    if (cur?.kind === "var") return `var:${cur.path}`;
                                    if (cur?.kind === "iter")
                                        return `iter:${cur.arrayPath}:[${cur.index}]`;
                                    return undefined;
                                })()}
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
</div>
            </>
        ),
        "lab.editor": () => (
            <>
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
                        <EditorThemePicker />
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
                                <Show when={hlLabel() && hlSrc().length > 0}>
                                    <DynamicBar
                                        label={hlLabel()!}
                                        count={hlSrc().length}
                                        index={Math.min(focusAt().src, Math.max(0, hlSrc().length - 1))}
                                        onPrev={() => step("src", -1, hlSrc().length)}
                                        onNext={() => step("src", 1, hlSrc().length)}
                                        onClear={() => setHlSel(null)}
                                    />
                                </Show>
                                <MdEditor
                                    value={draftOf(s())}
                                    editable={!s().locked}
                                    onChange={(v) => patchDrafts(project(), (d) => ({ ...d, [s().relpath]: v }))}
                                    highlight={
                                        (picked()?.file ?? selPath()) === s().relpath ? srcHl() : null
                                    }
                                    tags={knownTags()}
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
            </>
        ),
        "lab.system": () => (
            <div class="flex flex-col h-full min-h-0">
                {/* 右栏 area 内两个 view 互斥（tab 属于 area，不属于 page） */}
                <div class="flex items-center gap-1 border-b px-2 py-1 text-xs shrink-0">
                    <button
                        class={`btn btn-xs ${rightTab() === "system" ? "btn-active" : "btn-ghost"}`}
                        aria-pressed={rightTab() === "system"}
                        onClick={() => setRightTab("system")}
                    >
                        _system.md
                    </button>
                    <button
                        class={`btn btn-xs ${rightTab() === "request" ? "btn-active" : "btn-ghost"}`}
                        aria-pressed={rightTab() === "request"}
                        onClick={() => setRightTab("request")}
                    >
                        请求预览
                    </button>
                </div>
                <div class="flex-1 min-h-0">
                    <Show when={rightTab() === "system"} fallback={parts["lab.request"]?.() as any}>
                        <div class="flex flex-col h-full min-h-0">
{/* 右：视图区 = 一个编辑器 view（与中间完全同构：标题栏 + 编辑器本体，只是只读）。
    结构化观察在左栏；请求体在「请求预览」tab */}
<div class="flex min-h-0 flex-1 flex-col overflow-hidden">
    <div class="flex items-center gap-1 border-b px-3 py-1.5 text-xs shrink-0">
        <span class="font-mono font-semibold">_system.md</span>
        <span class="opacity-50">（预览）</span>
        <span class="ml-auto font-mono text-[10px] opacity-60">
            <Show when={preview()} fallback="渲染中…">
                {(p) => `${(new TextEncoder().encode(p().system).length / 1024).toFixed(1)} KB`}
            </Show>
        </span>
        <EditorThemePicker />
    </div>
    <Show when={hlLabel() && hlOut().length > 0}>
        <DynamicBar
            label={hlLabel()!}
            count={hlOut().length}
            index={Math.min(focusAt().out, Math.max(0, hlOut().length - 1))}
            onPrev={() => step("out", -1, hlOut().length)}
            onNext={() => step("out", 1, hlOut().length)}
            onClear={() => setHlSel(null)}
        />
    </Show>
    <Show when={preview()} fallback={<div class="p-3 text-xs opacity-60">渲染中…</div>}>
        {(p) => (
            <div class="flex min-h-0 flex-1 flex-col">
                <Show when={p().overBudget}>
                    <div class="alert alert-error m-2 shrink-0 text-xs py-1">
                        超出预算：{(p().overBudget!.used / 1024).toFixed(1)} KB /{" "}
                        {(p().overBudget!.budget / 1024).toFixed(0)} KB —— 不会发送，请精简模版
                    </div>
                </Show>
                <Show when={p().warnings.length > 0}>
                    <div class="alert alert-warning m-2 shrink-0 text-xs py-1">
                        {p().warnings.map((w) => (
                            <span>⚠️ {w}</span>
                        ))}
                    </div>
                </Show>
                <div class="min-h-0 flex-1">
                    <MdEditor
                        value={p().system}
                        editable={false}
                        onChange={() => {}}
                        highlight={outHl()}
                        tags={knownTags()}
                    />
                </div>
            </div>
        )}
    </Show>
</div>
                        </div>
                    </Show>
                </div>
            </div>
        ),
        "lab.request": () => (
            <div class="flex flex-col h-full min-h-0">
<div class="flex shrink-0 items-center gap-2 border-b px-3 py-1.5 text-xs">
    <span class="text-[11px] font-bold tracking-widest opacity-70">请求预览</span>
    <span class="opacity-60">{preview()?.requestNote ?? "随任务场景生成"}</span>
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
<div class="min-h-0 flex-1 overflow-auto bg-base-200 p-2">
    <Show when={preview()?.requestBody} fallback={<div class="text-xs opacity-60">随任务场景生成…</div>}>
        {(b) => (
            <>
                {/* 树常驻（hidden 藏），切原文不卸载 → 折叠态保留 */}
                <div classList={{ hidden: reqMode() !== "tree" }}>
                    <JsonTree data={b()} />
                </div>
                <Show when={reqMode() === "raw"}>
                    <pre class="whitespace-pre-wrap break-all rounded bg-base-200 p-2 font-mono text-[11px] leading-relaxed">
                        {JSON.stringify(b(), null, 1)}
                    </pre>
                </Show>
            </>
        )}
    </Show>
</div>
            </div>
        ),
    };

    return (
        <div class="flex flex-col h-full overflow-hidden">
            {hov.node()}
            <Show
                when={!!taskUri()}
                fallback={
                    <div class="flex flex-1 flex-col items-center justify-center gap-3 text-sm opacity-70">
                        <div>提示词页以当前任务为场景，请先从任务管理页打开一个任务</div>
                    </div>
                }
            >
                {/* 顶：page 菜单条（任务即场景 + 刷新 + area 开合按钮） */}
                <div class="flex items-center gap-2 border-b px-3 py-1.5 text-xs shrink-0">
                    <span class="badge badge-info badge-sm" title={taskUri()}>
                        📌 {taskUri()}
                    </span>
                    <button
                        class="btn btn-xs btn-ghost"
                        title="重新拉取：模版列表（覆盖与过期状态）/ 预览。未保存草稿与选中项保留"
                        disabled={refreshing()}
                        onClick={() => void refresh()}
                    >
                        {refreshing() ? "⟳ 刷新中…" : "⟳ 刷新"}
                    </button>
                    <span class="opacity-60">
                        {entries().filter((e) => e.status === "overridden").length} 份覆盖
                        <Show when={entries().some((e) => dirtyOf(e))}>
                            <span class="text-info font-semibold">
                                {" "}· {entries().filter((e) => dirtyOf(e)).length} 未保存
                            </span>
                        </Show>
                    </span>
                    <div class="flex-1" />
                    {/* 布局按钮：只给有 view 的 area（空 area 点了没反应，见 menuAreas） */}
                    <For each={menuAreas()}>
                        {({ area, idx }) => (
                            <button
                                class={`btn btn-xs ${layoutStore.isHidden("lab", area.id) ? "btn-ghost opacity-50" : "btn-active"}`}
                                title={`${area.id}（区域 ${idx + 1}）开合`}
                                aria-pressed={!layoutStore.isHidden("lab", area.id)}
                                onClick={() => layoutStore.toggleArea("lab", area.id)}
                            >
                                {CIRCLED[idx] ?? idx + 1} {area.id}
                            </button>
                        )}
                    </For>
                </div>

                <div class="flex-1 min-h-0">
                    <ViewGrid
                        pageId="lab"
                        ctx={taskUri()}
                        layout={LAB_PAGE.layout}
                        binding={layoutStore.bindingFor(LAB_PAGE, taskUri())}
                        renderView={(viewId) => parts[viewId]?.() ?? <div class="p-3 text-xs opacity-60">未注册的 view: {viewId}</div>}
                    />
                </div>
            </Show>
        </div>
    );
}

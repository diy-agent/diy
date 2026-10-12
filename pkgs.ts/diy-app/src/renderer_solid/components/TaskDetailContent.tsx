/**
 * TaskDetailContent — 任务的**三块内容**：任务属性 / 任务父子关系树 / 任务内容（正文）。
 *
 * 一处实现，三处复用（容器宽度差得远，靠容器查询自适应，见 index.css 的 .task-flow）：
 *   1. 任务执行页左栏（~300px）    → 顺序一列
 *   2. nav 悬停任务项的覆盖层（320）→ 顺序一列
 *   3. 任务管理详情面板（默认 560px）→ 两列：属性 / 树在左列，正文独占右列
 *
 * **布局是「容器自适应」，不是「页面各自的 layout」**（这点与 ViewGrid 刻意不同）：
 * ViewGrid 管的是 page 的固定网格（track 声明式 + 拖线），而这里两块容器宽度差一倍以上，
 * 且都嵌在别的容器里（分栏 area / 抽屉面板），注册成 page layout 反而要在两处各配一套。
 * 故三块 view 只声明「在左还是在右」，容器按自己的实测宽度决定一列还是两列：
 *   - 窄（<480px）：全部顺序排一列 —— 分栏左栏只有 ~276px，两列会挤成两条缝
 *   - 宽（>=480px）：左列固定宽（用户可拖 `.task-flow-handle`，落视图 cache），正文吃剩余
 *
 * 为什么不做成三个注册 view：注册 view 的几何由 ViewGrid 的 track 决定（固定网格 +
 * 拖线），而这里要的是**跟容器宽度自适应**的流式排布。三块各自可折叠（默认全展开），
 * 折叠态是模块级信号（同 PromptLabV4Page 的 labViews 思路）。
 *
 * **数据自取**（不听全局 selectedTask 单例）：同一个组件可以同时有多个实例
 * （悬停覆盖层 + 执行页左栏 + 管理页详情面板），全局单例只有一份值，会让别的实例
 * 永远卡在「加载中…」（这个坑在本文件的前身 TaskSideView 里踩过）。
 */
import { createSignal, createEffect, on, onMount, onCleanup, For, Show, type JSX } from "solid-js";
import { Portal } from "solid-js/web";
import { taskStore, type TaskDetail, type TreeNode } from "../store/taskStore";
import { tabStore } from "../store/tabStore";
import { personaStore } from "../store/personaStore";
import { draftStore } from "../store/draftStore";
import { editTask } from "../lib/task-edit";
import { diyService } from "../lib/rpc";
import { getRendererActions } from "../lib/renderer-actions";
import { lineageRows } from "../lib/task-lineage";
import { notificationStore } from "../store/notificationStore";
import { Caches, TASK_DETAIL_LEFT_MIN, TASK_DETAIL_LEFT_MAX } from "../lib/ui-state";
import { MarkdownView } from "./MarkdownView";
import { CodeBlock } from "./CodeBlock";
import { StateSelect, TaskFieldSelect, TaskModuleInput } from "./TaskFieldControls";
import { taskStateColor } from "../../main/core/task-state";

/** 两列布局下正文的最小宽度（px）：拖左列时不许把正文压到比这更窄 */
const BODY_MIN_W = 160;

/**
 * 各块的展开态（模块级，默认全展开）。
 * 模块级而非组件内：同一个块会在多个实例里出现，折叠是「这类内容要不要看」的
 * 全局偏好，不该每开一个面板就变回默认。
 */
const [blocks, setBlocks] = createSignal<Record<string, boolean>>({ attrs: true, lineage: true, body: true });
const blockOpen = (k: string) => blocks()[k] !== false;

/** 折叠框（VSCode 式：标题条整条可点，▾/▸ 指示） */
function Block(props: { k: string; title: string; extra?: string; children: JSX.Element }) {
    return (
        <section class="border border-base-300 rounded-lg overflow-hidden min-w-0">
            <button
                class="flex w-full items-center gap-1 bg-base-300 px-2 py-1 text-body font-bold tracking-wide opacity-80 hover:opacity-100"
                aria-expanded={blockOpen(props.k)}
                onClick={() => setBlocks((v) => ({ ...v, [props.k]: !blockOpen(props.k) }))}
            >
                <span>{blockOpen(props.k) ? "▾" : "▸"}</span>
                <span>{props.title}</span>
                <Show when={props.extra}>
                    <span class="ml-auto font-mono font-normal opacity-70">{props.extra}</span>
                </Show>
            </button>
            <Show when={blockOpen(props.k)}>
                <div class="p-2 min-w-0">{props.children}</div>
            </Show>
        </section>
    );
}

/** 打开任务 = 任务管理内选中它、看它的详情，并**带动下面任务表展开定位**（reveal，##160 机制）。 */
function openTask(uri: string): void {
    void taskStore.selectTask(uri);
    getRendererActions().navigate?.("task");
    getRendererActions().revealTask?.(uri);
}

/** 打开对话 = nav 上点任务项那个动作（开/聚焦任务执行页 tab） */
function openChat(uri: string): void {
    getRendererActions().openTaskRun?.(uri);
}

/** 在任务树里找节点及其直接父标题（管理面板 hover 信息卡的数据源） */
function findNodeInfo(
    nodes: readonly TreeNode[],
    uri: string,
    parentTitle?: string,
): { node: TreeNode; parentTitle?: string } | null {
    for (const n of nodes ?? []) {
        if (n.kind === "task" && n.uri === uri) return { node: n, parentTitle };
        const f = findNodeInfo(n.children ?? [], uri, n.kind === "task" ? (n.title ?? n.uri) : parentTitle);
        if (f) return f;
    }
    return null;
}

/**
 * 任务名链接。
 *
 * **不用 daisyUI 的 `tooltip`/`data-tip`**：它的提示是挂在元素上的 `::before` 伪元素，
 * 会被祖先的 `overflow-hidden/auto` 裁掉 —— 树块处在「可滚动详情区 + 分栏 area」里，
 * 靠底部的行提示直接被下边界切掉一半（不是 daisyUI 的 bug，是 CSS 裁剪的必然结果，
 * 项目里 `promptLabCommon.tsx` 的 useHoverTip 早就为此另建了方案）。
 * 这里同样改用 **viewport fixed 浮层**（Portal 到 body）：悬停即显、永不被裁。
 *
 * 位置用 `getBoundingClientRect` 现算，向上翻转的条件是「下方放不下」——
 * 最底部那些行因此把提示显示在上方，不再贴着 view 边界被吃掉。
 */
function TaskNameLink(props: {
    uri: string;
    label: string;
    class?: string;
    preview?: boolean;
    /** 该任务的对话是否已打开（打开态由调用方从 tabStore 现查） */
    chatOpen?: boolean;
    /** 长标题换行显示全（详情面板标题用，188①）；缺省单行 truncate（树内嵌入场景） */
    wrap?: boolean;
    /**
     * 字号档（RV-02，##245 review）：title = 14px（详情面板主标题，E 节语义档
     * 「title 14px = 详情 h3」）；缺省 body = 11px（树内行级链接）。
     * 原模板硬编码 text-body，压过外层 h3.text-title → 显示 11px、编辑态 14px 跳变。
     */
    size?: "body" | "title";
    /** 点击语义：task = 去任务管理看详情（缺省）；chat = 打开/切换对话（血缘树，C-2 调换） */
    act?: "task" | "chat";
}) {
    const [tip, setTip] = createSignal<{ x: number; y: number; up: boolean } | null>(null);

    const showTip = (el: HTMLElement) => {
        const r = el.getBoundingClientRect();
        const up = r.bottom + 44 > window.innerHeight; // 下方放不下 → 向上翻
        setTip({ x: Math.round(r.left), y: Math.round(up ? r.top - 6 : r.bottom + 6), up });
    };

    return (
        <>
            <button
                class={`${props.size === "title" ? "text-title" : "text-body"} ${props.class ?? ""} diy-link block w-full text-left underline-offset-2 hover:underline cursor-pointer ${
                    props.wrap ? "whitespace-normal" : "truncate"
                } ${props.chatOpen ? "font-semibold" : ""}`}
                data-task-hover-uri={props.preview ? props.uri : undefined}
                onMouseEnter={(e) => showTip(e.currentTarget)}
                onMouseLeave={() => setTip(null)}
                onClick={(e) => {
                    e.stopPropagation();
                    /* C-2（改 ##183 的既定交互）：血缘树点标题 = 打开对话 ——
                       用户在树里点标题的意图几乎都是「进这个任务的会话」，
                       原「去任务管理」常点错，真正的任务管理入口交给行内按钮。 */
                    if (props.act === "chat") openChat(props.uri);
                    else openTask(props.uri);
                }}
            >
                {props.label}
            </button>
            <Show when={tip()}>
                {(t) => (
                    <Portal>
                        <div
                            class="pointer-events-none fixed z-[100] w-max max-w-64 rounded bg-neutral px-2 py-1 text-body leading-relaxed text-neutral-content shadow-lg"
                            style={{
                                left: `${Math.min(t().x, Math.max(8, window.innerWidth - 268))}px`,
                                top: `${t().up ? t().y : t().y}px`,
                                transform: t().up ? "translateY(-100%)" : undefined,
                            }}
                        >
                            {props.act === "chat"
                                ? props.chatOpen
                                    ? "已在对话中打开 · 点击切换到对话"
                                    : "打开对话（就近）"
                                : "在任务管理中查看 · 展开任务表定位"}
                        </div>
                    </Portal>
                )}
            </Show>
        </>
    );
}

// ═══════════════════════════════════════════
// 块 1：任务属性（标题 / 状态 / 分类字段 / 元信息）
// ═══════════════════════════════════════════
function AttrsBlock(props: { uri: string; task: TaskDetail; refresh: () => Promise<void> }) {
    // 草稿恢复规则：有 title 草稿即视为编辑中（与旧 TaskInfoView 同思路）。
    // 按**字段**问，不问「有没有草稿」—— agent 输入框的草稿与这里毫无关系。
    const d = draftStore.fieldsOf(props.uri);
    const [editing, setEditing] = createSignal(draftStore.hasAny(props.uri, ["title"]));
    const [titleDraft, setTitleDraft] = createSignal(d.title ?? props.task.title ?? "");
    const [saving, setSaving] = createSignal(false);
    // 人物/模型清单：本视图在会话页之外也会被渲染（详情抽屉、悬停覆盖层、试验场任务 tab），
    // 故在此按需加载，不依赖会话页先打开过。
    onMount(() => void personaStore.load());

    const onInput = (v: string) => {
        setTitleDraft(v);
        draftStore.set(props.uri, "title", v); // 逐键写内存 + 防抖落盘
    };

    const startEdit = () => {
        setTitleDraft(draftStore.fieldsOf(props.uri).title ?? props.task.title ?? "");
        setEditing(true);
    };
    const cancelEdit = async () => {
        setEditing(false);
        await draftStore.clear(props.uri, ["title"]);
    };

    const save = async () => {
        setSaving(true);
        try {
            if (titleDraft() !== (props.task.title ?? "")) {
                await editTask(props.uri, { title: titleDraft() });
                await draftStore.clear(props.uri, ["title"]);
                await props.refresh();
            } else {
                // 无改动也算「本次编辑结束」：草稿没有存在意义了
                await draftStore.clear(props.uri, ["title"]);
            }
            setEditing(false);
        } catch (err: any) {
            // 保存失败必须出声：校验拒绝（标题为空等）只 console.error 的话，
            // 用户看到的是「点了保存没反应」，无从判断原因
            console.error("[TaskDetailContent] save title failed:", err);
            notificationStore.addToast("error", `保存失败: ${err?.message ?? String(err)}`);
        } finally {
            setSaving(false);
        }
    };

    /** 改状态 / 分类字段：不进编辑态，改完即存 */
    const savePatch = async (patch: Record<string, string>) => {
        setSaving(true);
        try {
            await editTask(props.uri, patch);
            await props.refresh();
        } catch (err: any) {
            notificationStore.addToast("error", `保存失败: ${err?.message ?? String(err)}`);
        } finally {
            setSaving(false);
        }
    };

    return (
        <div class="space-y-3">
            <div class="task-field-row">
                <span class="task-field-label text-body opacity-50">标题</span>
                <div class="flex min-w-0 items-center gap-1">
                    <Show
                        when={editing()}
                        fallback={
                            <h3 class="min-w-0 flex-1 text-title font-bold">
                                <TaskNameLink uri={props.uri} label={props.task.title || props.uri} class="block" wrap size="title" />
                            </h3>
                        }
                    >
                        <input
                            type="text"
                            class="input input-bordered input-sm min-w-0 flex-1 text-title font-bold"
                            value={titleDraft()}
                            onInput={(e) => onInput(e.currentTarget.value)}
                            placeholder="任务标题"
                        />
                    </Show>
                    <Show when={!editing()}>
                        <button class="btn btn-ghost btn-xs shrink-0 opacity-60 hover:opacity-100" title="编辑标题" onClick={startEdit}>
                            ✏️
                        </button>
                    </Show>
                </div>
            </div>

            {/* 字段**逐行**排（不是 flex-wrap 一行塞几个）：
                左列最窄只有 200px，横排会让「模块」这种带输入框的字段把邻居挤没、
                字段名被压到看不见。行内 label 左、控件右（justify-between）—— 
                控件右缘对齐成一条线，扫读时值在哪里是可预期的。 */}
            <div class="flex flex-col gap-1.5">
                <div class="task-field-row">
                    <span class="task-field-label text-body opacity-50">状态</span>
                    <div class="flex min-w-0 items-center gap-1">
                        <StateSelect current={props.task.state} saving={saving()} onSave={(v) => void savePatch({ state: v })} />
                        <Show when={editing()}>
                            <button class="btn btn-primary btn-xs" onClick={save} disabled={saving()}>
                                {saving() ? <span class="loading loading-spinner loading-xs"></span> : "💾 保存"}
                            </button>
                            <button class="btn btn-ghost btn-xs" onClick={cancelEdit} disabled={saving()}>
                                取消
                            </button>
                        </Show>
                    </div>
                </div>
                {/* 分类字段：改完即存，表格里那几列就是从这三个字段来的 */}
                <TaskFieldSelect
                    field="change_type"
                    value={props.task.change_type}
                    saving={saving()}
                    onSave={(v) => void savePatch({ change_type: v })}
                />
                <TaskModuleInput value={props.task.module} saving={saving()} onSave={(v) => void savePatch({ module: v })} />
                <TaskFieldSelect
                    field="priority"
                    value={props.task.priority}
                    saving={saving()}
                    onSave={(v) => void savePatch({ priority: v })}
                />
                {/* agent 人物：本任务"由谁干活"（决定模型/参数/行为指令）—— 任务属性，改完即存。
                    这里**只换绑**（续聊，会话一条不动）；改人物本身的模型走 CLI
                    `diy agent persona set`（那是全局的，影响所有引用它的任务）。 */}
                <div class="task-field-row">
                    <span class="task-field-label text-body opacity-50">人物</span>
                    <select
                        class="select select-xs select-bordered min-w-0"
                        disabled={saving() || personaStore.personas.length === 0}
                        value={props.task.persona ?? ""}
                        onChange={async (e) => {
                            const ok = await personaStore.setForTask(
                                props.task.uri,
                                e.currentTarget.value,
                            );
                            if (ok) await props.refresh();
                        }}
                    >
                        {/* 空值 = **跟随缺省**（新建任务的默认状态），不是一个"没设置"的残缺态：
                            选项文案要写出"会跟随谁"，否则用户看到空值会以为配置缺了 */}
                        <option value="">跟随缺省（{personaStore.defaultPersonaName()}）</option>
                        <For each={personaStore.personas}>
                            {(p) => (
                                <option value={p.id} title={`${p.name}（${p.id}）`}>
                                    {p.name} · {personaStore.displayModel(p.model)}
                                </option>
                            )}
                        </For>
                    </select>
                </div>
            </div>

            <div class="flex flex-col gap-1 text-body opacity-60">
                {/* 任务 URI：原在任务执行页 page 菜单条上，A 方案（2026-10-03）移入属性 ——
                    page 条只留页面级入口（提示词/上下文树/area 开合），信息字段归属性面板 */}
                <div class="task-field-row">
                    <span class="task-field-label">URI</span>
                    <span class="min-w-0 truncate font-mono" title={props.uri}>
                        {props.uri}
                    </span>
                </div>
                <Show when={props.task.project}>
                    <div class="task-field-row">
                        <span class="task-field-label">项目</span>
                        <span class="min-w-0 truncate" title={props.task.project_path ?? props.task.project}>
                            📂 {props.task.project_label ?? props.task.project_path ?? props.task.project}
                        </span>
                    </div>
                </Show>
                <Show when={props.task.created}>
                    <div class="task-field-row">
                        <span class="task-field-label">创建时间</span>
                        <span class="min-w-0 truncate">🕐 {new Date(props.task.created!).toLocaleString()}</span>
                    </div>
                </Show>
                <Show when={props.task.updated && props.task.updated !== props.task.created}>
                    <div class="task-field-row">
                        <span class="task-field-label">修改时间</span>
                        <span class="min-w-0 truncate">✏️ {new Date(props.task.updated!).toLocaleString()}</span>
                    </div>
                </Show>
            </div>
        </div>
    );
}

// ═══════════════════════════════════════════
// 块 2：任务树（当前任务所在**根任务的子树**；同级根任务不平铺，当前任务高亮定位）
// ═══════════════════════════════════════════
function LineageBlock(props: { uri: string; hoverPreview?: boolean; host?: "manage" | "chat" }) {
    /** 管理宿主：树点标题 = 就近选中；hover 出「左侧并排信息卡」而非弹覆盖层 */
    const isManage = () => props.host === "manage";
    /** 就近语义：manage 宿主就近 = 去任务管理看它；chat 宿主就近 = 打开它的对话 */
    const act = () => (isManage() ? "task" : "chat") as "task" | "chat";
    /**
     * 管理面板树 hover 的并排信息卡（2026-10-03 用户指令：
     * 「任务管理的任务详情的任务树 hover 附着一个左侧并排的任务信息 view，方便快速对比」）。
     * 贴**面板左缘外侧** fixed —— 面板在屏右，卡在面板左边 = 两个任务同屏并排对比；
     * 不盖面板（覆盖层是「弹走」，这个是「并排」）。移向卡有 250ms 宽限，不会一闪而过。
     */
    const [peek, setPeek] = createSignal<{ uri: string; right: number; top: number } | null>(null);
    let peekTimer: ReturnType<typeof setTimeout> | undefined;
    const cancelPeekClose = () => clearTimeout(peekTimer);
    const schedulePeekClose = () => {
        clearTimeout(peekTimer);
        peekTimer = setTimeout(() => setPeek(null), 250);
    };
    const openPeek = (uri: string, el: HTMLElement) => {
        if (!isManage()) return;
        clearTimeout(peekTimer);
        const panel = el.closest("[data-task-detail-panel]")?.getBoundingClientRect();
        const r = el.getBoundingClientRect();
        if (!panel) return;
        const top = Math.max(8, Math.min(r.top, window.innerHeight - 260));
        setPeek({ uri, right: Math.max(8, window.innerWidth - panel.left + 8), top });
    };
    onCleanup(() => clearTimeout(peekTimer));
    /**
     * 任务树行：树才是父子关系的真相源（URI 路径不表达层级）。
     *
     * 从当前任务所在**根任务** DFS 它自己的子树（根下的兄弟分支自然纳入）；
     * **当前任务本身是顶级时退化为「自己 + 子孙」**，不平铺项目下其余根任务
     * （##258 / R4 收回了 RV-04 的越界）。当前任务标 `current`。见 lib/task-lineage。
     */
    const rows = () => lineageRows(taskStore.nodes, props.uri);
    /**
     * 该任务的对话是否**已经开在导航里**（tabStore.opened 是响应式 getter：
     * 开/关 tab 会立即让这里的圆点与按钮态跟着变，不需要额外订阅）。
     */
    const chatOpen = (uri: string) => !!tabStore.find(`task-run:${uri}`);

    /**
     * 树的内滚动容器。
     *
     * 整树可能很长（本仓 ##87 一系上百个任务）—— 全展开撑爆详情面板会把正文挤到看不到，
     * 故给树自己一个高度上限、内部滚动（##233 的「规模风险」：先全展开 + 定位高亮，
     * 折叠策略后续再谈）。
     */
    let scrollEl: HTMLDivElement | undefined;
    /** 定位到当前任务行：只在它不在可视区时滚（`block:"nearest"`），不无谓打扰 */
    const scrollToCurrent = () => scrollEl?.querySelector("[data-lineage-current]")?.scrollIntoView({ block: "nearest" });

    createEffect(
        on(
            () => props.uri,
            () => {
                // 数据可能还没到（taskStore.nodes 异步加载）：立即滚一次（fallback 行已就位），
                // 稍后再校正一次（整树渲染完，当前行位置可能变）。不用 rAF —— 窗口被遮挡时会被节流。
                setTimeout(scrollToCurrent, 0);
                setTimeout(scrollToCurrent, 250);
            },
        ),
    );

    return (
        <div ref={(el) => (scrollEl = el)} class="flex flex-col max-h-[45vh] overflow-auto">
            <For each={rows()}>
                {(r) => (
                    <div
                        data-lineage-current={r.current ? "1" : undefined}
                        class={`group flex items-center gap-1 rounded px-1 py-0.5 cursor-pointer hover:bg-base-300 ${
                            r.current ? "bg-primary/20 ring-1 ring-primary/30" : ""
                        }`}
                        style={{ "padding-left": `${r.depth * 12 + 4}px` }}
                        title={r.uri}
                        /* 主链接就近（2026-10-03）：管理宿主 = 管理内选中 + 任务表定位；
                           对话宿主 = 打开对话（原行点击硬编码 openTask = 跑去任务管理，是「跑远」） */
                        onClick={() => (isManage() ? openTask(r.uri) : openChat(r.uri))}
                        onMouseEnter={(e) => openPeek(r.uri, e.currentTarget)}
                        onMouseLeave={schedulePeekClose}
                    >
                        <span class={`w-1.5 h-1.5 rounded-full shrink-0 ${taskStateColor(r.state)}`} />
                        <span class="font-mono shrink-0 text-body opacity-60">#{r.num ?? "?"}</span>
                        {/* 「◀ 当前」**紧跟标题**（不是行尾）：它是标题的补语，隔着一个
                            auto margin 飘到右边会读成「这一行整体是当前」。
                            标题 min-w-0 + truncate：长标题只截自己，不吃掉后面的标签。 */}
                        <TaskNameLink
                            uri={r.uri}
                            label={r.title ?? r.uri}
                            class="min-w-0 text-body"
                            act={act()}
                            /* hover 预览（chat 宿主）：只跳过「该任务正是此刻在看的那一个」。
                               manage 宿主不走覆盖层 —— hover 改为「左侧并排信息卡」（下方 Portal）。 */
                            preview={!isManage() && props.hoverPreview && !tabStore.isTaskDisplayed(r.uri)}
                            chatOpen={chatOpen(r.uri)}
                        />
                        {/* 「◀ 当前」标记已删（2026-10-03 用户指令）：当前行的高亮底色 +
                            ring 已经表达了「就是这行」，再加文字是重复信息。 */}
                        {/* 「已打开在对话里」= **单个图标**（2026-10-03 用户指令）：原来是一颗
                            两图标 + 文字的操作按钮，噪音大。**跳转任务管理**的入口已从树里删掉、
                            统一收在「任务详情」view 的 bar 上（见 TaskSideView），故这里只留
                            状态指示：已打开显示 💬，未打开不显示任何图标。 */}
                        <Show when={chatOpen(r.uri)}>
                            <span class="ml-auto shrink-0 text-body" title="已在对话中打开">💬</span>
                        </Show>
                    </div>
                )}
            </For>
            {/* 管理面板树 hover 的并排信息卡：fixed 在面板左缘外（与面板并排、可同屏对比） */}
            <Show when={peek()}>
                {(pk) => {
                    const info = () => findNodeInfo(taskStore.nodes, pk().uri);
                    return (
                        <Portal>
                            <div
                                class="fixed z-[150] w-72 rounded-box border border-base-300 bg-base-100 p-3 shadow-xl"
                                style={{ right: `${pk().right}px`, top: `${pk().top}px` }}
                                data-find-skip
                                onMouseEnter={cancelPeekClose}
                                onMouseLeave={schedulePeekClose}
                            >
                                <Show when={info()} fallback={<div class="text-body opacity-60">加载中…</div>}>
                                    {(f) => (
                                        <div class="flex flex-col gap-1.5 text-body min-w-0">
                                            <div class="flex items-baseline gap-1.5 min-w-0">
                                                <span class="font-mono opacity-60 shrink-0">#{f().node.num ?? "?"}</span>
                                                <span class="font-semibold min-w-0 break-all">{f().node.title ?? f().node.uri}</span>
                                            </div>
                                            <div class="flex items-center gap-1.5 opacity-70">
                                                <span
                                                    class={`w-2 h-2 rounded-full inline-block ${taskStateColor(f().node.state)}`}
                                                />
                                                <span>{f().node.state ?? "—"}</span>
                                            </div>
                                            <Show when={f().parentTitle}>
                                                <div class="min-w-0 opacity-70">
                                                    父级：<span class="min-w-0 break-all">{f().parentTitle}</span>
                                                </div>
                                            </Show>
                                            <Show when={f().node.created}>
                                                <div class="opacity-60">🕐 {new Date(f().node.created!).toLocaleString()}</div>
                                            </Show>
                                            <Show when={f().node.updated && f().node.updated !== f().node.created}>
                                                <div class="opacity-60">✏️ {new Date(f().node.updated!).toLocaleString()}</div>
                                            </Show>
                                            <Show when={f().node.body}>
                                                <div class="opacity-50 border-t border-base-300 pt-1.5 line-clamp-4 whitespace-pre-wrap break-all">
                                                    {f().node.body}
                                                </div>
                                            </Show>
                                            <div class="opacity-40 text-caption">并排对比 · 点标题=就近操作</div>
                                        </div>
                                    )}
                                </Show>
                            </div>
                        </Portal>
                    );
                }}
            </Show>
        </div>
    );
}

// ═══════════════════════════════════════════
// 块 3：任务内容（正文）
// ═══════════════════════════════════════════
function BodyBlock(props: { uri: string; task: TaskDetail; refresh: () => Promise<void> }) {
    /** 渲染模式：Markdown 富文本 / 原文。纯视图偏好，不落盘（丢了大不了回到默认） */
    const [tab, setTab] = createSignal<"md" | "raw">("md");
    const d = draftStore.fieldsOf(props.uri);
    const [editing, setEditing] = createSignal(draftStore.hasAny(props.uri, ["body"]));
    const [draft, setDraft] = createSignal(d.body ?? props.task.body ?? "");
    const [saving, setSaving] = createSignal(false);

    const onInput = (v: string) => {
        setDraft(v);
        draftStore.set(props.uri, "body", v);
    };
    const startEdit = () => {
        setDraft(draftStore.fieldsOf(props.uri).body ?? props.task.body ?? "");
        setEditing(true);
    };
    const cancelEdit = async () => {
        setEditing(false);
        await draftStore.clear(props.uri, ["body"]);
    };
    const save = async () => {
        setSaving(true);
        try {
            if (draft() !== (props.task.body ?? "")) {
                await editTask(props.uri, { body: draft() });
                await draftStore.clear(props.uri, ["body"]);
                await props.refresh();
            } else {
                await draftStore.clear(props.uri, ["body"]);
            }
            setEditing(false);
        } catch (err: any) {
            console.error("[TaskDetailContent] save body failed:", err);
            notificationStore.addToast("error", `保存失败: ${err?.message ?? String(err)}`);
        } finally {
            setSaving(false);
        }
    };

    return (
        <div class="min-w-0">
            <Show
                when={editing()}
                fallback={
                    <div class="flex items-center gap-2 mb-2">
                        <Show when={props.task.body}>
                            {/* Markdown / 原文不是两份内容，只是**渲染开关**，故用二选一按钮组 */}
                            <div class="join">
                                <button
                                    class={`btn btn-xs join-item ${tab() === "md" ? "btn-active" : "btn-ghost"}`}
                                    aria-pressed={tab() === "md"}
                                    onClick={() => setTab("md")}
                                >
                                    📖 Markdown
                                </button>
                                <button
                                    class={`btn btn-xs join-item ${tab() === "raw" ? "btn-active" : "btn-ghost"}`}
                                    aria-pressed={tab() === "raw"}
                                    onClick={() => setTab("raw")}
                                >
                                    📄 原文
                                </button>
                            </div>
                        </Show>
                        <button class="btn btn-ghost btn-xs ml-auto opacity-60 hover:opacity-100" title="编辑内容" onClick={startEdit}>
                            ✏️
                        </button>
                    </div>
                }
            >
                <textarea
                    class="textarea textarea-bordered w-full text-body font-mono"
                    rows="14"
                    value={draft()}
                    onInput={(e) => onInput(e.currentTarget.value)}
                    placeholder="任务内容（Markdown，可选）"
                ></textarea>
                <div class="flex gap-1 justify-end mt-1">
                    <button class="btn btn-primary btn-xs" onClick={save} disabled={saving()}>
                        {saving() ? <span class="loading loading-spinner loading-xs"></span> : "💾 保存"}
                    </button>
                    <button class="btn btn-ghost btn-xs" onClick={cancelEdit} disabled={saving()}>
                        取消
                    </button>
                </div>
            </Show>

            <Show when={!editing()}>
                <Show when={props.task.body} fallback={<span class="text-body opacity-40 italic">无内容</span>}>
                    <Show when={tab() === "md"} fallback={<CodeBlock code={props.task.body!} lang="markdown" />}>
                        <MarkdownView content={props.task.body!} />
                    </Show>
                </Show>
            </Show>
        </div>
    );
}

// ═══════════════════════════════════════════
// 容器：三块的流式排布
// ═══════════════════════════════════════════
export function TaskDetailContent(props: {
    uri: string;
    task?: TaskDetail;
    hoverPreview?: boolean;
    /**
     * 宿主语义（用户 2026-10-03 重捋，取代 183/C-2 的一刀切）：
     *   manage = 任务管理详情面板 —— 树点标题**就近**（管理内选中 + 任务表展开定位）；
     *   chat   = 执行页左栏 / 悬停覆盖层 —— 树点标题**就近**（打开对话）。
     * 「主链接就近、远跳交给面板大按钮/入口」是总原则（见 ##228 七节）。
     */
    host?: "manage" | "chat";
}) {
    /** 自取的那份（没给 props.task 时用；覆盖层 / 执行页左栏走这条路） */
    const [own, setOwn] = createSignal<TaskDetail | null>(null);
    /**
     * 两列布局的左列宽度（px，落视图 cache）。
     *
     * 左列（属性 + 任务树）是「查资料」的窄栏，宽度由用户定；右列（正文）吃剩余。
     * 反过来（两块都弹性）在大面板里会一起被拉宽，两块都变巨宽、正文换行位置也乱飘。
     */
    const [leftW, setLeftW] = createSignal(Caches.diy_task_detail_left_width.get());
    const task = () => props.task ?? own();

    const load = async (uri: string) => {
        const r = await diyService.diy.getTask({ uri });
        // 响应回来时若 uri 已变（切得快）则丢弃，避免旧数据覆盖新的
        if (props.uri !== uri) return;
        if (r.data) draftStore.seed(uri, r.data.ui_drafts ?? null, r.data.updated);
        setOwn(r.data ?? null);
    };

    createEffect(
        on(
            () => props.uri,
            (uri) => {
                if (props.task) return; // 由调用方供数（任务管理详情面板）
                setOwn(null);
                void load(uri);
            },
        ),
    );

    // 卸载/切任务前把防抖中的草稿冲掉（挂载在面板外的地方比如悬停覆盖层，卸载很频繁）
    createEffect(
        on(
            () => props.uri,
            (uri, prev) => {
                if (prev) void draftStore.flushNow(prev);
            },
        ),
    );

    /**
     * 拖左列右缘改宽。
     *
     * 上限取「容器宽 - 正文最小宽（160）」与 TASK_DETAIL_LEFT_MAX 的较小者 ——
     * 只按常量 clamp 的话，在窄面板里能一路拖到把正文挤没。面板宽度会变（拖外面板 /
     * 窗口缩放），故每次按下时现算，不缓存。下限同理由常量兜住。
     */
    const onHandleDown = (e: MouseEvent) => {
        e.preventDefault();
        e.stopPropagation();
        const host = (e.currentTarget as HTMLElement).parentElement;
        const startX = e.clientX;
        const startW = leftW();
        // gap 也要扣掉：正文实际拿到的 = 容器宽 - 左列 - 列间距（手柄是绝对定位，不占位）
        const gap = host ? parseFloat(getComputedStyle(host).columnGap) || 0 : 0;
        const maxW = () =>
            Math.min(TASK_DETAIL_LEFT_MAX, Math.max(TASK_DETAIL_LEFT_MIN, (host?.clientWidth ?? 0) - gap - BODY_MIN_W));
        const move = (ev: MouseEvent) => {
            setLeftW(Math.min(maxW(), Math.max(TASK_DETAIL_LEFT_MIN, Math.round(startW + ev.clientX - startX))));
        };
        const up = () => {
            window.removeEventListener("mousemove", move);
            window.removeEventListener("mouseup", up);
            // 松手才落盘：拖拽中每帧写 localStorage 是几十次无用写入
            Caches.diy_task_detail_left_width.set(leftW());
        };
        window.addEventListener("mousemove", move);
        window.addEventListener("mouseup", up);
    };

    /** 改完刷新：任务树（全局）+ 本份详情（自己取的或调用方给的全局态） */
    const refresh = async () => {
        await taskStore.loadTree();
        if (props.task) await taskStore.selectTask(props.uri);
        else await load(props.uri);
    };

    return (
        <Show when={task()} fallback={<div class="text-body opacity-60 p-1">加载中…</div>}>
            {(t) => (
                <div class="task-flow">
                    {/* 左列宽度用 CSS 变量下发（只改宽度，不改结构：结构由容器查询按实测宽度切换）。
                        leftW 是 signal → 拖动时这一处 style 更新，不触发三块 view 重建。 */}
                    <div class="task-flow-grid" style={{ "--task-flow-left": `${leftW()}px` }}>
                        <div class="task-flow-left">
                            <Block k="attrs" title="任务属性">
                                <AttrsBlock uri={props.uri} task={t()} refresh={refresh} />
                            </Block>
                            <Block k="lineage" title="任务树">
                                <LineageBlock uri={props.uri} hoverPreview={props.hoverPreview} host={props.host ?? "chat"} />
                            </Block>
                        </div>
                        {/* 拖宽手柄：只在两列布局下显示（窄容器里单列，拖它没有语义）。
                            样式与 ViewGrid 的拖线一致（6px 热区、hover 变色）。 */}
                        <div
                            class="task-flow-handle"
                            title="拖动调整左列宽度（双击复位）"
                            onMouseDown={onHandleDown}
                            onDblClick={() => {
                                setLeftW(Caches.diy_task_detail_left_width.defaultValue);
                                Caches.diy_task_detail_left_width.reset();
                            }}
                        />
                        <div class="task-flow-body">
                            <Block k="body" title="任务内容">
                                <BodyBlock uri={props.uri} task={t()} refresh={refresh} />
                            </Block>
                        </div>
                    </div>
                </div>
            )}
        </Show>
    );
}

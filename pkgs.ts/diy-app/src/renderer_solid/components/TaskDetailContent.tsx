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
import { createSignal, createEffect, on, For, Show, type JSX } from "solid-js";
import { taskStore, type TaskDetail } from "../store/taskStore";
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
                class="flex w-full items-center gap-1 bg-base-300 px-2 py-1 text-[11px] font-bold tracking-wide opacity-80 hover:opacity-100"
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

/** 打开任务 = 任务管理表格里点任务名的那个动作（选中它、看它的详情）。 */
function openTask(uri: string): void {
    void taskStore.selectTask(uri);
    getRendererActions().navigate?.("task");
}

/** 打开对话 = nav 上点任务项那个动作（开/聚焦任务执行页 tab） */
function openChat(uri: string): void {
    getRendererActions().openTaskRun?.(uri);
}

/** 任务名链接：daisyUI tooltip「打开任务」，样式沿用 diy-link（深色主题下加亮过的链接色）。
 *
 *  `preview=true` 在按钮上声明 `data-task-hover-uri` —— 这是 hover 详情 drawer 的**唯一触发点**，
 *  由 App 的 document mouseover 委托接住（per-node handler 会被组件复用/重排的时序吞掉）。
 *  overlay 实例（悬停覆盖层 / 自己弹出的 drawer）不声明 → 不递归开第二层。 */
function TaskNameLink(props: {
    uri: string;
    label: string;
    class?: string;
    preview?: boolean;
}) {
    return (
        // tooltip 挂在外层 span 上而不是链接上：链接要 truncate（overflow-hidden），
        // 工具提示是它的伪元素，会被自己裁掉（实测踩过）。
        <span class={`tooltip tooltip-bottom min-w-0 ${props.class ?? "flex-1"}`} data-tip="打开任务">
            <button
                class="diy-link block w-full truncate text-left underline-offset-2 hover:underline cursor-pointer"
                data-task-hover-uri={props.preview ? props.uri : undefined}
                onClick={(e) => {
                    e.stopPropagation();
                    openTask(props.uri);
                }}
            >
                {props.label}
            </button>
        </span>
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
                <span class="task-field-label text-xs opacity-50">标题</span>
                <div class="flex min-w-0 items-center gap-1">
                    <Show
                        when={editing()}
                        fallback={
                            <h3 class="min-w-0 flex-1 text-sm font-bold">
                                <TaskNameLink uri={props.uri} label={props.task.title || props.uri} class="block" />
                            </h3>
                        }
                    >
                        <input
                            type="text"
                            class="input input-bordered input-sm min-w-0 flex-1 text-sm font-bold"
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
                    <span class="task-field-label text-xs opacity-50">状态</span>
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
            </div>

            <div class="flex flex-col gap-1 text-[11px] opacity-60">
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
// 块 2：任务父子关系树（祖先链 + 自己 + 子孙）
// ═══════════════════════════════════════════
function LineageBlock(props: { uri: string; hoverPreview?: boolean }) {
    /** 血缘行：树才是父子关系的真相源（URI 路径不表达层级），见 lib/task-lineage */
    const rows = () => lineageRows(taskStore.nodes, props.uri);
    return (
        <div class="flex flex-col">
            <For each={rows()}>
                {(r) => (
                    <div
                        class={`group flex items-center gap-1 rounded px-1 py-0.5 cursor-pointer hover:bg-base-300 ${
                            r.current ? "bg-primary/20 ring-1 ring-primary/30" : ""
                        }`}
                        style={{ "padding-left": `${r.depth * 12 + 4}px` }}
                        title={r.uri}
                        onClick={() => openTask(r.uri)}
                    >
                        <span class={`w-1.5 h-1.5 rounded-full shrink-0 ${taskStateColor(r.state)}`} />
                        <span class="font-mono shrink-0 text-[11px] opacity-60">#{r.num ?? "?"}</span>
                        {/* 「◀ 当前」**紧跟标题**（不是行尾）：它是标题的补语，隔着一个
                            auto margin 飘到右边会读成「这一行整体是当前」。
                            标题 min-w-0 + truncate：长标题只截自己，不吃掉后面的标签。 */}
                        <TaskNameLink uri={r.uri} label={r.title ?? r.uri} class="min-w-0 text-[11px]" preview={props.hoverPreview} />
                        <Show when={r.current}>
                            <span class="shrink-0 text-[10px] opacity-60">◀ 当前</span>
                        </Show>
                        {/* 操作按钮**右对齐**（ml-auto），与上面「当前」各管一侧 —— 混在一起
                            会随标题长度左右漂，每行的按钮位置都不一样，扫不下去。
                            「对话」= 打开该任务的任务执行页（与 nav 上点任务项同一个动作），
                            平时不占地方，hover 该行才出现。 */}
                        <button
                            class="btn btn-ghost btn-xs px-1 min-h-0 ml-auto shrink-0 opacity-0 group-hover:opacity-70 hover:!opacity-100"
                            title={`打开 #${r.num ?? "?"} 的对话`}
                            onClick={(e) => {
                                e.stopPropagation();
                                openChat(r.uri);
                            }}
                        >
                            💬 对话
                        </button>
                    </div>
                )}
            </For>
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
                    class="textarea textarea-bordered w-full text-xs font-mono"
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
                <Show when={props.task.body} fallback={<span class="text-xs opacity-40 italic">无内容</span>}>
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
export function TaskDetailContent(props: { uri: string; task?: TaskDetail; hoverPreview?: boolean }) {
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
        <Show when={task()} fallback={<div class="text-xs opacity-60 p-1">加载中…</div>}>
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
                                <LineageBlock uri={props.uri} hoverPreview={props.hoverPreview} />
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

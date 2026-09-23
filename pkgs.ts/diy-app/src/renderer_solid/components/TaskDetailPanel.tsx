import { createSignal, createMemo, createEffect, on, onMount, onCleanup, Show } from "solid-js";
import * as Select from "@kobalte/core/select";
import { taskStore, type TaskDetail } from "../store/taskStore";
import { localChatStore } from "../store/localChatStore";
import { draftStore } from "../store/draftStore";
import { diyService } from "../lib/rpc";
import { getRendererActions } from "../lib/renderer-actions";
import { Caches } from "../lib/ui-state";
import { MarkdownView } from "./MarkdownView";
import { CodeBlock } from "./CodeBlock";
import { taskStateColor } from "../../main/core/task-state";

const PANEL_W_MIN = 360;
/** 上限相对窗口：至少给任务树留 200px，避免抽屉吃掉整页 */
const panelMax = () => Math.max(PANEL_W_MIN + 100, window.innerWidth - 200);

/** 面板宽度（px 固定值，不用百分比；视图 cache：范围校验在字段 parse） */
function loadPanelWidth(): number {
    return Caches.diy_task_detail_width.get();
}

export function TaskDetailPanel() {
    const onKey = (e: KeyboardEvent) => {
        if (e.key === "Escape") taskStore.selectTask(null);
    };
    onMount(() => window.addEventListener("keydown", onKey));
    onCleanup(() => window.removeEventListener("keydown", onKey));
    const [panelW, setPanelW] = createSignal(loadPanelWidth());
    // 渲染宽度一律过窗口上限：持久化的值可能来自更大的屏幕（上限 4000），
    // 直接套用会把任务树挤没（历史问题：只有拖拽路径 clamp，渲染路径没 clamp）。
    const renderW = () => Math.min(panelMax(), panelW());

    // ── per-task 记忆：详情滚动位置（存 TaskState，切任务/重挂各自恢复） ──
    let detailScrollRef: HTMLDivElement | undefined;
    /** 详情滚动恢复标记：切任务时置位，内容（selectedTask 异步加载）就绪后执行一次 */
    let needsRestore = false;
    // 切任务：冲掉旧任务防抖中的草稿（输入框随任务切换立刻卸载，不冲则最后 600ms 的字丢掉）
    createEffect(
        on(
            () => taskStore.selectedUri,
            (uri, prev) => {
                if (prev) void draftStore.flushNow(prev);
                if (uri) needsRestore = true;
            },
        ),
    );
    // 面板整体卸载（切导航页 / 关闭面板）同样要冲
    onCleanup(() => {
        const u = taskStore.selectedUri;
        if (u) void draftStore.flushNow(u);
    });
    onMount(() => {
        if (taskStore.selectedUri) needsRestore = true;
    });
    // 内容就绪后恢复详情滚动（rAF 一帧后设，内容已渲染不会被 clamped）
    createEffect(() => {
        const t = taskStore.selectedTask;
        const uri = taskStore.selectedUri;
        if (!t || !uri || !needsRestore) return;
        if (!detailScrollRef) return;
        needsRestore = false;
        const p = localChatStore.getDetailScroll(uri);
        if (p > 0) {
            // 内容异步渲染：等 scrollHeight 展开（>clientHeight）再设，防 clamped；最多 5 帧尽力
            let frames = 0;
            const trySet = () => {
                if (!detailScrollRef) return;
                frames++;
                if (frames <= 5 && detailScrollRef.scrollHeight <= detailScrollRef.clientHeight + 1) {
                    requestAnimationFrame(trySet);
                    return;
                }
                detailScrollRef.scrollTop = p;
            };
            requestAnimationFrame(trySet);
        }
    });

    // 左缘拖拽改宽：面板右锚定，宽 = 视口宽 - 鼠标 x；松开落盘
    const onGripDown = (e: MouseEvent) => {
        e.preventDefault();
        e.stopPropagation();
        const move = (ev: MouseEvent) => {
            setPanelW(Math.min(panelMax(), Math.max(PANEL_W_MIN, window.innerWidth - ev.clientX)));
        };
        const up = () => {
            window.removeEventListener("mousemove", move);
            window.removeEventListener("mouseup", up);
            try {
                Caches.diy_task_detail_width.set(panelW());
            } catch {
                /* 存失败不影响本次 */
            }
        };
        window.addEventListener("mousemove", move);
        window.addEventListener("mouseup", up);
    };

    return (
        <Show when={!!taskStore.selectedUri}>
            <div
                class="card bg-base-100 border-l shadow-xl absolute inset-y-0 right-0 z-40 h-full flex flex-col"
                style={{ width: `${renderW()}px` }}
                onClick={(e) => e.stopPropagation()}
            >
                {/* 左缘拖拽条 */}
                <div
                    class="absolute inset-y-0 left-0 w-1.5 cursor-col-resize hover:bg-primary/40 active:bg-primary/60 z-10"
                    onMouseDown={onGripDown}
                />
                {/* 卡片头部：URI + 试验场 + 关闭 */}
                <div class="flex items-center justify-between px-4 py-2 border-b shrink-0">
                    <span class="text-xs font-mono opacity-60 truncate max-w-[300px]">
                        {taskStore.selectedUri}
                    </span>
                    <div class="flex items-center gap-1">
                        <button class="btn btn-ghost btn-sm" onClick={() => taskStore.selectTask(null)}>
                            ✕
                        </button>
                    </div>
                </div>

                {/* 任务详情（唯一内容）。**不再有 tab** —— 会话已移到任务执行页的
                    chat area，这里只剩详情本身，故无需在两种东西之间切换。 */}
                <div
                    class="flex-1 overflow-auto p-4"
                    ref={(el) => (detailScrollRef = el)}
                    onScroll={(e) => {
                        const u = taskStore.selectedUri;
                        if (u) localChatStore.setDetailScroll(u, e.currentTarget.scrollTop);
                    }}
                >
                        {/* keyed：每个任务一个 TaskInfoView 实例。
                            非 keyed 时组件实例会被复用到下一个任务，而编辑态/草稿是在构造时
                            初始化的 —— 表现为「切回后显示上一个任务的标题」。
                            代价：改状态会重取任务并重建面板，但编辑态由草稿驱动
                            （draftStore.hasAny），只要用户改过内容就会自动恢复，无内容损失。 */}
                        <Show when={taskStore.selectedTask} keyed fallback={<div class="opacity-60 text-sm">加载中…</div>}>
                            {(t) => <TaskInfoView task={t} />}
                        </Show>
                </div>

                {/* 大 FAB：一键进入任务执行页（= 开始/继续这个任务）。
                    与任务状态无关 —— 打开 tab 表示「我现在要做它」，不改状态
                    （状态模型待重新设计，见 133）。面板内 absolute 定位，
                    不随详情滚动走，始终够得着。 */}
                <button
                    class="btn btn-primary btn-lg absolute bottom-4 right-4 z-20 rounded-full shadow-xl gap-2"
                    title="开始/继续这个任务（打开任务执行页）"
                    onClick={() => {
                        const uri = taskStore.selectedUri;
                        if (uri) getRendererActions().openTaskRun?.(uri);
                    }}
                >
                    <span>▶</span>
                    <span>{taskStore.selectedTask?.state === "active" ? "继续" : "开始"}</span>
                </button>
            </div>
        </Show>
    );
}

// ═══════════════════════════════════════════
// 任务状态：颜色圆点 + 英文值 + 中文标签，分组展示
// 与后端 TaskStateSchema 对齐
// ═══════════════════════════════════════════
interface StateOption {
    value: string;
    label: string;
}
interface StateGroup {
    label: string;
    children: StateOption[];
}

const STATE_POOL: Record<string, StateOption> = {
    pending: { value: "pending", label: "待处理" },
    active: { value: "active", label: "进行中" },
    done: { value: "done", label: "已完成" },
    blocked: { value: "blocked", label: "阻塞" },
    cancelled: { value: "cancelled", label: "已取消" },
    shelved: { value: "shelved", label: "已搁置" },
    new: { value: "new", label: "新建" },
    open: { value: "open", label: "打开" },
    closed: { value: "closed", label: "已关闭" },
};

/** 下拉分组：任务流程状态 / Issue 风格状态，避免平铺一长串难分辨 */
const STATE_GROUPS: StateGroup[] = [
    {
        label: "任务状态",
        children: ["pending", "active", "done", "blocked", "cancelled", "shelved"].map((v) => STATE_POOL[v]),
    },
    {
        label: "Issue 状态",
        children: ["new", "open", "closed"].map((v) => STATE_POOL[v]),
    },
];

/**
 * GitHub 风格状态下拉：不进入编辑态，直接切换任务状态。
 * 选项带颜色圆点 + 状态英文值 + 中文标签，按组展示。
 */
export function StateSelect(props: { current?: string; saving: boolean; onSave: (v: string) => void }) {
    // 防御：若当前状态不在任何组里，动态补入口保证可显示/可切回
    const options = createMemo(() => {
        const known = new Set(STATE_GROUPS.flatMap((g) => g.children.map((o) => o.value)));
        if (props.current && !known.has(props.current)) {
            const groups = STATE_GROUPS.map((g) => ({ ...g, children: [...g.children] }));
            groups[groups.length - 1].children.push({ value: props.current, label: props.current });
            return groups;
        }
        return STATE_GROUPS;
    });
    const selected = createMemo<StateOption>(() => {
        const cur = props.current ?? "";
        return (cur && STATE_POOL[cur]) || { value: cur, label: cur };
    });

    return (
        <Select.Root<StateOption, StateGroup>
            options={options()}
            optionGroupChildren="children"
            optionValue={(o) => o.value}
            optionTextValue={(o) => o.label}
            multiple={false}
            value={selected()}
            onChange={(v) => {
                if (v && v.value !== props.current) props.onSave(v.value);
            }}
            placeholder="选择状态"
            disabled={props.saving}
            disallowEmptySelection
            closeOnSelection
            itemComponent={(p) => {
                const opt = () => p.item.rawValue as StateOption;
                return (
                    <Select.Item
                        item={p.item}
                        class="flex items-center gap-2 rounded px-2 py-1.5 text-xs cursor-pointer data-[highlighted]:bg-base-200 data-[selected]:bg-primary/10"
                    >
                        <span class={`w-2 h-2 rounded-full inline-block shrink-0 ${taskStateColor(opt().value)}`} />
                        <span class="font-mono">{opt().value}</span>
                        <span class="opacity-70">{opt().label}</span>
                    </Select.Item>
                );
            }}
            sectionComponent={(s) => (
                <Select.Section class="contents">
                    <div class="px-2 py-1 text-[10px] font-semibold uppercase tracking-wide opacity-50">
                        {(s.section.rawValue as StateGroup).label}
                    </div>
                </Select.Section>
            )}
        >
            <Select.Trigger class="btn btn-outline btn-xs border-base-300 px-2 cursor-pointer inline-flex items-center gap-2 disabled:opacity-50">
                <span class={`w-2 h-2 rounded-full inline-block ${taskStateColor(selected().value)}`} />
                <span class="font-mono">{props.current}</span>
                <Select.Icon class="opacity-60 text-[10px]">▾</Select.Icon>
            </Select.Trigger>
            <Select.Portal>
                <Select.Content class="z-[60] min-w-[180px] rounded-lg border border-base-300 bg-base-100 p-1 shadow-xl">
                    <Select.Listbox class="max-h-64 space-y-0.5 overflow-auto" />
                </Select.Content>
            </Select.Portal>
        </Select.Root>
    );
}

/** 详情渲染模式：Markdown 富文本 / 原文（纯视图偏好，不落盘） */
type DetailTab = "md" | "raw";

/** 任务详情全能力视图（标题编辑/状态切换/草稿/元信息/Markdown+原文双 tab）。
 *  试验场任务 tab 直接复用本组件，与详情抽屉同源零分叉。 */
export function TaskInfoView(props: { task: TaskDetail }) {
    /** 详情渲染模式：Markdown 富文本 / 原文。纯视图偏好，不落盘——
     *  与草稿（draftStore，跨卸载恢复）不同，它丢了大不了回到默认富文本。 */
    const [detailTab, setDetailTab] = createSignal<DetailTab>("md");
    /**
     * 编辑态与草稿都从 draftStore 恢复，而不是组件局部状态。
     *
     * 为什么：本组件在「切任务」时会被卸载重建（selectTask 先把 selectedTask 置空）、
     * 在「切 tab」时也会被 Kobalte Tabs.Content 卸载 —— 局部 signal 一重建就没了，
     * 表现为「编辑到一半切走再回来，输入全丢」。
     *
     * 恢复规则：有详情类草稿即视为编辑中（不需要额外存 editing 标记）。
     */
    const d = draftStore.fieldsOf(props.task.uri);
    // 只认「任务编辑」这两个字段：agent 输入框的草稿是另一回事，
    // 否则「聊天打到一半」会让详情面板一进来就是编辑态。
    const [editing, setEditing] = createSignal(draftStore.hasAny(props.task.uri, ["title", "body"]));
    const [titleDraft, setTitleDraft] = createSignal(d.title ?? props.task.title ?? "");
    const [bodyDraft, setBodyDraft] = createSignal(d.body ?? props.task.body ?? "");
    const [saving, setSaving] = createSignal(false);

    /** 逐键写内存 + 防抖落盘（draftStore 内部 600ms debounce） */
    const onTitleInput = (v: string) => {
        setTitleDraft(v);
        draftStore.set(props.task.uri, "title", v);
    };
    const onBodyInput = (v: string) => {
        setBodyDraft(v);
        draftStore.set(props.task.uri, "body", v);
    };

    const startEdit = () => {
        // 起点取「草稿优先」：上次编辑到一半的值不该被任务现值盖掉
        const cur = draftStore.fieldsOf(props.task.uri);
        setTitleDraft(cur.title ?? props.task.title ?? "");
        setBodyDraft(cur.body ?? props.task.body ?? "");
        setEditing(true);
    };

    /** 放弃编辑：草稿一并丢弃（留着会盖住任务现值）。await 确保磁盘同步删除 */
    const cancelEdit = async () => {
        setEditing(false);
        await draftStore.clear(props.task.uri, ["title", "body"]);
    };

    // 不进入编辑态，直接改状态（类似 GitHub issue 的状态切换）
    const changeState = async (next: string) => {
        if (next === props.task.state) return;
        setSaving(true);
        try {
            await diyService.diy.task.edit({
                uri: props.task.uri,
                title: undefined,
                state: next as any,
                body: undefined,
                parent: undefined,
            });
            await taskStore.loadTree();      // 同步任务树状态
            await taskStore.selectTask(props.task.uri); // 刷新详情 state
        } catch (err: any) {
            console.error("[TaskInfoView] change state failed:", err);
        } finally {
            setSaving(false);
        }
    };

    const saveEdit = async () => {
        setSaving(true);
        try {
            const t = props.task;
            const changes: Record<string, string> = {};
            if (titleDraft() !== (t.title ?? "")) changes.title = titleDraft();
            if (bodyDraft() !== (t.body ?? "")) changes.body = bodyDraft();

            if (Object.keys(changes).length === 0) {
                setEditing(false);
                // 无改动也算「本次编辑结束」：草稿没有存在意义了
                await draftStore.clear(t.uri, ["title", "body"]);
                return;
            }

            await diyService.diy.task.edit({ uri: t.uri, title: changes.title, state: undefined, body: changes.body, parent: undefined });
            await taskStore.loadTree();
            // 先清草稿再重取任务：否则重取回来的旧草稿会把刚保存的值当「编辑中」再显示一遍
            await draftStore.clear(t.uri, ["title", "body"]);
            await taskStore.selectTask(t.uri);
            setEditing(false);
        } catch (err: any) {
            console.error("[TaskInfoView] save failed:", err);
        } finally {
            setSaving(false);
        }
    };

    return (
        <div class="space-y-4">
            {/* 标题区域 */}
            <div class="flex items-start justify-between gap-2">
                <Show
                    when={editing()}
                    fallback={
                        <h2 class="text-lg font-bold mb-1 flex-1">
                            {props.task.title || props.task.uri}
                        </h2>
                    }
                >
                    <input
                        type="text"
                        class="input input-bordered input-sm flex-1 text-lg font-bold"
                        value={titleDraft()}
                        onInput={(e) => onTitleInput(e.currentTarget.value)}
                        placeholder="任务标题"
                    />
                </Show>
                <Show when={!editing()}>
                    <button
                        class="btn btn-ghost btn-sm opacity-60 hover:opacity-100 shrink-0"
                        onClick={startEdit}
                        title="编辑任务"
                    >
                        ✏️ 编辑
                    </button>
                </Show>
            </div>

            {/* 状态（可直接切换）+ 编辑操作按钮 */}
            <div class="flex items-center gap-2 flex-wrap">
                <StateSelect current={props.task.state} saving={saving()} onSave={changeState} />
                <Show when={editing()}>
                    <div class="flex gap-1 ml-auto">
                        <button
                            class="btn btn-primary btn-xs"
                            onClick={saveEdit}
                            disabled={saving()}
                        >
                            {saving() ? <span class="loading loading-spinner loading-xs"></span> : "💾 保存"}
                        </button>
                        <button
                            class="btn btn-ghost btn-xs"
                            onClick={cancelEdit}
                            disabled={saving()}
                        >
                            取消
                        </button>
                    </div>
                </Show>
            </div>

            {/* 元信息 */}
            <div class="flex gap-2 flex-wrap text-xs opacity-60">
                {props.task.project && (
                    <span class="badge badge-outline">📂 {props.task.project_label ?? props.task.project_path ?? props.task.project}</span>
                )}
                {props.task.created && (
                    <span class="badge badge-outline">
                        🕐 {new Date(props.task.created).toLocaleString()}
                    </span>
                )}
                {props.task.updated && props.task.updated !== props.task.created && (
                    <span class="badge badge-outline">
                        ✏️ {new Date(props.task.updated).toLocaleString()}
                    </span>
                )}
            </div>

            {/* 内容：编辑态为文本框；只读态为 Markdown / 原文 双 tab（嵌套在外层 local|info 之内）。
                任务模型只有「标题 + 内容」两个字段 —— 内容即 AGENTS.md frontmatter 之后的正文（body）。
                曾经的 detail 字段是同义的第二内容槽（frontmatter 内），只读视图两节都渲染、编辑框却只绑
                detail，导致「页面有内容、点编辑是空框，保存后内容出现两份」，已下线。 */}
            <div>
                <Show when={editing()}>
                    <textarea
                        class="textarea textarea-bordered w-full text-sm font-mono"
                        rows="12"
                        value={bodyDraft()}
                        onInput={(e) => onBodyInput(e.currentTarget.value)}
                        placeholder="任务内容（Markdown，可选）"
                    ></textarea>
                </Show>
                <Show when={!editing()}>
                    <Show
                        when={props.task.body}
                        fallback={<span class="text-xs opacity-40 italic">无内容</span>}
                    >
                        {/* Markdown / 原文不是两种对象，只是**渲染开关** —— 用 tab 表达会
                            让人以为有两份内容（并多一层嵌套 tab）。这里用与 chat 一致的
                            二选一按钮组：两态都可见，当前态高亮。
                            不另开滚动容器：外层已是滚动容器，再套一层会截断高度、
                            破坏滚动位置恢复。 */}
                        <div class="join mb-2">
                            <button
                                class={`btn btn-xs join-item ${detailTab() === "md" ? "btn-active" : "btn-ghost"}`}
                                aria-pressed={detailTab() === "md"}
                                onClick={() => setDetailTab("md")}
                            >
                                📖 Markdown
                            </button>
                            <button
                                class={`btn btn-xs join-item ${detailTab() === "raw" ? "btn-active" : "btn-ghost"}`}
                                aria-pressed={detailTab() === "raw"}
                                onClick={() => setDetailTab("raw")}
                            >
                                📄 原文
                            </button>
                        </div>
                        <Show when={detailTab() === "md"} fallback={<CodeBlock code={props.task.body!} lang="markdown" />}>
                            <MarkdownView content={props.task.body!} />
                        </Show>
                    </Show>
                </Show>
            </div>
        </div>
    );
}

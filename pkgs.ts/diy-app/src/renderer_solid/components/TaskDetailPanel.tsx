import { createSignal, createMemo, createEffect, on, onMount, onCleanup, Show } from "solid-js";
import * as Tabs from "@kobalte/core/tabs";
import * as Select from "@kobalte/core/select";
import { taskStore, type TaskDetail } from "../store/taskStore";
import { localChatStore } from "../store/localChatStore";
import { draftStore } from "../store/draftStore";
import { notificationStore } from "../store/notificationStore";
import { diyService } from "../lib/rpc";
import { getRendererActions } from "../lib/renderer-actions";
import { Caches } from "../lib/ui-state";
import { LocalChatPage } from "./LocalChatPage";
import { MarkdownView } from "./MarkdownView";
import { CodeBlock } from "./CodeBlock";

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

    // ── per-task 记忆：当前任务详情面板在哪个 tab + info 滚动位置（存 TaskState，切任务/重挂各自恢复） ──
    const [tab, setTab] = createSignal<"local" | "info">(
        taskStore.selectedUri ? localChatStore.getTab(taskStore.selectedUri) : "local",
    );
    let detailScrollRef: HTMLDivElement | undefined;
    /** 详情滚动恢复标记：置位于「切任务/进入 info」，内容（selectedTask 异步加载）就绪后执行一次 */
    let needsRestore = false;
    // 切任务：保存旧任务的 tab → 恢复新任务（详情滚动由 info 容器 onScroll 实时记录，天然准确）
    createEffect(
        on(
            () => taskStore.selectedUri,
            (uri, prev) => {
                if (prev) {
                    localChatStore.setTab(prev, tab());
                    // 切走前冲掉上一个任务防抖中的草稿：详情面板的输入框会随任务切换立刻卸载，
                    // 不等这一步，用户最后 600ms 内敲的字就丢了。
                    // ⚠️ 必须在本组件（面板级）做，不能放进常驻于 <Show> 内的 TaskInfoView：
                    // 那里读 props 会触发 Solid 的 "Stale read from <Show>"，中断 props 更新。
                    void draftStore.flushNow(prev);
                }
                const next = uri ? localChatStore.getTab(uri) : "local";
                setTab(next);
                if (next === "info") needsRestore = true;
            },
        ),
    );
    // 手动切到 info tab：同样置恢复标记；顺带冲一次草稿（切 tab 会卸载 / 挂载两个 Tabs.Content）
    createEffect(
        on(() => tab(), (t) => {
            if (t === "info") needsRestore = true;
            const u = taskStore.selectedUri;
            if (u) void draftStore.flushNow(u);
        }),
    );
    // 面板整体卸载（切导航页 / 关闭面板）同样要冲
    onCleanup(() => {
        const u = taskStore.selectedUri;
        if (u) void draftStore.flushNow(u);
    });
    // 首挂（任务详情 tab 时）也要恢复
    onMount(() => {
        if (tab() === "info") needsRestore = true;
    });
    // 内容就绪后恢复详情滚动（rAF 一帧后设，内容已渲染不会被 clamped）
    createEffect(() => {
        const t = taskStore.selectedTask;
        const uri = taskStore.selectedUri;
        if (!t || !uri || !needsRestore) return;
        if (tab() !== "info" || !detailScrollRef) return;
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
                        <button
                            class="btn btn-ghost btn-sm"
                            title="带当前任务去试验场调模版"
                            onClick={() => getRendererActions().navigate?.("lab")}
                        >
                            🪟
                        </button>
                        <button class="btn btn-ghost btn-sm" onClick={() => taskStore.selectTask(null)}>
                            ✕
                        </button>
                    </div>
                </div>

                {/* Tab 切换：Agent 对话（默认）/ 任务详情（受控：per-task 记忆，切任务各自恢复） */}
                <Tabs.Root
                    value={tab()}
                    onChange={(v) => {
                        const t = v === "info" ? "info" : "local";
                        setTab(t);
                        const uri = taskStore.selectedUri;
                        if (uri) {
                            localChatStore.setTab(uri, t);
                            // 切出 info 前保存滚动位置（容器 DOM 还在）
                            if (t === "local" && detailScrollRef) localChatStore.setDetailScroll(uri, detailScrollRef.scrollTop);
                        }
                    }}
                    class="flex flex-col flex-1 overflow-hidden"
                >
                    <Tabs.List class="tabs tabs-bordered tabs-sm px-4 shrink-0">
                        <Tabs.Trigger value="local" class="tab">🧪 Local</Tabs.Trigger>
                        <Tabs.Trigger value="info" class="tab">📋 详情</Tabs.Trigger>
                    </Tabs.List>

                    {/* 本地自定义 agent（ai-sdk 块协议，独立会话） */}
                    <Tabs.Content value="local" class="flex-1 overflow-hidden">
                        <LocalChatPage />
                    </Tabs.Content>

                    {/* 任务详情 —— 元信息 */}
                    <Tabs.Content
                        value="info"
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
                    </Tabs.Content>
                </Tabs.Root>
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
    dot: string;
}
interface StateGroup {
    label: string;
    children: StateOption[];
}

const STATE_POOL: Record<string, StateOption> = {
    pending: { value: "pending", label: "待处理", dot: "bg-warning" },
    active: { value: "active", label: "进行中", dot: "bg-info" },
    done: { value: "done", label: "已完成", dot: "bg-success" },
    blocked: { value: "blocked", label: "阻塞", dot: "bg-error" },
    cancelled: { value: "cancelled", label: "已取消", dot: "bg-neutral" },
    shelved: { value: "shelved", label: "已搁置", dot: "bg-neutral" },
    new: { value: "new", label: "新建", dot: "bg-info" },
    open: { value: "open", label: "打开", dot: "bg-info" },
    closed: { value: "closed", label: "已关闭", dot: "bg-neutral" },
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

function stateDot(s?: string) {
    if (!s) return "bg-neutral";
    return STATE_POOL[s]?.dot ?? "bg-neutral";
}

/**
 * GitHub 风格状态下拉：不进入编辑态，直接切换任务状态。
 * 选项带颜色圆点 + 状态英文值 + 中文标签，按组展示。
 */
function StateSelect(props: { current?: string; saving: boolean; onSave: (v: string) => void }) {
    // 防御：若当前状态不在任何组里，动态补入口保证可显示/可切回
    const options = createMemo(() => {
        const known = new Set(STATE_GROUPS.flatMap((g) => g.children.map((o) => o.value)));
        if (props.current && !known.has(props.current)) {
            const groups = STATE_GROUPS.map((g) => ({ ...g, children: [...g.children] }));
            groups[groups.length - 1].children.push({
                value: props.current,
                label: props.current,
                dot: "bg-neutral",
            });
            return groups;
        }
        return STATE_GROUPS;
    });
    const selected = createMemo<StateOption>(() => {
        const cur = props.current ?? "";
        return (cur && STATE_POOL[cur]) || { value: cur, label: cur, dot: stateDot(cur) };
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
                        <span class={`w-2 h-2 rounded-full inline-block shrink-0 ${opt().dot}`} />
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
                <span class={`w-2 h-2 rounded-full inline-block ${selected().dot}`} />
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
            // 保存失败必须出声：校验拒绝（如正文过短/标题为空）若只 console.error，
            // 用户看到的是「点了保存没反应、内容也没变」，无从判断原因
            console.error("[TaskInfoView] save failed:", err);
            notificationStore.addToast("error", `保存失败: ${err?.message ?? String(err)}`);
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
                        {/* 内层不另开滚动容器：外层 Tabs.Content(value=info) 已是滚动容器，
                            再套一层会截断高度、破坏其滚动位置恢复 */}
                        <Tabs.Root value={detailTab()} onChange={(v) => setDetailTab(v as DetailTab)} class="w-full">
                            <Tabs.List class="tabs tabs-bordered tabs-xs mb-2">
                                <Tabs.Trigger value="md" class="tab">📖 Markdown</Tabs.Trigger>
                                <Tabs.Trigger value="raw" class="tab">📄 原文</Tabs.Trigger>
                            </Tabs.List>

                            <Tabs.Content value="md">
                                <MarkdownView content={props.task.body!} />
                            </Tabs.Content>

                            <Tabs.Content value="raw">
                                <CodeBlock code={props.task.body!} lang="markdown" />
                            </Tabs.Content>
                        </Tabs.Root>
                    </Show>
                </Show>
            </div>
        </div>
    );
}

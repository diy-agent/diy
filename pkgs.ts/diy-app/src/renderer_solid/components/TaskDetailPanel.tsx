import { createSignal, createMemo, onMount, onCleanup, Show } from "solid-js";
import * as Tabs from "@kobalte/core/tabs";
import * as Select from "@kobalte/core/select";
import { taskStore, type TaskDetail } from "../store/taskStore";
import { diyService } from "../lib/rpc";
import { LocalChatPage } from "./LocalChatPage";

const PANEL_W_KEY = "diy-detail-width";
const PANEL_W_MIN = 360;
const PANEL_W_MAX = 1000;
const PANEL_W_DEFAULT = 560;

/** 面板宽度（px 固定值，不用百分比；localStorage 持久） */
function loadPanelWidth(): number {
    try {
        const v = Number(localStorage.getItem(PANEL_W_KEY));
        if (v >= PANEL_W_MIN && v <= PANEL_W_MAX) return v;
    } catch {
        /* 读失败用默认 */
    }
    return PANEL_W_DEFAULT;
}

export function TaskDetailPanel() {
    const onKey = (e: KeyboardEvent) => {
        if (e.key === "Escape") taskStore.selectTask(null);
    };
    onMount(() => window.addEventListener("keydown", onKey));
    onCleanup(() => window.removeEventListener("keydown", onKey));
    const [panelW, setPanelW] = createSignal(loadPanelWidth());

    // 左缘拖拽改宽：面板右锚定，宽 = 视口宽 - 鼠标 x；松开落盘
    const onGripDown = (e: MouseEvent) => {
        e.preventDefault();
        e.stopPropagation();
        const move = (ev: MouseEvent) => {
            setPanelW(Math.min(PANEL_W_MAX, Math.max(PANEL_W_MIN, window.innerWidth - ev.clientX)));
        };
        const up = () => {
            window.removeEventListener("mousemove", move);
            window.removeEventListener("mouseup", up);
            try {
                localStorage.setItem(PANEL_W_KEY, String(panelW()));
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
                style={{ width: `${panelW()}px` }}
                onClick={(e) => e.stopPropagation()}
            >
                {/* 左缘拖拽条 */}
                <div
                    class="absolute inset-y-0 left-0 w-1.5 cursor-col-resize hover:bg-primary/40 active:bg-primary/60 z-10"
                    onMouseDown={onGripDown}
                />
                {/* 卡片头部：URI + 关闭 */}
                <div class="flex items-center justify-between px-4 py-2 border-b shrink-0">
                    <span class="text-xs font-mono opacity-60 truncate max-w-[300px]">
                        {taskStore.selectedUri}
                    </span>
                    <button class="btn btn-ghost btn-sm" onClick={() => taskStore.selectTask(null)}>
                        ✕
                    </button>
                </div>

                {/* Tab 切换：Agent 对话（默认）/ 任务详情 */}
                <Tabs.Root defaultValue="agent" class="flex flex-col flex-1 overflow-hidden">
                    <Tabs.List class="tabs tabs-bordered tabs-sm px-4 shrink-0">
                        <Tabs.Trigger value="local" class="tab">🧪 Local</Tabs.Trigger>
                        <Tabs.Trigger value="info" class="tab">📋 详情</Tabs.Trigger>
                    </Tabs.List>

                    {/* 本地自定义 agent（ai-sdk 块协议，独立会话） */}
                    <Tabs.Content value="local" class="flex-1 overflow-hidden">
                        <LocalChatPage />
                    </Tabs.Content>

                    {/* 任务详情 —— 元信息 */}
                    <Tabs.Content value="info" class="flex-1 overflow-auto p-4">
                        <Show when={taskStore.selectedTask} fallback={<div class="opacity-60 text-sm">加载中…</div>}>
                            {(t) => <TaskInfoView task={t()} />}
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

function TaskInfoView(props: { task: TaskDetail }) {
    const [editing, setEditing] = createSignal(false);
    const [titleDraft, setTitleDraft] = createSignal("");
    const [detailDraft, setDetailDraft] = createSignal("");
    const [saving, setSaving] = createSignal(false);

    const startEdit = () => {
        setTitleDraft(props.task.title ?? "");
        setDetailDraft(props.task.detail ?? "");
        setEditing(true);
    };

    const cancelEdit = () => {
        setEditing(false);
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
                detail: undefined,
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
            if (detailDraft() !== (t.detail ?? "")) changes.detail = detailDraft();

            if (Object.keys(changes).length === 0) {
                setEditing(false);
                return;
            }

            await diyService.diy.task.edit({ uri: t.uri, title: changes.title, state: changes.state as any, detail: changes.detail, body: changes.body, parent: changes.parent });
            await taskStore.loadTree();
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
                        onInput={(e) => setTitleDraft(e.currentTarget.value)}
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

            {/* 详情 */}
            <div>
                <Show when={editing()}>
                    <textarea
                        class="textarea textarea-bordered w-full text-sm"
                        rows="4"
                        value={detailDraft()}
                        onInput={(e) => setDetailDraft(e.currentTarget.value)}
                        placeholder="任务详情（可选）"
                    ></textarea>
                </Show>
                <Show when={!editing()}>
                    {props.task.detail ? (
                        <>
                            <h3 class="text-xs font-semibold opacity-60 mb-1">详情</h3>
                            <div class="text-sm whitespace-pre-wrap">{props.task.detail}</div>
                        </>
                    ) : (
                        <span class="text-xs opacity-40 italic">无详情</span>
                    )}
                </Show>
            </div>

            {/* 正文 */}
            <Show when={!editing() && props.task.body}>
                <div>
                    <h3 class="text-xs font-semibold opacity-60 mb-1">正文</h3>
                    <div class="text-sm whitespace-pre-wrap leading-relaxed">
                        {props.task.body}
                    </div>
                </div>
            </Show>
        </div>
    );
}

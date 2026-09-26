/**
 * PersonaDrawer — agent 人物面板（主从视图：左列人物、右侧属性编辑器）
 *
 * 为什么要有这个面板（而不是下拉菜单）：
 *   人物是**全局配置实体**，不是本任务的一个选项。下拉只够"选"，而这个界面的核心动作是
 *   **改配置并看见影响面** —— 改一次模型，所有引用它的任务下一轮都会跟着换。所以：
 *     · 左侧列表带**引用计数**（"3 个任务"）—— 改之前先看见会影响谁，这是本设计的初衷
 *     · 右侧是直接编辑器（改完即存，无编辑态 —— 与详情面板的结构化字段同一套交互）
 *
 * 两个动作在语义上分开（混在一起必然误操作）：
 *   · 「用于本任务」= 换绑本任务的引用（局部、可随手改）
 *   · 右侧改属性   = 改人物定义本身（全局，所以旁边写着"影响 N 个任务"）
 *
 * 形态取舍：
 *   · **贴顶 drawer，下方留白**：改人物时常要对着会话里的消息反复核对（这个词该用哪个模型），
 *     把整个下半屏留给输入框与消息流，改完就能直接发一条试 —— 改成全屏抽屉就得来回切。
 *   · **模型与档位用平铺按钮，不用 `<select>`**：两三个选项的下拉要多一次"展开→找→点"，
 *     而且原生 select 的弹层由 OS 绘制（自动化都点不进，只能派发合成事件）。平铺一眼全见、一次命中。
 *
 * 暂无"删除人物"：删掉后所有引用者会**静默回落**到缺省人物（换模型不打招呼）。
 * 要下线一个人物，改它的模型/口气即可（引用者原地跟随）；真需要删除时，得先设计
 * "引用迁移"（把这 N 个任务改绑到别处）一起做 —— 半截的删除比没有更糟。
 */

import { createSignal, createEffect, on, For, Show } from "solid-js";
import { personaStore } from "../store/personaStore";
import { taskStore } from "../store/taskStore";
import { notificationStore } from "../store/notificationStore";
import { reasoningEffortLabel } from "../../shared/reasoning-effort";

/** 平铺选项按钮：选中态用主色底，未选中 hover 亮一点（与详情面板的结构化字段同一套观感） */
function ChoiceButton(props: {
    label: string;
    hint?: string;
    active: boolean;
    disabled?: boolean;
    onClick: () => void;
}) {
    return (
        <button
            class={`btn btn-xs ${props.active ? "btn-primary" : "btn-ghost border border-base-300"}`}
            disabled={props.disabled}
            aria-pressed={props.active}
            aria-label={props.label}
            title={props.hint ?? props.label}
            onClick={(e) => {
                e.stopPropagation();
                props.onClick();
            }}
        >
            {props.label}
        </button>
    );
}

export function PersonaDrawer(props: { open: boolean; onClose: () => void }) {
    /** 右侧正在编辑的人物 id（空白态 = 新建，见 creating） */
    const [editing, setEditing] = createSignal<string | null>(null);
    const [creating, setCreating] = createSignal(false);
    const [newName, setNewName] = createSignal("");
    /** 名字输入框的本地草稿（onBlur/Enter 才提交 —— 逐键写盘会把中间态也存下来） */
    const [nameDraft, setNameDraft] = createSignal("");
    const [busy, setBusy] = createSignal(false);

    /**
     * 用户是否**主动**选过左侧某一项。
     *
     * 这个标记是必须的，不是防抖技巧：面板要"默认指向本任务在用的人物"，
     * 而那个值（taskStore.selectedTask.persona）是**异步**到达的 —— 打开面板的瞬间可能还没有。
     * 若只在打开那一刻取一次并锁死，就会停在当时的兜底值（缺省人物）上，用户以为在改自己的
     * 人物，实际改的是缺省人物这个**全局**配置，代价是所有引用它的任务跟着变。
     * 所以：未主动选择前，跟随本任务绑定；一旦用户点了别人，就听用户的。
     */
    const [manualPick, setManualPick] = createSignal(false);

    createEffect(on(() => props.open, (open) => {
        if (!open) return;
        setCreating(false);
        setNewName("");
        setManualPick(false);
        setEditing(personaStore.idForTask());
        void personaStore.load(true);
    }));

    // 校准：清单/任务详情陆续到达时保持"右侧编辑的是本任务在用的人物"（用户没主动选过才跟随）
    createEffect(() => {
        if (creating() || personaStore.loading || manualPick()) return;
        const list = personaStore.personas;
        if (list.length === 0) return;
        const boundId = personaStore.idForTask();
        const target = list.some((p) => p.id === boundId) ? boundId : list[0]!.id;
        if (editing() !== target) setEditing(target);
    });

    // 切人物时把名字草稿同步过去（否则会带着上一个人的名字）
    createEffect(on(() => editing(), () => setNameDraft(current()?.name ?? "")));

    const current = () => (creating() ? null : personaStore.defOf(editing() ?? ""));
    const boundId = () => personaStore.idForTask();

    /** 保存（改完即存）。新建时用输入框里的名字；更新时按 patch 改。 */
    const save = async (patch: { name?: string; model?: string; reasoningEffort?: string; style?: string }) => {
        setBusy(true);
        try {
            if (creating()) {
                const name = newName().trim();
                if (!name) {
                    notificationStore.addToast("error", "人物名不能为空");
                    return;
                }
                const id = await personaStore.save({ name, model: patch.model });
                if (id) {
                    setCreating(false);
                    setEditing(id);
                    setNewName("");
                    notificationStore.addToast("success", `人物「${name}」已创建（默认模型，可在右侧改）`);
                }
                return;
            }
            const id = editing();
            if (!id) return;
            await personaStore.save({ id, ...patch });
        } finally {
            setBusy(false);
        }
    };

    /** 提交名字（blur / Enter）：空名拒绝、没变不写 */
    const commitName = () => {
        const id = editing();
        if (!id) return;
        const next = nameDraft().trim();
        if (!next) {
            notificationStore.addToast("error", "人物名不能为空");
            setNameDraft(current()?.name ?? "");
            return;
        }
        if (next === current()?.name) return;
        void save({ name: next });
    };

    return (
        <Show when={props.open}>
            {/* 贴顶 drawer：下方留白给输入框与消息流（改人物时常要对着消息反复核对，
                全屏会挡住"我刚在聊什么"）。点遮罩或 ✕ 关闭。 */}
            <div class="fixed inset-0 z-[70] flex flex-col">
                <div class="absolute inset-0 bg-black/25" onClick={props.onClose} />
                <div
                    class="relative flex h-[min(26rem,55vh)] shrink-0 flex-col border-b border-base-300 bg-base-100 shadow-2xl"
                    data-testid="persona-drawer"
                    // 归属任务：一个 tab 一个面板实例，多个 tab 同时挂载时同名字元素会重复。
                    // 自动化（以及排查）都必须能指名道姓地找到"我这个任务的面板"。
                    data-uri={taskStore.selectedUri ?? ""}
                    data-editing={creating() ? "" : (editing() ?? "")}
                    data-bound={boundId()}
                    data-default={personaStore.defaultPersona}
                >
                    {/* 头部 */}
                    <div class="flex shrink-0 items-center gap-2 border-b border-base-300 px-4 py-2">
                        <span class="text-sm font-semibold">agent 人物</span>
                        <span class="text-[11px] opacity-50">
                            人物决定模型与参数；改它会影响所有引用它的任务（下一轮生效）
                        </span>
                        <button class="btn btn-ghost btn-xs ml-auto" aria-label="关闭人物面板" onClick={props.onClose}>
                            ✕
                        </button>
                    </div>

                    <div class="flex min-h-0 flex-1">
                        {/* ── 左：人物列表（主视图） ── */}
                        <div class="flex w-60 shrink-0 flex-col border-r border-base-300">
                            <div class="flex-1 overflow-y-auto p-2">
                                <Show when={personaStore.loading}>
                                    <div class="px-2 py-1 text-[11px] opacity-50">加载中…</div>
                                </Show>
                                <For each={personaStore.personas}>
                                    {(p) => (
                                        <button
                                            class={`mb-1 flex w-full flex-col items-start gap-0.5 rounded-box px-2 py-1.5 text-left transition-colors ${
                                                !creating() && p.id === editing() ? "bg-primary/15" : "hover:bg-base-200"
                                            }`}
                                            aria-label={`人物 ${p.name}`}
                                            onClick={() => { setCreating(false); setManualPick(true); setEditing(p.id); }}
                                        >
                                            <span class="flex w-full items-center gap-1">
                                                <span class="truncate text-xs font-medium">{p.name}</span>
                                                <Show when={p.id === personaStore.defaultPersona}>
                                                    <span class="badge badge-xs badge-ghost shrink-0">缺省</span>
                                                </Show>
                                                <Show when={p.id === boundId()}>
                                                    <span class="badge badge-xs badge-primary shrink-0">本任务</span>
                                                </Show>
                                            </span>
                                            <span class="w-full truncate text-[10px] opacity-60">
                                                {p.model} · {reasoningEffortLabel(p.reasoningEffort)}
                                            </span>
                                            {/* 引用面：改人物前先看见会影响谁 */}
                                            <span class="text-[10px] opacity-40">
                                                {p.taskCount > 0 ? `${p.taskCount} 个任务在用` : "暂无任务在用"}
                                            </span>
                                        </button>
                                    )}
                                </For>
                            </div>
                            <div class="shrink-0 border-t border-base-300 p-2">
                                <button
                                    class={`btn btn-ghost btn-xs w-full justify-start ${creating() ? "bg-primary/15" : ""}`}
                                    onClick={() => { setCreating(true); setNewName(""); }}
                                >
                                    ＋ 新建人物
                                </button>
                            </div>
                        </div>

                        {/* ── 右：选中人物的属性（从视图） ── */}
                        <div class="min-w-0 flex-1 overflow-y-auto px-4 py-3">
                            <Show
                                when={creating() || current()}
                                fallback={<div class="text-xs opacity-60">没有可用人物。</div>}
                            >
                                {/* 名字：可改（引用用 id，改名不影响任何任务的绑定） */}
                                <div class="mb-3 flex items-center gap-2">
                                    <span class="w-14 shrink-0 text-[11px] opacity-60">名字</span>
                                    <Show
                                        when={creating()}
                                        fallback={
                                            <>
                                                <input
                                                    class="input input-sm input-bordered w-56"
                                                    value={nameDraft()}
                                                    disabled={busy()}
                                                    aria-label="人物名字"
                                                    onInput={(e) => setNameDraft(e.currentTarget.value)}
                                                    onBlur={commitName}
                                                    onKeyDown={(e) => {
                                                        if (e.key === "Enter") { e.preventDefault(); commitName(); }
                                                    }}
                                                />
                                                <span class="text-[10px] opacity-40">
                                                    改名不影响引用（任务存的是 id {editing()}）
                                                </span>
                                            </>
                                        }
                                    >
                                        <input
                                            class="input input-sm input-bordered w-56"
                                            placeholder="人物名（如 Mimo / 审查员）"
                                            value={newName()}
                                            onInput={(e) => setNewName(e.currentTarget.value)}
                                            aria-label="新人物名字"
                                        />
                                    </Show>
                                </div>

                                {/* 模型：平铺按钮（一眼全见，一次命中；下拉要多一次展开） */}
                                <div class="mb-3 flex items-start gap-2">
                                    <span class="mt-1 w-14 shrink-0 text-[11px] opacity-60">模型</span>
                                    <div class="flex flex-wrap gap-1">
                                        <For each={personaStore.models}>
                                            {(m) => (
                                                <ChoiceButton
                                                    // 显示 **id**：那才是发给上游、也是存在配置里的值。
                                                    // 上游的 name 与 id 经常对不上（"看着 GPT 5.6、实际发 mimo"）
                                                    label={m.id}
                                                    active={current()?.model === m.id}
                                                    disabled={busy() || creating()}
                                                    onClick={() => void save({ model: m.id })}
                                                />
                                            )}
                                        </For>
                                        <Show when={creating()}>
                                            <span class="self-center text-[10px] opacity-50">
                                                创建后点选模型（新建先给默认模型）
                                            </span>
                                        </Show>
                                    </div>
                                </div>

                                {/* 思考级别：候选集由**该模型**决定（各家词表不同，见 shared/models.ts） */}
                                <div class="mb-3 flex items-start gap-2">
                                    <span class="mt-1 w-14 shrink-0 text-[11px] opacity-60">思考级别</span>
                                    <div class="flex flex-wrap gap-1">
                                        <For each={personaStore.reasoningChoices(current()?.model ?? "")}>
                                            {(v) => (
                                                <ChoiceButton
                                                    label={reasoningEffortLabel(v)}
                                                    hint={`reasoning effort: ${v}`}
                                                    active={current()?.reasoningEffort === v}
                                                    disabled={busy() || creating()}
                                                    onClick={() => void save({ reasoningEffort: v })}
                                                />
                                            )}
                                        </For>
                                    </div>
                                </div>

                                {/* 口气：注入身份节（identity.md 的 {{persona.style}}） */}
                                <div class="mb-3 flex items-start gap-2">
                                    <span class="mt-1 w-14 shrink-0 text-[11px] opacity-60">口气</span>
                                    <textarea
                                        class="textarea textarea-sm textarea-bordered min-h-[56px] flex-1 leading-relaxed"
                                        placeholder="注入系统提示词的身份节，如：每次回答前先称一声「sir」。留空 = 不注入。"
                                        value={current()?.style ?? ""}
                                        disabled={busy() || creating()}
                                        aria-label="人物口气"
                                        onBlur={(e) => {
                                            if (e.currentTarget.value !== (current()?.style ?? "")) {
                                                void save({ style: e.currentTarget.value });
                                            }
                                        }}
                                    />
                                </div>

                            </Show>
                        </div>
                    </div>

                    {/* 动作条固定在抽屉页脚（不随右侧属性区滚动）：实测把按钮放进滚动区时，
                        小屏/内容多时按钮被裁到可视区外 —— 点击落到遮罩上，面板被直接关掉。 */}
                    <div class="flex shrink-0 flex-wrap items-center gap-2 border-t border-base-300 px-4 py-2">
                        {/* 两个动作**必须分开** —— 一个只影响本任务，一个影响所有引用者 */}
                        <Show when={!creating()}>
                                <button
                                    class="btn btn-primary btn-sm"
                                    aria-label="用于本任务"
                                    disabled={busy() || editing() === boundId()}
                                    onClick={() => void personaStore.bindCurrentTask(editing()!)}
                                >
                                    {editing() === boundId() ? "本任务正在用" : "用于本任务"}
                                </button>
                                <button
                                    class="btn btn-ghost btn-sm"
                                    aria-label="设为缺省人物"
                                    disabled={busy() || editing() === personaStore.defaultPersona}
                                    onClick={() => void personaStore.setDefault(editing()!)}
                                >
                                    设为缺省人物
                                </button>
                                <span class="text-[11px] opacity-50">
                                    改上面的属性 = 影响 {current()?.taskCount ?? 0} 个任务（下一轮生效）
                                </span>
                        </Show>
                        <Show when={creating()}>
                            <button
                                class="btn btn-primary btn-sm"
                                disabled={busy() || !newName().trim()}
                                onClick={() => void save({})}
                            >
                                创建
                            </button>
                        </Show>
                    </div>
                </div>
            </div>
        </Show>
    );
}

/**
 * PersonaDrawer — agent 人物面板（主从视图：左列人物、右侧属性编辑器）
 *
 * 为什么不是下拉菜单（本组件存在的理由）：
 *   人物是**全局配置实体**，不是本任务的一个选项。下拉只够"选"，而这个界面的核心动作是
 *   **改配置并看见影响面** —— 改一次模型，所有引用它的任务下一轮都会跟着换。所以：
 *     · 左侧列表带**引用计数**（"3 个任务"）—— 改之前先看见会影响谁，这是本设计的初衷
 *     · 右侧是四个属性的**直接编辑器**（改完即存，无编辑态 —— 与详情面板的结构化字段同一套交互）
 *
 * 两个动作在语义上分开（混在一起必然误操作）：
 *   · 「用于本任务」= 换绑本任务的引用（触点小、局部、可随手改）
 *   · 右侧改属性   = 改人物定义本身（影响所有引用者，所以旁边写着"影响 N 个任务"）
 *
 * 暂无"删除人物"：删掉后所有引用者会**静默回落**到缺省人物（换模型不打招呼）。
 * 要下线一个人物，改它的模型/口气即可（引用者原地跟随）；真需要删除时，得先设计
 * "引用迁移"（把这 N 个任务改绑到别处）一起做 —— 半截的删除比没有更糟。
 */

import { createSignal, createEffect, on, For, Show } from "solid-js";
import { personaStore } from "../store/personaStore";
import { notificationStore } from "../store/notificationStore";
import { reasoningEffortLabel } from "../../shared/reasoning-effort";


/**
 * 受控 `<select>` 的可靠绑定 —— **必须用这个，不能只写 `value={...}`**。
 *
 * 踩到的真实缺陷：Solid 的 `value` 属性在**选项还没渲染**时设置无效 —— 浏览器找不到匹配的
 * option 就回落到第一个；而本面板的选项（模型清单 / 该模型的档位）是**异步**到达的，
 * 到达后 Solid 不会再应用一次 value（它只在该表达式依赖的 signal 变化时更新）。
 * 症状：右侧选中的是「面板人物」（mimo），模型下拉却显示「GPT 5.6 Luna」（大副的）——
 * 用户看着一个模型、改的是另一个人物的配置。这类"显示与实际不符"是最难查的一类 bug。
 *
 * 做法：把 value 与**选项来源**一起作为依赖，选项就绪后重新对齐 DOM 的值。
 */
function useSelectValue(value: () => string, deps: () => unknown) {
    let el: HTMLSelectElement | undefined;
    createEffect(() => {
        value();
        deps(); // 选项数量变化（清单/档位到达）后也要重新对齐
        if (el && el.value !== value()) el.value = value();
    });
    return (node: HTMLSelectElement) => {
        el = node;
    };
}

export function PersonaDrawer(props: { open: boolean; onClose: () => void }) {
    /** 右侧正在编辑的人物名（null = 尚未选中，取第一个） */
    const [editing, setEditing] = createSignal<string | null>(null);
    /** 新建态：右侧显示一张空表单（名字可填） */
    const [creating, setCreating] = createSignal(false);
    const [newName, setNewName] = createSignal("");
    const [busy, setBusy] = createSignal(false);

    /**
     * 用户是否**主动**选过左侧某一项。
     *
     * 这个标记是必须的，不是防抖技巧：面板要"默认指向本任务在用的人物"，
     * 而那个值（taskStore.selectedTask.persona）是**异步**到达的 —— 打开面板的瞬间可能还没有。
     * 若只在打开那一刻取一次并锁死，就会停在当时的兜底值（缺省人物）上，用户以为在改自己的
     * 人物，实际改的是"大副"这个**全局**配置，代价是所有引用它的任务跟着变。
     * 所以：未主动选择前，跟随本任务绑定；一旦用户点了别人，就听用户的。
     */
    const [manualPick, setManualPick] = createSignal(false);

    createEffect(on(() => props.open, (open) => {
        if (!open) return;
        setCreating(false);
        setNewName("");
        setManualPick(false);
        setEditing(personaStore.nameForTask());
        void personaStore.load(true);
    }));

    // 校准：清单/任务详情陆续到达时保持"右侧编辑的是本任务在用的人物"（用户没主动选过才跟随）
    createEffect(() => {
        if (creating() || personaStore.loading || manualPick()) return;
        const list = personaStore.personas;
        if (list.length === 0) return;
        const bound = personaStore.nameForTask();
        const target = list.some((p) => p.name === bound) ? bound : list[0]!.name;
        if (editing() !== target) setEditing(target);
    });

    const current = () => (creating() ? null : personaStore.defOf(editing() ?? ""));

    /** 保存（改完即存）：整份定义提交 —— model 变了档位可能失效，由 main 侧兜底到该模型默认档 */
    const save = async (patch: { model?: string; reasoningEffort?: string; style?: string; desc?: string }) => {
        const name = creating() ? newName().trim() : (editing() ?? "");
        if (!name) {
            notificationStore.addToast("error", "人物名不能为空");
            return;
        }
        setBusy(true);
        try {
            await personaStore.save(name, patch);
            if (creating()) {
                setCreating(false);
                setEditing(name);
                setNewName("");
                notificationStore.addToast("success", `人物「${name}」已创建`);
            }
        } finally {
            setBusy(false);
        }
    };

    /** 换绑本任务（只改引用，不动任何人的配置） */
    const useForTask = async (name: string) => {
        await personaStore.bindCurrentTask(name);
    };

    const setDefault = async (name: string) => {
        await personaStore.setDefault(name);
    };

    /** 当前任务的绑定名（决定"用于本任务"按钮是否已选中） */
    const boundName = () => personaStore.nameForTask();

    return (
        <Show when={props.open}>
            {/* drawer-end：从右侧滑出（与详情抽屉同一侧的习惯位置） */}
            <div class="fixed inset-0 z-[70] flex justify-end">
                {/* 遮罩：点它关闭（与 daisyUI drawer 的 backdrop 同一语义） */}
                <div class="absolute inset-0 bg-black/30" onClick={props.onClose} />
                {/* data-* 供自动化断言（人物面板的状态是"选谁/谁在用"，扫 DOM 文本会被文案漂移干扰） */}
                <div
                    class="relative flex h-full w-[min(56rem,94vw)] flex-col bg-base-100 shadow-2xl"
                    data-testid="persona-drawer"
                    data-editing={creating() ? "" : (editing() ?? "")}
                    data-bound={boundName()}
                    data-default={personaStore.defaultPersona}
                >
                    {/* 头部 */}
                    <div class="flex shrink-0 items-center gap-2 border-b border-base-300 px-4 py-3">
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
                        <div class="flex w-64 shrink-0 flex-col border-r border-base-300">
                            <div class="flex-1 overflow-y-auto p-2">
                                <Show when={personaStore.loading}>
                                    <div class="px-2 py-1 text-[11px] opacity-50">加载中…</div>
                                </Show>
                                <For each={personaStore.personas}>
                                    {(p) => (
                                        <button
                                            class={`mb-1 flex w-full flex-col items-start gap-0.5 rounded-box px-2 py-1.5 text-left transition-colors ${
                                                !creating() && p.name === editing()
                                                    ? "bg-primary/15"
                                                    : "hover:bg-base-200"
                                            }`}
                                            aria-label={`人物 ${p.name}`}
                                            onClick={() => { setCreating(false); setManualPick(true); setEditing(p.name); }}
                                        >
                                            <span class="flex w-full items-center gap-1">
                                                <span class="truncate text-xs font-medium">{p.name}</span>
                                                <Show when={p.name === personaStore.defaultPersona}>
                                                    <span class="badge badge-xs badge-ghost shrink-0">缺省</span>
                                                </Show>
                                                <Show when={p.name === boundName()}>
                                                    <span class="badge badge-xs badge-primary shrink-0">本任务</span>
                                                </Show>
                                            </span>
                                            <span class="w-full truncate text-[10px] opacity-60">
                                                {personaStore.modelLabel(p.model)} · {reasoningEffortLabel(p.reasoningEffort)}
                                            </span>
                                            {/* 引用面：改人物前先看见会影响谁 */}
                                            <span class="text-[10px] opacity-40">
                                                {p.taskCount > 0 ? `${p.taskCount} 个任务在用` : "暂无任务在用"}
                                            </span>
                                        </button>
                                    )}
                                </For>
                            </div>
                            {/* 新建：人物只有"可复用"才有价值，不能新增就只剩内置那一个 */}
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
                        <div class="min-w-0 flex-1 overflow-y-auto p-4">
                            <Show when={creating() || current()} fallback={<div class="text-xs opacity-60">没有可用人物。</div>}>
                                {/* 名字：新建可填；已有只读（改名=换实体，涉及引用迁移，暂不做） */}
                                <div class="mb-3 flex items-center gap-2">
                                    <Show
                                        when={creating()}
                                        fallback={
                                            <span class="text-sm font-semibold">{editing()}</span>
                                        }
                                    >
                                        <input
                                            class="input input-sm input-bordered w-56"
                                            placeholder="人物名（如 Mimo / 审查员）"
                                            value={newName()}
                                            onInput={(e) => setNewName(e.currentTarget.value)}
                                        />
                                        <span class="text-[11px] opacity-50">创建后即可在下面设置模型与参数</span>
                                    </Show>
                                </div>

                                {/* 模型：决定 API 面（chat/responses）与上下文窗口 —— 人物最核心的一项 */}
                                <label class="mb-3 flex flex-col gap-1">
                                    <span class="text-[11px] opacity-60">模型</span>
                                    <select
                                        class="select select-sm select-bordered font-mono"
                                        ref={useSelectValue(() => current()?.model ?? "", () => personaStore.models.length)}
                                        disabled={busy() || personaStore.models.length === 0}
                                        onChange={(e) => void save({ model: e.currentTarget.value })}
                                    >
                                        <Show when={!current()?.model}>
                                            <option value="">选择模型…</option>
                                        </Show>
                                        <For each={personaStore.models}>
                                            {(m) => <option value={m.id}>{m.name}（{m.id}）</option>}
                                        </For>
                                    </select>
                                </label>

                                {/* 思考级别：候选集由**该模型**决定（各家词表不同，见 shared/models.ts）。
                                    换模型后档位可能失效 → main 侧写入前兜底成该模型默认档，故这里不写死默认值。 */}
                                <label class="mb-3 flex flex-col gap-1">
                                    <span class="text-[11px] opacity-60">思考级别</span>
                                    <select
                                        class="select select-sm select-bordered"
                                        ref={useSelectValue(
                                            () => current()?.reasoningEffort ?? "",
                                            () => personaStore.reasoningChoices(current()?.model ?? "").length,
                                        )}
                                        disabled={busy() || !current()?.model}
                                        onChange={(e) => void save({ reasoningEffort: e.currentTarget.value })}
                                    >
                                        <For each={personaStore.reasoningChoices(current()?.model ?? "")}>
                                            {(v) => <option value={v}>{reasoningEffortLabel(v)}（{v}）</option>}
                                        </For>
                                    </select>
                                    <span class="text-[10px] opacity-40">
                                        可选档位来自该模型的上游校验结果，各模型不同
                                    </span>
                                </label>

                                {/* 口气：注入身份节（identity.md 的 {{persona.style}}） */}
                                <label class="mb-3 flex flex-col gap-1">
                                    <span class="text-[11px] opacity-60">口气（注入系统提示词的身份节）</span>
                                    <textarea
                                        class="textarea textarea-sm textarea-bordered min-h-[72px] leading-relaxed"
                                        placeholder="如：每次回答前先称一声「sir」。留空 = 不注入。"
                                        value={current()?.style ?? ""}
                                        onBlur={(e) => void save({ style: e.currentTarget.value })}
                                    />
                                </label>

                                {/* 说明：只在选择器里展示，不注入提示词 */}
                                <label class="mb-4 flex flex-col gap-1">
                                    <span class="text-[11px] opacity-60">说明（仅用于列表展示，不进提示词）</span>
                                    <input
                                        class="input input-sm input-bordered"
                                        placeholder="如：轻量快问快答"
                                        value={current()?.desc ?? ""}
                                        onBlur={(e) => void save({ desc: e.currentTarget.value })}
                                    />
                                </label>

                                {/* 动作区：两个动作**必须分开** —— 一个只影响本任务，一个影响所有引用者 */}
                                <div class="flex flex-wrap items-center gap-2 border-t border-base-300 pt-3">
                                    <Show when={!creating()}>
                                        <button
                                            class="btn btn-primary btn-sm"
                                            aria-label="用于本任务"
                                            disabled={busy() || editing() === boundName()}
                                            onClick={() => void useForTask(editing()!)}
                                        >
                                            {editing() === boundName() ? "本任务正在用" : "用于本任务"}
                                        </button>
                                        <button
                                            class="btn btn-ghost btn-sm"
                                            aria-label="设为缺省人物"
                                            disabled={busy() || editing() === personaStore.defaultPersona}
                                            onClick={() => void setDefault(editing()!)}
                                        >
                                            设为缺省人物
                                        </button>
                                        <span class="text-[11px] opacity-50">
                                            改上面的属性 = 影响 {current()?.taskCount ?? 0} 个任务（下一轮生效）
                                        </span>
                                    </Show>
                                    <Show when={creating()}>
                                        <button class="btn btn-primary btn-sm" disabled={busy() || !newName().trim()} onClick={() => void save({})}>
                                            创建
                                        </button>
                                    </Show>
                                </div>
                            </Show>
                        </div>
                    </div>
                </div>
            </div>
        </Show>
    );
}

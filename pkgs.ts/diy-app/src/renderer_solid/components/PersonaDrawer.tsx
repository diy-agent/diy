/**
 * PersonaDrawer — agent 人物面板（主从视图：左列人物、右侧属性编辑器）
 *
 * 为什么要有这个面板（而不是下拉菜单）：
 *   人物是**全局配置实体**，不是本任务的一个选项。下拉只够"选"，而这个界面的核心动作是
 *   **改配置并看见影响面** —— 改一次模型，所有引用它的任务下一轮都会跟着换。所以：
 *     · 左侧列表带**引用计数**（"3 个任务"）—— 改之前先看见会影响谁，这是本设计的初衷
 *     · 右侧是直接编辑器（改完即存，无编辑态 —— 与详情面板的结构化字段同一套交互）
 *
 * 左列第一行是「**跟随缺省**」，它不是一个人物，是一个**绑定模式**：
 *   · 跟随缺省 = 任务 frontmatter 里**不写 persona 键**（新建任务的默认状态）
 *   · 固定绑定 = 写了某个 id（即使那恰好是当前缺省，语义也不同：缺省变了它不会跟）
 *   为什么必须显式给出这一行：不写键 = 跟随，是**隐式**状态；不给入口用户就没法"改回跟随"，
 *   也没法看出"我这个任务到底是固定的还是跟随的"（两者的界面表现必须不同）。
 *   单击它 → 右侧显示**说明态**（不给编辑器）：跟随态下改模型改的是缺省人物的**全局**定义，
 *   会影响所有跟随者，这种动作必须回到"选中那个人物再改"，不能在这里就顺手改了。
 *
 * 两个动作在语义上分开（混在一起必然误操作）：
 *   · **双击左列某一行**（人物或「跟随缺省」）= 本任务改用它并关掉面板（一次动作闭环）
 *   · 单击 + 右侧改属性  = 改人物定义本身（全局，所以旁边写着"影响 N 个任务"）
 *
 * 为什么换绑做成**双击**而不是一个「用于本任务」按钮：
 *   换绑是"选人干活"这个动作的终点，本来一次点击就该完事；按钮形态逼着用户
 *   "先单击选中 → 再去找按钮 → 点它 → 再手动关面板"，四个动作、还容易误点别人的面板。
 *   双击不需要额外控件，且**不会**与"单击查看/编辑"抢语义（单击仍是选中）。
 *   代价是双击在触屏/无障碍上不友好 —— 故 hover 时用 daisyUI tooltip 显示"双击选择此人物"
 *   （`title` 是浏览器原生提示，样式不受主题控制、且要等约 1 秒，与界面其他提示不一致）。
 *
 * 影响面写**面板内的 info 条**（紧贴头部 view bar 之下，与 DynamicBar 同族的细条），
 * 而不是底栏按钮旁边：那句话（"改右侧属性 = 影响 N 个任务"）描述的是**整个右侧区域**的后果，
 * 放在「设为缺省人物」这类**动作**旁边会被读成"这个按钮会影响 N 个任务" —— 歧义。
 *
 * 形态取舍：
 *   · **贴顶 drawer，下方留白**：改人物时常要对着会话里的消息反复核对（这个词该用哪个模型），
 *     把整个下半屏留给输入框与消息流，改完就能直接发一条试 —— 改成全屏抽屉就得来回切。
 *   · **模型与档位用平铺按钮，不用 `<select>`**：两三个选项的下拉要多一次"展开→找→点"，
 *     而且原生 select 的弹层由 OS 绘制（自动化都点不进，只能派发合成事件）。平铺一眼全见、一次命中。
 *
 * 新建人物**连同模型/档位/行为指令一起填**（不是"先建个名字、建完再改"）：
 *   · main 的 persona.set 里 model 是**必填**（没有模型的人物等于退回硬编码回落），
 *     所以"只能填名字"的新建其实建不出来 —— 要么报错，要么建出一个不能用的半成品。
 *   · 三块属性在新建态用的是**本地草稿**（不是立刻写盘）：没名字的空人物不该先落到配置里。
 *
 * 暂无"删除人物"：删掉后所有引用者会**静默回落**到缺省人物（换模型不打招呼）。
 * 要下线一个人物，改它的模型/行为指令即可（引用者原地跟随）；真需要删除时，得先设计
 * "引用迁移"（把这 N 个任务改绑到别处）一起做 —— 半截的删除比没有更糟。
 */

import { createSignal, createEffect, createMemo, on, For, Show } from "solid-js";
import { personaStore } from "../store/personaStore";
import { taskStore } from "../store/taskStore";
import { notificationStore } from "../store/notificationStore";
import { reasoningEffortLabel } from "../../shared/reasoning-effort";
import { DEFAULT_MODEL } from "../../shared/models";

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

/**
 * 「跟随缺省」在这一层用空串表示（`editing` 信号是 `string | null`）：
 *   · `null` = 什么都没选
 *   · `""`   = 选中的是「跟随缺省」那一行（不是一个真实人物 id —— 真实 id 形如 `persona/1`）
 *   · 其它   = 选中的人物 id
 * 底层的表示法（"删掉 persona 键"）也正好是空串，两边对得上，不必再造一个哨兵值。
 */
const FOLLOW_DEFAULT = "";

function escapeRegExp(value: string): string {
    return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** 搜索人物字段，并用 warning 浅底高亮命中词。 */
function HighlightText(props: { text: string; query: () => string }) {
    const chunks = createMemo(() => {
        const q = props.query().trim();
        return q ? props.text.split(new RegExp(`(${escapeRegExp(q)})`, "ig")) : [];
    });
    return (
        <Show when={props.query().trim()} fallback={<>{props.text}</>}>
            <For each={chunks()}>
                {(chunk, i) =>
                    i() % 2 ? (
                        <mark class="rounded bg-warning/40 px-0.5 text-inherit">{chunk}</mark>
                    ) : (
                        chunk
                    )
                }
            </For>
        </Show>
    );
}

export function PersonaDrawer(props: { open: boolean; onClose: () => void }) {
    /** 右侧正在编辑的人物 id（空白态 = 新建，见 creating） */
    const [editing, setEditing] = createSignal<string | null>(null);
    const [creating, setCreating] = createSignal(false);
    const [newName, setNewName] = createSignal("");
    /** 新建态的模型/档位/行为指令草稿（创建时一并提交；**不逐项写盘** —— 还没名字的人物不该先落到配置里） */
    const [newModel, setNewModel] = createSignal("");
    const [newEffort, setNewEffort] = createSignal("");
    const [newInstructions, setNewInstructions] = createSignal("");
    /** 名字输入框的本地草稿（onBlur/Enter 才提交 —— 逐键写盘会把中间态也存下来） */
    const [nameDraft, setNameDraft] = createSignal("");
    const [busy, setBusy] = createSignal(false);
    const [search, setSearch] = createSignal("");
    const filteredPersonas = createMemo(() => {
        const q = search().trim().toLocaleLowerCase();
        if (!q) return personaStore.personas;
        return personaStore.personas.filter((p) =>
            [
                p.name,
                p.model,
                p.reasoningEffort,
                reasoningEffortLabel(p.reasoningEffort),
                p.instructions,
            ]
                .join("\n")
                .toLocaleLowerCase()
                .includes(q),
        );
    });
    const followMatchesSearch = () => {
        const q = search().trim().toLocaleLowerCase();
        if (!q) return true;
        const d = personaStore.defOf(personaStore.defaultPersona);
        return [
            "跟随缺省",
            d?.name ?? "",
            d?.model ?? "",
            d?.reasoningEffort ?? "",
            d ? reasoningEffortLabel(d.reasoningEffort) : "",
            d?.instructions ?? "",
        ]
            .join("\n")
            .toLocaleLowerCase()
            .includes(q);
    };

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

    createEffect(
        on(
            () => props.open,
            (open) => {
                if (!open) return;
                setCreating(false);
                setNewName("");
                setNewInstructions("");
                setSearch("");
                setManualPick(false);
                // 本任务跟随缺省时，右侧停在「跟随缺省」那一行（而不是解析出来的缺省人物 ——
                // 那会让人以为"我固定绑了它"，而实际是"跟着缺省走"）
                setEditing(personaStore.isFollowing() ? FOLLOW_DEFAULT : personaStore.idForTask());
                void personaStore.load(true);
            },
        ),
    );

    // 校准：清单/任务详情陆续到达时保持"右侧编辑的是本任务在用的那个"（用户没主动选过才跟随）。
    // 注意"跟随缺省"要**原样保住**（它是绑定模式，不是"没选到人"，不能被解析成缺省 id）
    createEffect(() => {
        if (creating() || personaStore.loading || manualPick()) return;
        const list = personaStore.personas;
        if (list.length === 0) return;
        let target: string;
        if (personaStore.isFollowing()) {
            target = FOLLOW_DEFAULT;
        } else {
            const boundId = personaStore.idForTask();
            target = list.some((p) => p.id === boundId) ? boundId : list[0]!.id;
        }
        if (editing() !== target) setEditing(target);
    });

    // 切人物时把名字草稿同步过去（否则会带着上一个人的名字）
    createEffect(
        on(
            () => editing(),
            () => setNameDraft(current()?.name ?? ""),
        ),
    );

    /** 右侧选中的是「跟随缺省」那一行（不是一个真实人物） */
    const editingFollow = () => !creating() && editing() === FOLLOW_DEFAULT;
    const current = () =>
        creating() || editingFollow() ? null : personaStore.defOf(editing() ?? "");
    /** 本任务固定绑定的人物 id（跟随缺省时为 null —— 与 idForTask 的"解析结果"不同） */
    const boundId = () => (personaStore.isFollowing() ? null : personaStore.idForTask());

    /** 右侧三块属性的**当前显示值**：新建态看草稿、编辑态看人物定义（统一一处，三块不必各写一套三元） */
    const shownModel = () => (creating() ? newModel() : (current()?.model ?? ""));
    const shownEffort = () => (creating() ? newEffort() : (current()?.reasoningEffort ?? ""));
    const shownInstructions = () =>
        creating() ? newInstructions() : (current()?.instructions ?? "");

    /**
     * 进入新建态：默认模型跟着"当前正在看的那个人物"（多半是照着它建一个），
     * 档位取该模型的默认档（不是上一个模型留下的档 —— 可能不被支持）。
     */
    const startCreate = () => {
        // 不取"清单首项"当默认（首项是展示顺序的产物，与"该用哪个模型"无关）：
        // 优先照抄当前正在看的那个人物；跟随缺省时照抄**当前生效的那个**（多半是想照着它建一个）
        const base =
            current()?.model ??
            personaStore.defOf(personaStore.idForTask())?.model ??
            DEFAULT_MODEL;
        setCreating(true);
        setNewName("");
        setNewModel(base);
        setNewEffort(personaStore.defaultReasoning(base) ?? "");
        setNewInstructions("");
    };

    /** 点模型：编辑态立即存；新建态只改草稿（并把档位收进**新模型**的支持集内） */
    const pickModel = (model: string) => {
        if (!creating()) {
            void save({ model });
            return;
        }
        setNewModel(model);
        const supported: string[] = personaStore.reasoningChoices(model);
        if (!supported.includes(newEffort()))
            setNewEffort(personaStore.defaultReasoning(model) ?? "");
    };

    /** 点档位：编辑态立即存；新建态只改草稿 */
    const pickEffort = (effort: string) => {
        if (!creating()) {
            void save({ reasoningEffort: effort });
            return;
        }
        setNewEffort(effort);
    };

    /**
     * 双击左列某人物 = 换绑本任务 + 关面板（本面板最常用的动作，一次点击闭环）。
     * 换绑失败**不关窗**（错误另有 toast，关掉会让人以为成功了）；已是本任务在用则只关窗。
     */
    const pickForTask = async (id: string) => {
        // 「跟随缺省」那一行：清掉绑定（已是跟随则什么都不做，直接关窗）
        if (id === FOLLOW_DEFAULT) {
            if (!personaStore.isFollowing()) {
                const ok = await personaStore.followDefault();
                if (!ok) return;
            }
            props.onClose();
            return;
        }
        if (id !== boundId()) {
            const ok = await personaStore.bindCurrentTask(id);
            if (!ok) return;
        }
        props.onClose();
    };

    /** 保存（改完即存）。新建时用输入框里的名字；更新时按 patch 改。 */
    const save = async (patch: {
        name?: string;
        model?: string;
        reasoningEffort?: string;
        instructions?: string;
    }) => {
        setBusy(true);
        try {
            if (creating()) {
                const name = newName().trim();
                if (!name) {
                    notificationStore.addToast("error", "人物名不能为空");
                    return;
                }
                // model 必填（main 侧同样拦）：没有模型的人物等于把模型交回硬编码回落
                const model = newModel();
                if (!model) {
                    notificationStore.addToast("error", "请先选一个模型（人物必须指定模型）");
                    return;
                }
                const id = await personaStore.save({
                    name,
                    model,
                    reasoningEffort: newEffort() || undefined, // 空 = 交给 main 取该模型默认档
                    instructions: newInstructions(),
                });
                if (id) {
                    // 顺序要紧：先 manualPick 再退新建态 —— 否则"跟随本任务绑定"的校准
                    // 会在同一拍里把右侧切回本任务在用的人物，刚建好的那个反而看不见了
                    setManualPick(true);
                    setCreating(false);
                    setEditing(id);
                    setNewName("");
                    notificationStore.addToast("success", `人物「${name}」已创建`);
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
                    class="relative flex h-[min(42rem,66.666vh)] shrink-0 flex-col border-b border-base-300 bg-base-100 shadow-2xl"
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
                        <span class="text-title font-semibold">agent 人物</span>
                        <span class="text-body opacity-50">
                            人物决定模型与参数；改它会影响所有引用它的任务（下一轮生效）
                        </span>
                        <button
                            class="btn btn-ghost btn-xs ml-auto"
                            aria-label="关闭人物面板"
                            onClick={props.onClose}
                        >
                            ✕
                        </button>
                    </div>

                    {/* 影响面提示条：**紧贴 view bar 之下**（与 DynamicBar 同族的细条：细、贴顶、随上下文存在）。
                        只在编辑态出现 —— 新建态还没有"会影响谁"可言，显示了反而像在说别人的事。
                        用细条而不是 daisyUI alert：alert 的语义是"消息"（role=alert，会被读屏当通知播报），
                        而这是常驻的语境说明。 */}
                    <Show when={!creating()}>
                        <div
                            class="flex shrink-0 items-center gap-2 border-b border-info/30 bg-info/15 px-4 py-1 text-body"
                            data-testid="persona-impact-bar"
                        >
                            <span class="opacity-70" aria-hidden="true">
                                ⓘ
                            </span>
                            <span>
                                改右侧属性 = 影响 {current()?.taskCount ?? 0} 个任务（下一轮生效）
                            </span>
                        </div>
                    </Show>

                    <div class="flex min-h-0 flex-1">
                        {/* ── 左：人物列表（主视图） ── */}
                        <div class="flex w-1/3 min-w-[18rem] shrink-0 flex-col border-r border-base-300">
                            {/* pb-9：给条目**下方**的 tooltip 留出空间 —— 这是 `overflow-y-auto` 容器，
                                悬浮提示是绝对定位在条目内的，贴着容器底边的那一项下方没有余量就会被裁掉
                                （daisyUI tooltip 被 overflow 容器裁剪是本项目踩过的坑）。
                                留白放在滚动内容的末端，视觉上就是列表尾部一点空隙，不占布局。 */}
                            <div class="flex-1 overflow-y-auto p-2 pb-9">
                                <div class="mb-2 flex items-center gap-2">
                                    <input
                                        class="input input-sm input-bordered min-w-0 flex-1"
                                        type="search"
                                        placeholder="搜索人物 / 模型 / 思考级别 / 行为指令"
                                        aria-label="搜索人物"
                                        value={search()}
                                        onInput={(e) => setSearch(e.currentTarget.value)}
                                        onKeyDown={(e) => {
                                            if (e.key === "Escape") {
                                                e.preventDefault();
                                                e.stopPropagation();
                                                setSearch("");
                                            }
                                        }}
                                    />
                                    <Show when={search().trim()}>
                                        <span class="shrink-0 text-caption opacity-60">
                                            {filteredPersonas().length} 个人物
                                        </span>
                                        <button
                                            class="btn btn-ghost btn-xs"
                                            aria-label="清除人物搜索"
                                            onClick={() => setSearch("")}
                                        >
                                            ✕
                                        </button>
                                    </Show>
                                </div>
                                {/* ── 绑定模式：跟随缺省（不是一个人物，是"不固定绑定"这一态）──
                                    放在列表**之上**并用分隔线隔开，是因为它与人物列表不是同类项：
                                    列表里每一项代表一个可选的"谁"，这一行代表"不要固定". */}
                                <Show when={followMatchesSearch()}>
                                    <div class="tooltip tooltip-bottom group block w-full">
                                        <div class="tooltip-content">
                                            双击选择此模式；点击箭头查看当前缺省人物
                                        </div>
                                        <div class="mb-1 flex w-full items-stretch gap-1">
                                            <button
                                                class={`min-w-0 flex-1 flex-col items-start gap-0.5 rounded-box px-2 py-1.5 text-left transition-colors ${
                                                    editingFollow()
                                                        ? "bg-primary/15"
                                                        : "hover:bg-base-200"
                                                }`}
                                                aria-label="跟随缺省人物"
                                                onClick={() => {
                                                    setCreating(false);
                                                    setManualPick(true);
                                                    setEditing(FOLLOW_DEFAULT);
                                                }}
                                                onDblClick={() => void pickForTask(FOLLOW_DEFAULT)}
                                            >
                                                <span class="flex w-full items-center gap-1">
                                                    <span class="truncate text-body font-medium">
                                                        跟随缺省
                                                    </span>
                                                </span>
                                                <span class="w-full truncate text-caption opacity-60">
                                                    缺省改变时，本任务下一轮跟着变
                                                </span>
                                                <span class="flex w-full items-center gap-1 truncate text-caption opacity-70">
                                                    <span class="shrink-0">↳ 当前缺省：</span>
                                                    <span class="truncate font-medium">
                                                        <HighlightText
                                                            text={personaStore.defaultPersonaName()}
                                                            query={search}
                                                        />
                                                    </span>
                                                    <span
                                                        class="truncate opacity-80"
                                                        title={(() => {
                                                            const d = personaStore.defOf(
                                                                personaStore.defaultPersona,
                                                            );
                                                            return d
                                                                ? `${d.model} · ${reasoningEffortLabel(d.reasoningEffort)}`
                                                                : "";
                                                        })()}
                                                    >
                                                        {(() => {
                                                            const d = personaStore.defOf(
                                                                personaStore.defaultPersona,
                                                            );
                                                            return d
                                                                ? ` · ${d.model} · ${reasoningEffortLabel(d.reasoningEffort)}`
                                                                : "";
                                                        })()}
                                                    </span>
                                                </span>
                                            </button>
                                            <button
                                                class="btn btn-ghost btn-xs my-auto h-5 min-h-0 shrink-0 px-1 tooltip tooltip-left"
                                                aria-label="跳转到当前缺省人物"
                                                data-tip="查看当前缺省人物的模型与行为指令"
                                                onClick={() => {
                                                    setManualPick(true);
                                                    setEditing(personaStore.defaultPersona);
                                                }}
                                            >
                                                ↗
                                            </button>
                                        </div>
                                    </div>
                                </Show>
                                <div class="my-1.5 border-t border-base-300" />

                                <Show when={personaStore.loading}>
                                    <div class="px-2 py-1 text-body opacity-50">加载中…</div>
                                </Show>
                                <Show when={!personaStore.loading && search().trim() && !followMatchesSearch() && filteredPersonas().length === 0}>
                                    <div class="px-2 py-3 text-center text-body opacity-60">
                                        没有匹配「{search().trim()}」的人物
                                    </div>
                                </Show>
                                <For each={filteredPersonas()}>
                                    {(p) => (
                                        // tooltip 包在**外层**：daisyUI 的 `.tooltip` 自带 `display:inline-block`，
                                        // 直接挂到下边那个 flex 按钮上会和 `flex` 抢 display（纵向排布会塌）。
                                        // 提示用 `<div class="tooltip-content">` 而不是 `data-tip`：后者是
                                        // `:before` 伪元素，**测不到**（自动化只能断言属性存在，断言不了"真的显示了、
                                        // 且没被容器裁掉"），而真实元素可以量 rect。
                                        // `block` 是必需的：不要它，每项会退化成 inline-block，行盒之间多出空隙。
                                        <div class="tooltip tooltip-bottom group block w-full">
                                            <div class="tooltip-content">双击选择此人物</div>
                                            <div class="mb-1 flex w-full items-stretch gap-1">
                                                <button
                                                    class={`min-w-0 flex-1 flex-col items-start gap-0.5 rounded-box px-2 py-1.5 text-left transition-colors ${
                                                        !creating() && p.id === editing()
                                                            ? "bg-primary/15"
                                                            : "hover:bg-base-200"
                                                    }`}
                                                    aria-label={`人物 ${p.name}`}
                                                    onClick={() => {
                                                        setCreating(false);
                                                        setManualPick(true);
                                                        setEditing(p.id);
                                                    }}
                                                    onDblClick={() => void pickForTask(p.id)}
                                                >
                                                    <span class="flex w-full items-center gap-1">
                                                        <span class="truncate text-body font-medium">
                                                            <HighlightText text={p.name} query={search} />
                                                        </span>
                                                        <Show
                                                            when={
                                                                p.id === personaStore.defaultPersona
                                                            }
                                                        >
                                                            <span class="badge badge-xs badge-secondary badge-soft shrink-0">
                                                                缺省
                                                            </span>
                                                        </Show>
                                                    </span>
                                                    <span class="w-full truncate text-caption opacity-60">
                                                        <HighlightText
                                                            text={p.model}
                                                            query={search}
                                                        />
                                                        {" · "}
                                                        <HighlightText
                                                            text={reasoningEffortLabel(
                                                                p.reasoningEffort,
                                                            )}
                                                            query={search}
                                                        />
                                                    </span>
                                                    {/* 行为指令：每个人物下面只占一行，过长自然截断；空值也保留位置避免条目跳动 */}
                                                    <span
                                                        class="block w-full truncate text-caption opacity-50"
                                                        title={p.instructions || "未设置行为指令"}
                                                    >
                                                        <HighlightText
                                                            text={
                                                                p.instructions || "未设置行为指令"
                                                            }
                                                            query={search}
                                                        />
                                                    </span>
                                                </button>
                                                {/* 设为缺省是条目级动作：右对齐，默认不抢视线，hover 人物条目时出现。 */}
                                                <button
                                                    class="btn btn-secondary btn-xs my-1 shrink-0 self-start opacity-0 transition-opacity group-hover:opacity-100"
                                                    aria-label={`设人物 ${p.name} 为缺省`}
                                                    title="设为缺省人物"
                                                    disabled={
                                                        busy() ||
                                                        p.id === personaStore.defaultPersona
                                                    }
                                                    onClick={(e) => {
                                                        e.stopPropagation();
                                                        void personaStore.setDefault(p.id);
                                                    }}
                                                >
                                                    缺省
                                                </button>
                                            </div>
                                        </div>
                                    )}
                                </For>
                            </div>
                            <div class="shrink-0 border-t border-base-300 p-2">
                                <button
                                    class={`btn btn-ghost btn-xs w-full justify-start ${creating() ? "bg-primary/15" : ""}`}
                                    aria-label="新建人物"
                                    onClick={startCreate}
                                >
                                    ＋ 新建人物
                                </button>
                            </div>
                        </div>

                        {/* ── 右：选中人物的属性（从视图） ── */}
                        <div class="min-w-0 flex-1 overflow-y-auto px-4 py-3">
                            <Show
                                when={creating() || current()}
                                fallback={
                                    // 跟随缺省态：右侧**不给编辑器**。给了的话用户会以为
                                    // "我在改我这个任务的设置"，实际改的是缺省人物这个**全局**定义，
                                    // 连带影响所有跟随者 —— 这种动作必须回到"选中那个人物再改"。
                                    <Show
                                        when={editingFollow()}
                                        fallback={
                                            <div class="text-body opacity-60">没有可用人物。</div>
                                        }
                                    >
                                        <div
                                            class="max-w-[46rem] space-y-2 text-body"
                                            data-testid="persona-follow-pane"
                                        >
                                            <div class="flex items-center gap-2">
                                                <span class="badge badge-xs badge-primary">
                                                    本任务
                                                </span>
                                                <span class="font-medium">跟随缺省人物</span>
                                            </div>
                                            <p class="leading-relaxed opacity-70">
                                                本任务不固定人物，始终使用**当前的**缺省人物；缺省改变时，本任务下一轮起跟着变。
                                            </p>
                                            <div class="rounded-box border border-base-300 px-3 py-2">
                                                <div class="flex items-center gap-1">
                                                    <span class="opacity-60">当前缺省：</span>
                                                    <span class="font-medium">
                                                        {personaStore.defaultPersonaName()}
                                                    </span>
                                                    <span class="badge badge-xs badge-ghost">
                                                        缺省
                                                    </span>
                                                </div>
                                                <div class="mt-1 opacity-70">
                                                    {personaStore.defOf(personaStore.defaultPersona)
                                                        ?.model ?? ""}
                                                    {" · "}
                                                    {reasoningEffortLabel(
                                                        personaStore.defOf(
                                                            personaStore.defaultPersona,
                                                        )?.reasoningEffort ?? "",
                                                    )}
                                                </div>
                                                <div class="mt-1 opacity-50">
                                                    {personaStore.defOf(personaStore.defaultPersona)
                                                        ?.taskCount ?? 0}{" "}
                                                    个任务固定绑定了它；{personaStore.followCount}{" "}
                                                    个任务跟随缺省
                                                </div>
                                            </div>
                                            <p class="leading-relaxed opacity-60">
                                                ⓘ 想改模型 / 参数 / 行为指令，请在左列选中「
                                                {personaStore.defaultPersonaName()}」再改 ——
                                                那一处改的是人物定义本身， 会影响所有用它的任务。
                                            </p>
                                        </div>
                                    </Show>
                                }
                            >
                                {/* 名字：可改（引用用 id，改名不影响任何任务的绑定） */}
                                <div class="mb-3 flex items-center gap-2">
                                    <span class="w-14 shrink-0 text-body opacity-60">名字</span>
                                    <Show
                                        when={creating()}
                                        fallback={
                                            <>
                                                <input
                                                    class="input input-sm input-bordered w-56"
                                                    value={nameDraft()}
                                                    disabled={busy()}
                                                    aria-label="人物名字"
                                                    onInput={(e) =>
                                                        setNameDraft(e.currentTarget.value)
                                                    }
                                                    onBlur={commitName}
                                                    onKeyDown={(e) => {
                                                        if (e.key === "Enter") {
                                                            e.preventDefault();
                                                            commitName();
                                                        }
                                                    }}
                                                />
                                                <span class="text-caption opacity-40">
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
                                    <span class="mt-1 w-14 shrink-0 text-body opacity-60">
                                        模型
                                    </span>
                                    <div class="flex flex-wrap gap-1">
                                        <For each={personaStore.models}>
                                            {(m) => (
                                                <ChoiceButton
                                                    // 显示 **id**：那才是发给上游、也是存在配置里的值。
                                                    // 上游的 name 与 id 经常对不上（"看着 GPT 5.6、实际发 mimo"）
                                                    label={m.id}
                                                    // 新建态也按同一套值判选中：草稿与人物定义只差来源，
                                                    // 交互却必须一致（"看着亮的是 A、建出来是 B"是最坏的）
                                                    active={shownModel() === m.id}
                                                    disabled={busy()}
                                                    onClick={() => pickModel(m.id)}
                                                />
                                            )}
                                        </For>
                                        <Show when={creating() && personaStore.models.length === 0}>
                                            <span class="self-center text-caption opacity-50">
                                                模型清单未加载，稍候（人物必须指定模型）
                                            </span>
                                        </Show>
                                    </div>
                                </div>

                                {/* 思考级别：候选集由**该模型**决定（各家词表不同，见 shared/models.ts） */}
                                <div class="mb-3 flex items-start gap-2">
                                    <span class="mt-1 w-14 shrink-0 text-body opacity-60">
                                        思考级别
                                    </span>
                                    <div class="flex flex-wrap gap-1">
                                        <For each={personaStore.reasoningChoices(shownModel())}>
                                            {(v) => (
                                                <ChoiceButton
                                                    label={reasoningEffortLabel(v)}
                                                    hint={`reasoning effort: ${v}`}
                                                    active={shownEffort() === v}
                                                    disabled={busy()}
                                                    onClick={() => pickEffort(v)}
                                                />
                                            )}
                                        </For>
                                    </div>
                                </div>

                                {/* 行为指令：注入身份节（identity.md 的 {{persona.instructions}}）。
                                    命名为「行为指令」而不是「口气」：这里能写的不只是措辞语气，
                                    还有回答结构、专业程度、输出约束（`style`/`tone` 都太窄）。 */}
                                <div class="mb-3 flex items-start gap-2">
                                    <span class="mt-1 w-14 shrink-0 text-body opacity-60">
                                        行为指令
                                    </span>
                                    <textarea
                                        class="textarea textarea-sm textarea-bordered min-h-[56px] flex-1 leading-relaxed"
                                        placeholder="注入系统提示词的身份节，如：每次回答前先称一声「sir」。留空 = 不注入。"
                                        value={shownInstructions()}
                                        disabled={busy()}
                                        aria-label="人物行为指令"
                                        // 新建态只更新草稿（创建时一并提交）；编辑态改完即存 —— 两种语义别混
                                        onInput={(e) => {
                                            if (creating())
                                                setNewInstructions(e.currentTarget.value);
                                        }}
                                        onBlur={(e) => {
                                            if (creating()) return;
                                            if (
                                                e.currentTarget.value !==
                                                (current()?.instructions ?? "")
                                            ) {
                                                void save({ instructions: e.currentTarget.value });
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
                        {/* 动作条只留「换绑」这一句提示 + 新建态的「创建」。
                            **不在这里放「设为缺省人物」**：那是**条目级**动作（作用于某一个人物），
                            放页脚会读成"作用于当前正在看的这个人物" —— 而页脚与左列隔了一层，
                            用户得先确认"右侧编辑的是谁"才敢点。它已经挂在每个条目右侧（hover 显形），
                            那里"点它 = 改这一条"毫无歧义。 */}
                        <Show when={!creating()}>
                            <span class="text-body opacity-60">
                                {editingFollow()
                                    ? personaStore.isFollowing()
                                        ? "本任务正在跟随缺省"
                                        : "双击 = 本任务改为跟随缺省"
                                    : editing() === boundId()
                                      ? "本任务正在用它"
                                      : "双击 = 本任务改用它"}
                            </span>
                            <span class="ml-auto text-body opacity-50">
                                悬停人物条目 = 「缺省」按钮
                            </span>
                        </Show>
                        <Show when={creating()}>
                            <button
                                class="btn btn-primary btn-sm"
                                aria-label="创建人物"
                                // 名字与模型都齐了才能建（模型必填，见 save 的新建分支）
                                disabled={busy() || !newName().trim() || !newModel()}
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

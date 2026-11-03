/**
 * TaskFieldControls — 任务**属性字段**的编辑控件（状态 / 类型 / 模块 / 优先级）。
 *
 * 从 TaskDetailPanel 抽出来独立成文件：这些控件现在被两处用（任务属性块 + 别处的只读徽标），
 * 留在面板文件里会形成 **TaskDetailPanel ⇄ TaskDetailContent 循环 import**
 * （面板要用内容组件，内容组件要用这些控件）。
 *
 * 共同语义：**不进编辑态、改完即存**。它们是分类信息，与标题/正文（有草稿、防误清空）
 * 性质不同 —— 扫读任务时随手打标，多一次「进编辑态 → 保存」的往返就没人填了。
 */
import { createSignal, createMemo, createEffect, on, For, Show } from "solid-js";
import * as Select from "@kobalte/core/select";
import { taskStateColor } from "../../main/core/task-state";
import { CHANGE_TYPES, MODULES, PRIORITIES } from "../../main/core/task-fields";

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
            class="flex-1 min-w-0"
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
                        class="flex items-center gap-2 rounded px-2 py-1.5 text-body cursor-pointer data-[highlighted]:bg-base-200 data-[selected]:bg-primary/10"
                    >
                        <span class={`w-2 h-2 rounded-full inline-block shrink-0 ${taskStateColor(opt().value)}`} />
                        <span class="font-mono">{opt().value}</span>
                        <span class="opacity-70">{opt().label}</span>
                    </Select.Item>
                );
            }}
            sectionComponent={(s) => (
                <Select.Section class="contents">
                    <div class="px-2 py-1 text-caption font-semibold uppercase tracking-wide opacity-50">
                        {(s.section.rawValue as StateGroup).label}
                    </div>
                </Select.Section>
            )}
        >
            <Select.Trigger class="btn btn-outline btn-xs w-full min-w-0 border-base-300 px-2 cursor-pointer inline-flex justify-start items-center gap-2 disabled:opacity-50">
                <span class={`w-2 h-2 rounded-full inline-block ${taskStateColor(selected().value)}`} />
                <span class="font-mono truncate">{props.current}</span>
                <Select.Icon class="opacity-60 text-caption">▾</Select.Icon>
            </Select.Trigger>
            <Select.Portal>
                <Select.Content class="z-[60] min-w-[180px] rounded-lg border border-base-300 bg-base-100 p-1 shadow-xl">
                    <Select.Listbox class="max-h-64 space-y-0.5 overflow-auto" />
                </Select.Content>
            </Select.Portal>
        </Select.Root>
    );
}

/** 结构化字段的中文名（详情面板与表格共用同一套措辞） */
const FIELD_LABELS: Record<string, string> = {
    change_type: "类型",
    module: "模块",
    priority: "优先级",
};

/**
 * 单个结构化字段的下拉编辑（GitHub issue 侧栏那套：**改完即存**，不进编辑态）。
 *
 * 为什么不做成"编辑态里一起保存"：这几个字段是**分类信息**，与标题/正文（有草稿、防误清空）
 * 的性质不同 —— 它们要能在扫读任务时随手打标，多一次「进编辑态 → 保存」的往返就没人填了。
 * 空值选项（"— 未设置"）对应清除（空字符串），与 core/task.ts 的 triState 语义一致。
 */
export function TaskFieldSelect(props: {
    field: "change_type" | "priority";
    value?: string;
    saving: boolean;
    onSave: (v: string) => void;
}) {
    const options = props.field === "change_type" ? CHANGE_TYPES : PRIORITIES;
    // 历史手写值可能不在词表内（如 priority: high）：补一个入口显示出来，
    // 否则 select 会显示成"未设置"，看着像数据丢了（与 StateSelect 的兜底同思路）
    const unknown = () => !!props.value && !(options as readonly string[]).includes(props.value);
    return (
        <label class="task-field-row text-body">
            <span class="shrink-0 whitespace-nowrap opacity-50">{FIELD_LABELS[props.field]}</span>
            <select
                class="select select-xs select-bordered w-full min-w-0 flex-1 font-mono"
                disabled={props.saving}
                value={props.value ?? ""}
                onChange={(e) => props.onSave(e.currentTarget.value)}
            >
                <option value="">—</option>
                <Show when={unknown()}>
                    <option value={props.value}>{props.value}</option>
                </Show>
                <For each={options}>{(v) => <option value={v}>{v}</option>}</For>
            </select>
        </label>
    );
}

/**
 * module 编辑：自由字符串 + 建议清单（datalist）。
 * 不禁止自由输入 —— 取值还在演化，硬枚举会逼出「先塞进 test 再说」这种脏数据；
 * 清单（task-fields.ts 的 MODULES）只作建议。
 */
export function TaskModuleInput(props: { value?: string; saving: boolean; onSave: (v: string) => void }) {
    const [draft, setDraft] = createSignal(props.value ?? "");
    // 任务切换/外部更新时同步（props.value 是真相源；用户正在输入时不覆盖）
    createEffect(on(() => props.value, (v) => setDraft(v ?? ""), { defer: true }));
    const commit = () => {
        if (draft().trim() === (props.value ?? "")) return;
        props.onSave(draft().trim());
    };
    return (
        <label class="task-field-row text-body">
            <span class="shrink-0 whitespace-nowrap opacity-50">模块</span>
            <input
                class="input input-xs input-bordered w-full min-w-0 flex-1 font-mono"
                list="diy-task-modules"
                placeholder="agent/ui"
                value={draft()}
                disabled={props.saving}
                onInput={(e) => setDraft(e.currentTarget.value)}
                onBlur={commit}
                onKeyDown={(e) => {
                    if (e.key === "Enter") {
                        e.preventDefault();
                        commit();
                    }
                }}
            />
            <datalist id="diy-task-modules">
                <For each={MODULES}>{(m) => <option value={m} />}</For>
            </datalist>
        </label>
    );
}

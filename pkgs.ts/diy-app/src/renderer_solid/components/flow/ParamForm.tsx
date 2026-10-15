/**
 * ParamForm.tsx — **按 `params.schema` 自动渲染的参数表单**（##320 / ##311 §二）。
 *
 * 三条立场：
 *  1. **引擎只认可枚举类型全集**：`string | number | boolean | enum | list`（内核 `PARAM_TYPES`）。
 *     没有表单渲染方案的类型（嵌套对象 / 任意 JSON）内核根本不收 ⇒ 这里不必有"手写 JSON"的退路。
 *  2. **用户只改值，不提供拓扑编辑**：参数不得增删节点 / 边（改形 = 换一条工作流）。
 *  3. **两态**（订正 5 的收窄）：`position === null`（尚未进入）⇒ 可编辑并落盘（`diy flow params set`）；
 *     **已进入 ⇒ 只读** + 一句说明 —— 内核与宿主都拒「已进入还改参数」（换配置 = 另起一次运行）。
 *
 * 数据真源：值是 `flow show` 的 `params`（权威 = 任务目录 `flow/state.json`），声明是 `paramsSchema`。
 *
 * **为什么一律 `onInput`、不用 `onChange`**（##320 实测修）：
 *  - 文本 / 数字 / `list` 是**连续编辑**：原生 `change` 只在**失焦**时发。用户「改完直接点保存」时，
 *    输入框 blur 与保存按钮 click 是同一串鼠标事件里的两步 —— 谁先谁后取决于命中测试，不是契约。
 *    押 `onChange` 就是押这个竞态：实测点保存后**落盘的仍是旧值**（input 的 `.value` 已是新值，draft 没跟上）。
 *  - 复选框 / 单选同样走 `onInput`：真人激活时浏览器 **input 与 change 都发**（真实行为不变），
 *    而 DOM 驱动的自动化往往只派发其中一个 —— 统一一条通路，就不必赌对方派哪个。
 *  - 控件仍**受控**：`value` / `checked` 由 `draft()` 派生，`onInput` 只负责「事件 → draft」这一个方向。
 */
import { createEffect, createMemo, createSignal, For, on, Show } from "solid-js";
import { notificationStore } from "../../store/notificationStore";
import { paramKv, paramValueOf, saveParams, type FlowInstanceView, type FlowParamEntry, type ParamScalar, type ParamValue } from "../../lib/flow-view";

/** 值 → 控件文本（`list` 用逗号分隔 —— 与 CLI `--param` 同一形态） */
function toText(v: ParamValue): string {
    return Array.isArray(v) ? v.map((x) => String(x)).join(",") : String(v);
}
/** 控件文本 → 值（按声明类型还原；`list` 切逗号并去空项） */
function fromText(entry: FlowParamEntry, text: string): ParamValue {
    switch (entry.type) {
        case "number": {
            const n = Number(text);
            return Number.isFinite(n) ? n : (entry.default as number);
        }
        case "list":
            return text
                .split(",")
                .map((s) => s.trim())
                .filter((s) => s !== "")
                .map((s) => (Number.isFinite(Number(s)) && s.trim() !== "" ? Number(s) : s)) as ParamScalar[];
        default:
            return text;
    }
}

export function ParamForm(props: { view: FlowInstanceView; uri: string; onSaved?: (v: FlowInstanceView) => void }) {
    const [draft, setDraft] = createSignal<Record<string, ParamValue>>({});
    const [saving, setSaving] = createSignal(false);
    const [error, setError] = createSignal<string | null>(null);

    // 每次 view 变（首次装载 / 保存回执）都用**权威值**重置草稿
    createEffect(
        on(
            () => props.view,
            (v) => {
                const d: Record<string, ParamValue> = {};
                for (const e of v.paramsSchema) d[e.path] = paramValueOf(v, e);
                setDraft(d);
                setError(null);
            },
        ),
    );

    const byNode = createMemo(() => {
        const m = new Map<string, FlowParamEntry[]>();
        for (const e of props.view.paramsSchema) {
            const list = m.get(e.node) ?? [];
            list.push(e);
            m.set(e.node, list);
        }
        return [...m.entries()];
    });

    const editable = () => !props.view.entered;

    const save = async () => {
        setSaving(true);
        setError(null);
        try {
            const kvs = props.view.paramsSchema.map((e) => paramKv(e, draft()[e.path] ?? e.default));
            const next = await saveParams(props.uri, kvs);
            notificationStore.addToast("success", `参数已落盘（${kvs.length} 项）`);
            setDraft(Object.fromEntries(next.paramsSchema.map((e) => [e.path, paramValueOf(next, e)])));
            props.onSaved?.(next);
        } catch (e) {
            const msg = e instanceof Error ? e.message : String(e);
            setError(msg);
            notificationStore.addToast("error", `参数未保存：${msg}`);
        } finally {
            setSaving(false);
        }
    };

    return (
        <div class="flex flex-col gap-2 p-2 text-body" data-flow-params="">
            <div class="flex items-center gap-2">
                <span class="font-bold opacity-70">参数（L2 · 只改值）</span>
                <Show when={editable()}>
                    <span class="badge badge-xs badge-warning">未进入 · 可编辑</span>
                </Show>
                <Show when={!editable()}>
                    <span class="badge badge-xs badge-ghost" data-flow-params-readonly="1">
                        已进入 · 只读
                    </span>
                </Show>
            </div>

            <Show when={!editable()}>
                <div class="rounded border border-base-300 bg-base-300/30 p-2 opacity-70" data-flow-params-note="">
                    换配置 = **另起一次运行**：实例已进入工作流（position = {props.view.position}），内核与宿主都拒改参数值。
                    要改请清掉该任务目录的 `flow/` 后重开。
                </div>
            </Show>

            <Show when={props.view.paramsSchema.length > 0} fallback={<div class="opacity-50">该工作流未声明参数</div>}>
                <For each={byNode()}>
                    {([node, entries]) => (
                        <div class="rounded border border-base-300 p-2">
                            <div class="mb-1 font-mono opacity-60">{node}</div>
                            <div class="flex flex-col gap-1">
                                <For each={entries}>
                                    {(e) => (
                                        <label class="flex items-center gap-2" data-flow-param={e.path}>
                                            <span class="w-28 shrink-0 opacity-70" title={e.type}>
                                                {e.label}
                                            </span>
                                            <Show when={e.type === "boolean"}>
                                                <input
                                                    type="checkbox"
                                                    class="toggle toggle-sm"
                                                    disabled={!editable()}
                                                    data-flow-param-input={e.path}
                                                    checked={draft()[e.path] === true}
                                                    onInput={(ev) => setDraft({ ...draft(), [e.path]: ev.currentTarget.checked })}
                                                />
                                            </Show>
                                            <Show when={e.type === "enum"}>
                                                <span class="flex flex-wrap items-center gap-2">
                                                    <For each={e.enum ?? []}>
                                                        {(opt) => (
                                                            <span class="flex items-center gap-1">
                                                                <input
                                                                    type="radio"
                                                                    class="radio radio-xs"
                                                                    name={`flow-param-${e.path}`}
                                                                    disabled={!editable()}
                                                                    data-flow-param-input={e.path}
                                                                    value={opt}
                                                                    checked={draft()[e.path] === opt}
                                                                    onInput={() => setDraft({ ...draft(), [e.path]: opt })}
                                                                />
                                                                <span>{opt}</span>
                                                            </span>
                                                        )}
                                                    </For>
                                                </span>
                                            </Show>
                                            <Show when={e.type === "number"}>
                                                <input
                                                    type="number"
                                                    class="input input-xs w-24"
                                                    disabled={!editable()}
                                                    data-flow-param-input={e.path}
                                                    min={e.min}
                                                    max={e.max}
                                                    value={toText(draft()[e.path] ?? e.default)}
                                                    onInput={(ev) => setDraft({ ...draft(), [e.path]: fromText(e, ev.currentTarget.value) })}
                                                />
                                                <Show when={e.unit}>
                                                    <span class="opacity-60">{e.unit}</span>
                                                </Show>
                                            </Show>
                                            <Show when={e.type === "string" || e.type === "list"}>
                                                <input
                                                    type="text"
                                                    class="input input-xs flex-1"
                                                    disabled={!editable()}
                                                    data-flow-param-input={e.path}
                                                    placeholder={e.type === "list" ? "逗号分隔，如 a,b,c" : undefined}
                                                    value={toText(draft()[e.path] ?? e.default)}
                                                    onInput={(ev) => setDraft({ ...draft(), [e.path]: fromText(e, ev.currentTarget.value) })}
                                                />
                                            </Show>
                                            <span class="ml-auto font-mono opacity-40" title="类型">
                                                {e.type}
                                            </span>
                                        </label>
                                    )}
                                </For>
                            </div>
                        </div>
                    )}
                </For>
            </Show>

            <Show when={editable() && props.view.paramsSchema.length > 0}>
                <div class="flex items-center gap-2">
                    <button class="btn btn-xs btn-primary" disabled={saving()} data-flow-params-save="" onClick={() => void save()}>
                        {saving() ? "保存中…" : "保存参数"}
                    </button>
                    <span class="opacity-50">落盘 = 任务目录 flow/state.json（权威真源）</span>
                </div>
            </Show>
            <Show when={error()}>
                {(msg) => <div class="text-error" data-flow-params-error="">{msg()}</div>}
            </Show>
        </div>
    );
}

/**
 * UsageTable — 用量表的**唯一渲染实现**（##443 刀 3）。
 *
 * 一份列定义（`shared/usage-fields.ts` 的 `USAGE_FIELDS`）按粒度过滤出列，再由
 * `aggregateUsage()` 出四级行（step / turn / persona / session）与「窗口构成」视图：
 * 表头、单元格、合计行、下钻全部走同一条路径 —— 不再每张表手写 `<th>`/`<td>`
 * （旧实现散在 UsagePanel 的 A/B/C 三处 + CompactSessionPanel 的历史表，见任务 body §三）。
 *
 * 与旧表的三个**行为差异**（有意为之，不是遗漏）：
 *   1. 只有**一行表头**：旧的双表头（`colspan` 分组行）是"同一批字段换个叫法"的产地，
 *      分组信息改由列名 + hover 说明承载（`spec.hint`）。
 *   2. 合计行**置顶**且恒取 `session` 粒度（不是各行的和再算一遍）：它就是
 *      `aggregateUsage(rows,"session")` 那一行 —— 与组行同源同口径（旧 tfoot 是另算一遍）。
 *   3. **窗口构成不求和**：它只在 `contextParts` 视图里出现（仅 step 粒度），没有合计行。
 *
 * 下钻 = **同一张表换参数**：`turn` 行 → `view="step" + filter(turnId)`，
 * `persona` 行 → `view="turn" + filter(persona)`。调用方只负责压面包屑栈。
 */

import { createMemo, createSignal, For, Show } from "solid-js";
import type { CompactEventRecord } from "@diy-agent/compaction/compaction";
import { mapCompactPointsToSteps } from "@diy-agent/compaction/compact-points";
import {
    USAGE_FIELDS,
    aggregateUsage,
    columnsFor,
    fmtCell,
    isPartial,
    type FieldValue,
    type Gran,
    type UsageFieldSpec,
    type UsageFilter,
    type UsageRow,
} from "../../shared/usage-fields";
import type { StepUsageRecord } from "../../shared/usage";
import {
    deliveryBadgeText,
    deliveryBadgeTitle,
    TRIGGER_LABEL,
    type DeliveryBoundary,
} from "../../shared/context/delivery-badge";

/** 视图 = 粒度 + 一个「窗口构成」子集视图（它不是第五级粒度，只是列不同） */
export type UsageView = "step" | "turn" | "persona" | "session" | "contextParts";

const VIEW_GRAN: Record<UsageView, Gran> = {
    step: "step",
    turn: "turn",
    persona: "persona",
    session: "session",
    contextParts: "step",
};

/** 身份列（各视图共用） */
const IDENTITY = ["turnId", "turnAt", "stepNo", "persona", "model", "apiFace", "reasoningEffort"];

/** 窗口构成视图的列：身份 + 该步 prompt + 6 格构成 + 压缩标记（其余列与它无关） */
const PARTS_KEYS = [
    ...IDENTITY,
    "inputTotalTokens",
    "contextParts.system",
    "contextParts.tools",
    "contextParts.history",
    "contextParts.systemShare",
    "contextParts.toolsShare",
    "contextParts.historyShare",
    "windowRate",
    "deliveryCompact",
    "compactEvents",
];

/** step 视图一次最多渲染多少行（会话早期可能上万步；下钻进来时通常只有几十行，不受限） */
const STEP_LIMIT = 500;

/** 旧账里的字节上限（`modeData.budgetBytes` 已在 ##432 删除；只为读旧事件保留） */
const legacyBudgetBytes = (policy: unknown): number | null => {
    const bb = (policy as { modeData?: { budgetBytes?: unknown } } | null)?.modeData?.budgetBytes;
    return typeof bb === "number" ? bb : null;
};

/** 字节人读（与旧窗口构成分表同字形） */
const fmtB = (n: number | undefined): string =>
    n === undefined ? "—" : n >= 1024 ? `${(n / 1024).toFixed(1)} KB` : `${n} B`;

/** 某个视图下要显示的列（键序 = 契约声明序 → 表头天然稳定） */
export function columnsOf(view: UsageView): readonly UsageFieldSpec[] {
    if (view === "contextParts") {
        const keys = new Set(PARTS_KEYS);
        return USAGE_FIELDS.filter((c) => keys.has(c.key));
    }
    return columnsFor(VIEW_GRAN[view]);
}

/** 视图的中文名（面包屑/标题用；同一处定义，别在别处另起） */
export const VIEW_LABEL: Record<UsageView, string> = {
    step: "逐步",
    turn: "按轮",
    persona: "按人物",
    session: "按会话",
    contextParts: "窗口构成",
};

/** 下钻目标（`turn` 行 → 该轮逐步；`persona` 行 → 该人物按轮） */
export function drillTargetOf(
    view: UsageView,
    row: UsageRow,
): { view: UsageView; filter: UsageFilter; label: string } | null {
    if (view === "turn") return { view: "step", filter: { field: "turnId", value: row.key }, label: `轮 ${row.key}` };
    if (view === "persona")
        return { view: "turn", filter: { field: "persona", value: row.key }, label: `人物 ${row.key}` };
    return null;
}

export interface UsageTableProps {
    /** 会话**全部**步（原始账本；过滤在聚合层做） */
    rows: readonly StepUsageRecord[];
    view: UsageView;
    /** 下钻过滤（`turn` → turnId；`persona` → persona） */
    filter?: UsageFilter;
    /** 压缩事件账（`compact.jsonl`）；给了才显示「压缩事件」列的值 */
    compactEvents?: readonly CompactEventRecord[];
    /** 已落盘的压缩边界（`undefined` = 还没取到 —— 徽章 hover 少一段，不编事实；`null` = 从没压过） */
    boundary?: DeliveryBoundary | null;
    /** 点行下钻（调用方压面包屑）；缺省 = 不可下钻 */
    onDrill?: (t: { view: UsageView; filter: UsageFilter; label: string }) => void;
}

export function UsageTable(props: UsageTableProps) {
    const gran = () => VIEW_GRAN[props.view];
    const specs = createMemo(() => columnsOf(props.view));
    const all = createMemo(() => aggregateUsage(props.rows, gran(), props.filter));

    /** 合计行：session 粒度那一行（**不是**把已渲染行再加一遍）；会话视图/构成视图没有 */
    const total = createMemo<UsageRow | null>(() => {
        if (props.view === "session" || props.view === "contextParts") return null;
        return aggregateUsage(props.rows, "session", props.filter)[0] ?? null;
    });

    /** step 视图的显示上限（下钻进来时 `filter` 非空 → 不截断） */
    const shown = createMemo(() => {
        const list = all();
        return props.view === "step" && !props.filter && list.length > STEP_LIMIT ? list.slice(-STEP_LIMIT) : list;
    });
    const hiddenCount = createMemo(() =>
        props.view === "step" && !props.filter ? Math.max(0, all().length - STEP_LIMIT) : 0,
    );

    /** 表体：合计行（若该视图有）+ 数据行（同一条列表，保证同一次重建） */
    const listed = createMemo(() => {
        const t = total();
        return [
            ...(t ? [{ row: t, total: true }] : []),
            ...shown().map((row) => ({ row, total: false })),
        ];
    });

    /** 步键 → 该步生效的压缩事件（事件账在 compact.jsonl，本表只做投射） */
    const points = createMemo(() =>
        props.compactEvents?.length
            ? mapCompactPointsToSteps(props.rows, props.compactEvents)
            : new Map<string, CompactEventRecord[]>(),
    );
    const [openKey, setOpenKey] = createSignal<string | null>(null);

    /** 步键 → 原始记录（只用 step 视图；投递徽章要用 `historySelection` 原值，契约列只给文本） */
    const stepRecord = (row: UsageRow): StepUsageRecord | undefined =>
        props.rows.find((r) => `${r.turnId}#${r.step}` === row.key);

    /** 单元格取值：压缩事件列由事件账投射，其余一律来自聚合行（**同一份契约**） */
    const valueOf = (spec: UsageFieldSpec, row: UsageRow): FieldValue => {
        if (spec.key === "compactEvents") {
            const n = points().get(row.key)?.length ?? 0;
            return n > 0 ? `${n} 次` : null;
        }
        return row.fields[spec.key] ?? null;
    };

    /** 会话合计$（金额列 hover 里的占比分母；没有合计行 → null，不编占比） */
    const grandTotal = () => {
        const v = total()?.fields["cost.total"];
        return typeof v === "number" && v > 0 ? v : null;
    };

    const cellTitle = (spec: UsageFieldSpec, row: UsageRow): string | undefined => {
        if (spec.fmt === "money" && spec.key !== "cost.total") {
            const v = row.fields[spec.key];
            const t = grandTotal();
            if (typeof v === "number" && t != null) return `占会话合计 ${((v / t) * 100).toFixed(1)}%`;
        }
        return spec.hint;
    };

    /** 单元格内容（四种来源：合计标签 / 投递徽章 / 压缩点位 / 聚合值） */
    const cellOf = (spec: UsageFieldSpec, row: UsageRow, opts: { total?: boolean }) => {
        if (opts.total) return spec === specs()[0] ? "合计" : fmtCell(valueOf(spec, row), spec.fmt);
        if (spec.key === "deliveryCompact") {
            const sel = stepRecord(row)?.historySelection;
            if (!sel) return null;
            // ##476：没裁剪 → 文案为 null → **整块不插节点**（不是空 span、也不是 display:none）
            const text = deliveryBadgeText(sel);
            if (text === null) return null;
            return (
                <span
                    data-delivery-compact
                    class="badge badge-ghost badge-xs"
                    title={deliveryBadgeTitle({ selection: sel, boundary: props.boundary })}
                >
                    {text}
                </span>
            );
        }
        if (spec.key === "compactEvents") {
            const n = points().get(row.key)?.length ?? 0;
            return n > 0 ? (
                <button
                    type="button"
                    class="link link-hover"
                    aria-label="压缩点位"
                    data-compact-point
                    onClick={(e) => {
                        e.stopPropagation();
                        setOpenKey((cur) => (cur === row.key ? null : row.key));
                    }}
                >
                    压缩{n > 1 ? ` ×${n}` : ""}
                </button>
            ) : null;
        }
        return fmtCell(valueOf(spec, row), spec.fmt);
    };

    const rowOf = (row: UsageRow, opts: { total?: boolean } = {}) => {
        const drill = props.onDrill && !opts.total ? drillTargetOf(props.view, row) : null;
        const partial = isPartial(row) && !opts.total;
        return (
            <tr
                class={`border-t border-base-300 ${opts.total ? "font-medium" : ""} ${drill ? "cursor-pointer hover:bg-base-200" : ""}`}
                data-usage-row={opts.total ? "total" : row.key}
                onClick={drill ? () => props.onDrill!(drill) : undefined}
                title={drill ? "点击下钻" : undefined}
            >
                <For each={specs()}>
                    {(spec) => (
                        <td
                            class={`px-2 py-1 align-top whitespace-nowrap ${spec.fmt === "text" ? "" : "text-right tabular-nums"}`}
                            title={cellTitle(spec, row)}
                            data-col={spec.key}
                        >
                            {cellOf(spec, row, opts)}
                            <Show when={opts.total && spec === specs()[0] && partial}>
                                <span
                                    class="badge badge-warning badge-xs ml-1"
                                    title="有无价目步：金额只是已计价部分之和"
                                >
                                    部分和
                                </span>
                            </Show>
                        </td>
                    )}
                </For>
            </tr>
        );
    };

    return (
        <Show
            when={all().length > 0}
            fallback={
                <div
                    class="rounded-box border border-base-300 bg-base-100 px-3 py-6 text-body opacity-60"
                    data-usage-empty
                >
                    还没有用量记录（跑一轮本地 agent 后，每步会写入用量账本）
                </div>
            }
        >
            <div
                class="overflow-x-auto rounded-box border border-base-300 bg-base-100"
                data-usage-view={props.view}
                data-usage-filter={props.filter ? `${props.filter.field}=${props.filter.value}` : ""}
            >
                <table class="table table-xs w-full">
                    <thead>
                        <tr class="text-caption">
                            <For each={specs()}>
                                {(spec) => (
                                    <th
                                        class={`whitespace-nowrap px-2 ${spec.fmt === "text" ? "" : "text-right"}`}
                                        title={spec.hint}
                                        data-col={spec.key}
                                        style={spec.width ? { "min-width": `${spec.width}px` } : undefined}
                                    >
                                        {spec.label}
                                    </th>
                                )}
                            </For>
                        </tr>
                    </thead>
                    <tbody>
                        {/* 合计行置顶（先给「一共花了多少」，再给明细）；与数据行走**同一条** <For>，
                            这样下钻/切 group 时两者一起重建 —— 分成两个容器时合计行会留在旧值上。 */}
                        <For each={listed()}>{(it) => rowOf(it.row, { total: it.total })}</For>
                    </tbody>
                </table>
                {/* 压缩事件展开（同一行的详情；不再单独成表 —— 旧「压缩历史表」的归宿） */}
                {/* 展开行对**任何**含「压缩事件」列的视图都生效（逐步 / 窗口构成都用同一列） */}
                <Show when={openKey()}>
                    {(k) => {
                        const list = () => points().get(k()) ?? [];
                        return (
                            <Show when={list().length > 0}>
                                <div
                                    class="border-t border-base-300 bg-base-200 px-3 py-2 text-caption"
                                    data-compact-point-detail
                                >
                                    <For each={list()}>
                                        {(ev) => (
                                            <div class="flex flex-wrap items-center gap-x-3 gap-y-0.5">
                                                {/* 算法恒 budget（##442 起零旋钮，`policy.mode` 只为旧账保留）；
                                                上限旧账才有 `modeData.budgetBytes` → 新事件显示「边界见 turns.jsonl」 */}
                                                <span class="badge badge-ghost badge-xs">budget</span>
                                                <span>
                                                    上限{" "}
                                                    {legacyBudgetBytes(ev.policy) != null
                                                        ? `${Math.round(legacyBudgetBytes(ev.policy)! / 1024)} KB（已废弃）`
                                                        : "边界见 turns.jsonl"}
                                                </span>
                                                <span>
                                                    {ev.by === "auto" ? "自动" : ev.by === "ui" ? "界面" : "命令行"} ·{" "}
                                                    {TRIGGER_LABEL[ev.trigger as keyof typeof TRIGGER_LABEL] ??
                                                        ev.trigger}
                                                </span>
                                                <span class="tabular-nums">
                                                    轮 {ev.size.before.turns} → {ev.size.after.turns}
                                                </span>
                                                <span class="tabular-nums">
                                                    字节 {fmtB(ev.size.before.bytes)} → {fmtB(ev.size.after.bytes)}
                                                </span>
                                                <span>保留区间 {(ev.details?.kept ?? []).length} 段</span>
                                                <span class="tabular-nums opacity-70">
                                                    保留自 {ev.boundary.keptFromTurnId ?? "（全清）"}
                                                </span>
                                                <span class="opacity-50">{new Date(ev.ts).toLocaleString()}</span>
                                            </div>
                                        )}
                                    </For>
                                </div>
                            </Show>
                        );
                    }}
                </Show>
                <Show when={hiddenCount() > 0}>
                    <div class="border-t border-base-300 px-3 py-1.5 text-caption opacity-60" data-usage-truncated>
                        共 {all().length} 步，只渲染最近 {STEP_LIMIT} 步（更早的步请切换分组或下钻查看；合计行仍是全量）
                    </div>
                </Show>
            </div>
        </Show>
    );
}

/**
 * 同一张表的 Markdown 导出（旧 `turnDetailMd` / `sessionBoardMd` 的替代）：
 * 列与表格**同一份** `columnsOf(view)`，合计行同样置顶 —— 复制出去和看到的一致。
 */
export function usageTableMd(rows: readonly StepUsageRecord[], view: UsageView, filter?: UsageFilter): string {
    const specs = columnsOf(view);
    const body = aggregateUsage(rows, VIEW_GRAN[view], filter);
    const total =
        view === "session" || view === "contextParts" ? null : (aggregateUsage(rows, "session", filter)[0] ?? null);
    const textOf = (row: UsageRow, key: string): string => {
        const v = key === "compactEvents" ? null : (row.fields[key] ?? null);
        return fmtCell(v, specs.find((s) => s.key === key)!.fmt);
    };
    const line = (row: UsageRow, label?: string): string =>
        specs.map((s, i) => (i === 0 && label ? label : textOf(row, s.key))).join(" | ");
    const head = specs.map((s) => s.label).join(" | ");
    const sep = specs.map((s) => (s.fmt === "text" ? "---" : "---:")).join(" | ");
    const out = [
        `## ${VIEW_LABEL[view]}用量${filter ? `（${filter.field}=${filter.value}）` : ""}`,
        "",
        `| ${head} |`,
        `| ${sep} |`,
    ];
    if (total) out.push(`| ${line(total, "合计")} |`);
    for (const r of body) out.push(`| ${line(r)} |`);
    return out.join("\n");
}

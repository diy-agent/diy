/**
 * CompactSessionPanel — 压缩会话上下文（清零 → 硬切换新 session 的 UI）
 *
 * ⚠️ 语义：压缩 **≠** 清除。
 *   · 压缩（本面板）：只改「发给模型的上下文」—— 保留最近 N 轮 + 可选裁工具结果；
 *     **不删任何历史**，旧内容仍在会话日志里、可查（历史代）、可撤销。
 *   · 清除（⋯ 菜单）：物理删除所有会话日志，不可恢复 —— 与本面板是两回事，别混。
 *
 * 布局（2026-10-05 定稿）：**左参数 + 右预览**，一眼对照。
 *   · base = 当前生效请求（requestView，打开面板取一次）
 *   · mod  = 改参数后请求（compactPreview 随参数刷新）
 *   · 右栏把两者渲染成 YAML 行、做行级 diff（增删变色、可折叠、可只看差异、可并排）
 *   · 左栏底部「事实表」= base↔mod 分层 token 与金额差（旧值 / 新值 / 省 cost）
 */

import { createSignal, createResource, createEffect, on, For, Show, createMemo, type JSX } from "solid-js";
import { localChatStore } from "../store/localChatStore";
import {
    DEFAULT_BUDGET_BYTES,
    DEFAULT_TOOL_RESULT_POLICY,
    budgetBytesOf,
    flatPolicyOf,
    normalizePolicy,
    toolResultOf,
    type CompactPolicy,
} from "../../shared/context/compaction";
/** 触发理由的短文案（表里空间小；完整版在 TRIGGER_TEXT_FULL，提示条上用） */
function triggerText(t: string | undefined): string {
    switch (t) {
        case "systemContextChanged":
            return "系统上下文变";
        case "cacheExpired":
            return "缓存过期";
        case "contextWindowOver":
            return "窗口超限";
        default:
            return "手动";
    }
}

import {
    collapsedAtLevel,
    diffValues,
    foldLevelCount,
    subtreeChanges,
    visibleDiffRows,
    type YamlDiffRow,
} from "../../shared/yaml-lines";
import { requestViewYaml, type LayerRow, type RequestView } from "../../shared/context/request-view";
import { DrawerMaxButton } from "./DrawerMaximize";
import { notificationStore } from "../store/notificationStore";

const INDENT = "  ";

/** 该折叠行子树内是否含变更（add/del/change 任意） */
const hasOwnChange = (c?: { add: number; del: number }): boolean => !!c && (c.add > 0 || c.del > 0);

/** 折叠框（VSCode 式：标题条整条可点，▾/▸ 指示）—— 与 TaskDetailContent 的 Block 同形 */
function Block(props: { title: string; children: JSX.Element; defaultOpen?: boolean; extra?: string }) {
    const [open, setOpen] = createSignal(props.defaultOpen !== false);
    return (
        <section class="border border-base-300 rounded-lg overflow-hidden min-w-0">
            <button
                class="flex w-full items-center gap-1 bg-base-300 px-2 py-1 text-body font-bold tracking-wide opacity-80 hover:opacity-100"
                aria-expanded={open()}
                onClick={() => setOpen((v) => !v)}
            >
                <span>{open() ? "▾" : "▸"}</span>
                <span>{props.title}</span>
                <Show when={props.extra}>
                    <span class="ml-auto font-mono font-normal opacity-70">{props.extra}</span>
                </Show>
            </button>
            <Show when={open()}>
                <div class="p-2 min-w-0">{props.children}</div>
            </Show>
        </section>
    );
}

/**
 * 「压缩后估算」一行：压缩前 / 压缩后 / 预估节省。
 * 用层级符号（├/└，与「会话用量（累计）」同一套）表达「各行之和 = 合计」——
 * 合计行不加「（= 各层之和）」这类注释，层级关系用符号自明。
 */
/**
 * 费用对比（图形）：**当前 vs 压缩后**两条横条（宽度按 token 比例），
 * 下面一行「省 $X（−Y%）」。用 total 行（合计）—— 直观看省多少，不列各层明细。
 */
function CostCompare(props: { facts: LayerRow[] }) {
    const total = createMemo(() => props.facts.find((r) => r.key === "total"));
    const maxTok = () => Math.max(1, total()?.oldTokens ?? 0);
    const width = (t: number) => `${Math.max(0, Math.min(100, (t / maxTok()) * 100)).toFixed(1)}%`;
    const saved = () => {
        const t = total();
        return t ? t.oldCost - t.newCost : 0;
    };
    const savedPct = () => {
        const t = total();
        return t && t.oldTokens > 0 ? Math.round((1 - t.newTokens / t.oldTokens) * 100) : 0;
    };
    const money = (v: number) => `$${v.toFixed(4)}`;
    return (
        <Show when={total()} fallback={<div class="text-caption opacity-50">…</div>}>
            {(t) => (
                <div class="space-y-2 text-caption">
                    <div>
                        <div class="flex justify-between">
                            <span>当前</span>
                            <span class="tabular-nums opacity-80">
                                {t().oldTokens.toLocaleString()} tok · {money(t().oldCost)}
                            </span>
                        </div>
                        <div class="mt-0.5 h-3 rounded bg-base-200 overflow-hidden">
                            <div data-cost-bar class="h-full bg-base-content/35" style={{ width: width(t().oldTokens) }} />
                        </div>
                    </div>
                    <div>
                        <div class="flex justify-between">
                            <span>压缩后</span>
                            <span class="tabular-nums opacity-80">
                                {t().newTokens.toLocaleString()} tok · {money(t().newCost)}
                            </span>
                        </div>
                        <div class="mt-0.5 h-3 rounded bg-base-200 overflow-hidden">
                            <div data-cost-bar class="h-full bg-primary" style={{ width: width(t().newTokens) }} />
                        </div>
                    </div>
                    <div class="pt-1.5 border-t border-base-300">
                        <Show
                            when={saved() > 1e-9}
                            fallback={<span data-cost-saved class="opacity-60">无节省（预算未生效 / 历史本来就不多）</span>}
                        >
                            <span data-cost-saved class="text-success font-semibold">
                                省 {money(saved())}（−{savedPct()}%）
                            </span>
                        </Show>
                    </div>
                </div>
            )}
        </Show>
    );
}
// ─── 面板控制器（状态与副作用；供抽屉 tab 栏与内容区共享）──────────────
//
// 【M1】原 CompactSessionPanel 自带抽屉外壳 + 遮罩 + 底栏；现移植进「窗口构成页」第一 tab，
// 外壳（标题 / 最大化 / 关闭 / 执行按钮）归外层 drawer ⇒ 这里只留**状态与预览逻辑**，
// 渲染交 `CompactPanelContent`。内容拆「预算区 / 参数区 / 预览区 / 费用图」四块
// （用户 2026-10-07 同意；参数区在 M3 补齐）。

/** 压缩预览模型（主进程 compactPreview 返回；base = 未压缩，mod = 当前预算） */
export interface CompactPreviewModel {
    before: { bytes: number };
    after: { bytes: number };
    keptTurns: number;
    droppedTurns: number;
    facts: LayerRow[];
    modRequest: RequestView;
    baseRequest: RequestView;
}

export interface CompactPanelCtl {
    auto: () => { config: { mode: "off" | "notify" | "auto"; policy: unknown } } | undefined;
    autoBusy: () => boolean;
    patchAuto: (patch: Record<string, unknown>) => Promise<void>;
    autoPolicy: () => CompactPolicy;
    budgetBytes: () => number;
    kbDraft: () => string;
    setKbDraft: (v: string) => void;
    commitKb: () => Promise<void>;
    pv: () => CompactPreviewModel | undefined;
    busy: () => boolean;
    err: () => string | null;
    /** 立即压缩：按当前预算压一次（历史保留、可撤销）。成功 toast。 */
    apply: () => Promise<void>;
}

/**
 * 压缩面板控制器 —— 自动压缩配置（真源 `$DIY_HOME/auto-compact.yaml` 的 policy）+ 预览 + 执行。
 * 自动与手动**同一套策略**（用户 2026-10-07：「所有压缩都改为自动压缩策略……提供手工压缩执行的按钮」）。
 */
export function useCompactPanel(uri: () => string): CompactPanelCtl {
    const [auto, { refetch: refetchAuto }] = createResource(
        () => uri(),
        async (u) => {
            if (!u) return undefined;
            return (await localChatStore.autoCompactStatus(u)) as {
                config: { mode: "off" | "notify" | "auto"; policy: unknown };
            };
        },
    );
    const [autoBusy, setAutoBusy] = createSignal(false);
    const patchAuto = async (patch: Record<string, unknown>) => {
        setAutoBusy(true);
        try {
            await localChatStore.autoCompactSetConfig(patch);
            await refetchAuto();
        } finally {
            setAutoBusy(false);
        }
    };

    const autoPolicy = (): CompactPolicy => normalizePolicy(auto()?.config.policy);
    const budgetBytes = (): number => budgetBytesOf(autoPolicy()) ?? DEFAULT_BUDGET_BYTES;
    const patchAutoPolicy = (next: CompactPolicy) => patchAuto({ policy: next });
    const currentToolResult = () => toolResultOf(autoPolicy()) ?? DEFAULT_TOOL_RESULT_POLICY;
    const setBudgetBytes = (b: number) =>
        patchAutoPolicy({
            mode: "budget",
            modeData: { budgetBytes: Math.max(0, Math.round(b)), toolResult: currentToolResult() },
            summary: false,
        });
    const setBudgetKb = (kb: number) => setBudgetBytes(kb * 1024);

    /** 预算输入框草稿（KB）：不要让异步 auto() 覆盖用户正在输入的内容 —— 仅初始化 / 提交时同步 */
    const [kbDraft, setKbDraft] = createSignal("3");
    createEffect(
        on(
            () => budgetBytes(),
            (b) => setKbDraft(b % 1024 === 0 ? String(b / 1024) : (b / 1024).toFixed(1)),
            { defer: false },
        ),
    );
    /** 提交预算输入（失焦 / 回车）。**返回 Promise**：写盘 + refetch 异步，apply 必须先 await 它。 */
    const commitKb = async (): Promise<void> => {
        const kb = Number(kbDraft());
        if (!Number.isFinite(kb) || kb < 0) {
            setKbDraft(String(budgetBytes() / 1024));
            return;
        }
        if (Math.round(kb * 1024) === budgetBytes()) return;
        await setBudgetKb(kb);
    };

    const [busy, setBusy] = createSignal(false);
    const [err, setErr] = createSignal<string | null>(null);

    /** 预览（只算不写）：预算变化即重算。base = 未压缩（compactPreview 现算），mod = 当前预算。 */
    const [pv] = createResource(
        () => {
            const u = uri();
            return u ? { uri: u, p: flatPolicyOf(autoPolicy()) } : null;
        },
        (k) =>
            k
                ? (localChatStore.compactPreview(k.uri, k.p) as Promise<CompactPreviewModel>)
                : Promise.resolve(undefined),
    );

    /** 立即压缩：按当前预算压一次（历史保留、可撤销） */
    const apply = async () => {
        const u = uri();
        if (!u) return;
        setBusy(true);
        setErr(null);
        try {
            // ⚠️ 先把输入框里的预算落盘（blur 的写盘是异步的）——否则可能用**旧预算**压
            await commitKb();
            await localChatStore.compact(u, flatPolicyOf(autoPolicy()));
            notificationStore.addToast("success", "已压缩（历史保留、可撤销）");
        } catch (e) {
            setErr(String(e instanceof Error ? e.message : e));
        } finally {
            setBusy(false);
        }
    };

    return { auto, autoBusy, patchAuto, autoPolicy, budgetBytes, kbDraft, setKbDraft, commitKb, pv, busy, err, apply };
}

/**
 * 压缩面板内容（**可嵌入**）—— 左参数 + 右预览，一眼对照。
 *   · 左栏 = 预算区 + 费用图（费用对比图形：当前 vs 压缩后）
 *   · 右栏 = 预览区（请求结构 YAML 行级 diff：增删变色、可折叠、可只看差异、可并排）
 * 外壳（顶栏 / 底栏 / 遮罩）由外层「窗口构成页」提供；执行按钮在 tab 栏。
 */
export function CompactPanelContent(props: { ctl: CompactPanelCtl }) {
    const ctl = props.ctl;

    // 右栏视图控制
    const [sideBySide, setSideBySide] = createSignal(false);
    const [onlyDiff, setOnlyDiff] = createSignal(true);
    /** 展开层级：0 = 只露根行；N = 全展开 */
    const [expandLevel, setExpandLevel] = createSignal(Number.MAX_SAFE_INTEGER);

    // 两级 diff：以两个请求**对象**做节点级对齐（base = 未压缩，mod = 当前预算）
    const rows = createMemo<YamlDiffRow[]>(() => {
        const m = ctl.pv();
        if (!m) return [];
        return diffValues(requestViewYaml(m.baseRequest), requestViewYaml(m.modRequest));
    });

    const foldLevels = createMemo(() => foldLevelCount(rows()));
    const curLevel = createMemo(() => Math.min(expandLevel(), foldLevels()));
    const nextLevel = () => {
        const n = foldLevels();
        setExpandLevel((v) => (Math.min(v, n) >= n ? 0 : Math.min(v, n) + 1));
    };

    /** 手动折叠覆盖 */
    const [manual, setManual] = createSignal<{ level: number; collapsed: Set<number> }>({ level: -1, collapsed: new Set() });
    const toggleFold = (i: number) => {
        const cur = new Set(collapsed());
        if (cur.has(i)) cur.delete(i);
        else cur.add(i);
        setManual({ level: curLevel(), collapsed: cur });
    };
    createEffect(on(curLevel, () => setManual({ level: -1, collapsed: new Set() }), { defer: true }));

    const collapsed = createMemo<Set<number>>(() => {
        const lv = curLevel();
        const m = manual();
        return m.level === lv ? m.collapsed : collapsedAtLevel(rows(), lv);
    });
    const changes = createMemo(() => subtreeChanges(rows()));
    const shownIndexes = createMemo(() => visibleDiffRows(rows(), collapsed()));
    const rowCache = new Map<number, { i: number; row: YamlDiffRow }>();
    const CONTEXT_LINES = 3;
    const renderRows = createMemo(() => {
        const idx = shownIndexes();
        const all = rows();
        const ch = changes();
        const keep = new Set<number>();
        if (onlyDiff()) {
            idx.forEach((ri, pos) => {
                const row = all[ri]!;
                if (row.t !== "same" || (row.foldable && hasOwnChange(ch.get(ri)))) keep.add(pos);
            });
            idx.forEach((ri, pos) => {
                if (all[ri]!.t === "same") return;
                for (let d = -CONTEXT_LINES; d <= CONTEXT_LINES; d++) {
                    const q = pos + d;
                    if (q >= 0 && q < idx.length) keep.add(q);
                }
            });
        }
        return idx
            .map((i, pos) => ({ i, pos }))
            .filter(({ pos }) => !onlyDiff() || keep.has(pos))
            .map(({ i }) => {
                const row = all[i]!;
                const cached = rowCache.get(i);
                if (cached && cached.row === row) return cached;
                const obj = { i, row };
                rowCache.set(i, obj);
                return obj;
            });
    });

    const estTok = (bytes: number) => Math.round(bytes / 4);
    /** 预算人读（KB；0 特别标「清零」） */
    const budgetKbLabel = (): string => {
        const b = ctl.budgetBytes();
        if (b === 0) return "0（清零）";
        return b % 1024 === 0 ? String(b / 1024) + " KB" : (b / 1024).toFixed(1) + " KB";
    };
    /**
     * 压缩后**整份请求**的规模（KB）—— 含固定开支（system + 工具定义 + runtime）+ 预算内历史。
     * 用费用表 total 行的 token（= 各层之和，含 system / tools）；token ≈ 字节 / 4 ⇒ ×4 反推字节。
     */
    const afterKb = (): string => {
        const t = (ctl.pv()?.facts ?? []).find((r) => r.key === "total");
        return (((t?.newTokens ?? 0) * 4) / 1024).toFixed(1) + " KB";
    };
    const ratio = () => {
        const b = ctl.pv()?.before.bytes ?? 0;
        const a = ctl.pv()?.after.bytes ?? 0;
        return b > 0 ? Math.round((1 - a / b) * 100) : 0;
    };
    const diffCounts = createMemo(() => {
        let add = 0;
        let del = 0;
        for (const r of rows()) {
            if (r.t === "add") add++;
            else if (r.t === "del") del++;
            else if (r.t === "change") {
                add++;
                del++;
            }
        }
        return { add, del };
    });

    return (
        <div class="flex h-full min-h-0 w-full">
            {/* ── 左栏：预算区（自动压缩 toggle + 压缩到输入）+ 费用图 ── */}
            <div class="w-[340px] shrink-0 overflow-auto border-r p-2 space-y-2">
                <div class="rounded-lg border border-base-300 p-3 space-y-3">
                    <div class="text-caption opacity-70">
                        当前 {estTok(ctl.pv()?.before.bytes ?? 0).toLocaleString()} tok → 压缩后{" "}
                        {estTok(ctl.pv()?.after.bytes ?? 0).toLocaleString()} tok{" "}
                        <span class="text-success">(-{ratio()}%)</span>
                        <span class="opacity-60">　删 {diffCounts().del} / 增 {diffCounts().add} 行</span>
                    </div>
                    <div class="flex items-center justify-between">
                        <span class="text-body font-semibold">自动压缩</span>
                        <input
                            type="checkbox"
                            class="toggle toggle-sm toggle-primary"
                            aria-label="自动压缩"
                            disabled={ctl.autoBusy()}
                            checked={ctl.auto()?.config.mode === "auto"}
                            onChange={(e) => void ctl.patchAuto({ mode: e.currentTarget.checked ? "auto" : "off" })}
                        />
                    </div>
                    <div class="flex items-center gap-2">
                        <span class="text-body">压缩到</span>
                        <input
                            type="number"
                            class="input input-sm w-20"
                            aria-label="压缩预算KB"
                            min="0"
                            value={ctl.kbDraft()}
                            disabled={ctl.autoBusy()}
                            onInput={(e) => ctl.setKbDraft(e.currentTarget.value)}
                            onChange={() => void ctl.commitKb()}
                            onBlur={() => void ctl.commitKb()}
                        />
                        <span class="text-body">KB</span>
                    </div>
                    <div class="text-caption opacity-70">
                        历史 ≤ <b>{budgetKbLabel()}</b> · 整份请求 ≈ <b>{afterKb()}</b>
                    </div>
                    <div class="text-caption opacity-45">
                        历史按优先级保留：用户发言 &gt; 助手结论 &gt; 助手过程 &gt; 工具命令 &gt; 工具结果
                    </div>
                    <Show when={ctl.err()}>
                        <div class="text-caption text-error">{ctl.err()}</div>
                    </Show>
                </div>

                <Block title="费用对比">
                    <CostCompare facts={ctl.pv()?.facts ?? []} />
                    <div class="mt-2 text-caption opacity-60">
                        金额 = token ÷ 1M × 当前模型非缓存输入单价；token 按字节 / 4 估算（仅为对比，不进计费）。
                    </div>
                </Block>
            </div>

            {/* ── 右栏：预览区（请求 YAML diff）─────────────── */}
            <div class="grow flex flex-col overflow-hidden">
                <div class="px-3 py-1.5 border-b flex items-center gap-3 shrink-0 text-caption">
                    <div class="join">
                        <button
                            class={"btn btn-xs join-item " + (!sideBySide() ? "btn-active" : "btn-ghost")}
                            onClick={() => setSideBySide(false)}
                        >
                            统一 diff
                        </button>
                        <button
                            class={"btn btn-xs join-item " + (sideBySide() ? "btn-active" : "btn-ghost")}
                            onClick={() => setSideBySide(true)}
                        >
                            并排
                        </button>
                    </div>
                    <label class="flex items-center gap-1 cursor-pointer">
                        <input
                            type="checkbox"
                            class="toggle toggle-xs"
                            aria-label="只看差异"
                            checked={onlyDiff()}
                            onChange={(e) => setOnlyDiff(e.currentTarget.checked)}
                        />
                        只看差异
                    </label>
                    <button class="btn btn-ghost btn-xs" aria-label="逐级展开" onClick={nextLevel}>
                        展开 {curLevel()}/{foldLevels()}
                    </button>
                    <span class="opacity-50 ml-auto">请求结构 YAML（base vs mod）</span>
                </div>

                <div class="overflow-auto grow p-2 text-caption font-mono leading-[1.5]" data-compact-preview>
                    <Show
                        when={!sideBySide()}
                        fallback={
                            <table class="w-full border-collapse">
                                <tbody>
                                    <For each={renderRows()}>
                                        {({ i, row }) => (
                                            <tr
                                                class={
                                                    row.t === "add"
                                                        ? "bg-success/10"
                                                        : row.t === "del" || row.t === "change"
                                                          ? "bg-error/10"
                                                          : ""
                                                }
                                            >
                                                <td class="align-top whitespace-pre-wrap break-all w-1/2 pr-2 border-r border-base-300">
                                                    <FoldToggle i={i} row={row} collapsed={collapsed().has(i)} changes={changes().get(i)} onToggle={toggleFold} />
                                                    <span class={row.t === "del" || row.t === "change" ? "text-error" : ""}>
                                                        {row.left ? INDENT.repeat(row.left.indent) + row.left.text : ""}
                                                    </span>
                                                    <ChangeMark collapsed={collapsed().has(i)} changes={changes().get(i)} />
                                                </td>
                                                <td class="align-top whitespace-pre-wrap break-all pl-2">
                                                    <span class={row.t === "add" || row.t === "change" ? "text-success" : ""}>
                                                        {row.right ? INDENT.repeat(row.right.indent) + row.right.text : ""}
                                                    </span>
                                                </td>
                                            </tr>
                                        )}
                                    </For>
                                </tbody>
                            </table>
                        }
                    >
                        <For each={renderRows()}>
                            {({ i, row }) => (
                                <Show
                                    when={row.t !== "change"}
                                    fallback={
                                        <>
                                            <div data-diff="del" class="bg-error/10 text-error">
                                                <FoldToggle i={i} row={row} collapsed={collapsed().has(i)} changes={changes().get(i)} onToggle={toggleFold} />
                                                <span class="opacity-40 select-none">- </span>
                                                <span class="whitespace-pre-wrap break-all">
                                                    {INDENT.repeat(row.left?.indent ?? row.indent) + (row.left?.text ?? "")}
                                                </span>
                                                <ChangeMark collapsed={collapsed().has(i)} changes={changes().get(i)} />
                                            </div>
                                            <div data-diff="add" class="bg-success/10 text-success">
                                                <span class="inline-block w-3" />
                                                <span class="opacity-40 select-none">+ </span>
                                                <span class="whitespace-pre-wrap break-all">
                                                    {INDENT.repeat(row.right?.indent ?? row.indent) + (row.right?.text ?? "")}
                                                </span>
                                            </div>
                                        </>
                                    }
                                >
                                    <div
                                        data-diff={row.t}
                                        class={
                                            row.t === "add"
                                                ? "bg-success/10 text-success"
                                                : row.t === "del"
                                                  ? "bg-error/10 text-error"
                                                  : ""
                                        }
                                    >
                                        <FoldToggle i={i} row={row} collapsed={collapsed().has(i)} changes={changes().get(i)} onToggle={toggleFold} />
                                        <span class="opacity-40 select-none">{row.t === "add" ? "+" : row.t === "del" ? "-" : " "} </span>
                                        <span class="whitespace-pre-wrap break-all">
                                            {INDENT.repeat(row.indent) + (row.right?.text ?? row.left?.text ?? "")}
                                        </span>
                                        <ChangeMark collapsed={collapsed().has(i)} changes={changes().get(i)} />
                                    </div>
                                </Show>
                            )}
                        </For>
                    </Show>
                    <Show when={renderRows().length === 0}>
                        <div class="p-4 opacity-60">无差异（当前参数与生效请求一致）</div>
                    </Show>
                </div>
            </div>
        </div>
    );
}

/**
 * 折叠箭头（可折叠行才画；**只画箭头**，变更点由行尾的 ChangeMark 承担）。
 * 折叠且有内含变更时箭头染警示色（提示「里面还有东西，展开看看」）；展开后恢复常态。
 */
function FoldToggle(props: {
    i: number;
    row: YamlDiffRow;
    collapsed: boolean;
    changes?: { add: number; del: number };
    onToggle: (i: number) => void;
}) {
    if (!props.row.foldable) return <span class="inline-block w-3" />;
    const warn = props.collapsed && hasOwnChange(props.changes);
    return (
        <button
            class={`inline-block w-3 text-left select-none hover:opacity-100 ${warn ? "text-warning" : "opacity-60"}`}
            aria-label={props.collapsed ? "展开节点" : "折叠节点"}
            onClick={() => props.onToggle(props.i)}
        >
            {props.collapsed ? "▸" : "▾"}
        </button>
    );
}

/**
 * 行尾变更点：**只在节点折叠时**显示（展开后不用标注 —— 内容已可见），
 * 放行尾而非行首，避免插在缩进前破坏 YAML 的层级视觉。
 */
function ChangeMark(props: { collapsed: boolean; changes?: { add: number; del: number } }) {
    const c = props.changes;
    const show = () => props.collapsed && hasOwnChange(c);
    return (
        <Show when={show()}>
            <span
                class="ml-2 text-warning select-none"
                title={`内含变更：删 ${c!.del} / 增 ${c!.add} 行（展开查看）`}
            >
                ●{" "}
                {c!.del > 0 ? `-${c!.del}` : ""}
                {c!.del > 0 && c!.add > 0 ? " " : ""}
                {c!.add > 0 ? `+${c!.add}` : ""}
            </span>
        </Show>
    );
}


// ─── 压缩历史（事件快照列表 + 撤销）────────────────
//
// 【用户 2026-10-07】取代旧的「分代」：历史 = 固定的消息集合；一次压缩 = 用**某算法**对它定义的
// 一个**过滤条件**。列表列的就是这些不可变快照（算法 + 过滤器 + 结果 + 方式/理由）。
// 当前配置对历史回溯无效 —— 回溯只看当时那条事件。

/** 一条压缩事件（快照）。字段与账本 `CompactEventRecord` 对齐（这里只取展示需要的）。 */
interface CompactEventRow {
    kind: string;
    id?: string;
    ts?: string;
    by?: "ui" | "cli" | "auto";
    trigger?: string;
    /** v3 = modeData 嵌套；v2 = 扁平（读旧账本）—— 两种都收 */
    policy?: {
        mode?: string;
        modeData?: { budgetBytes?: number; toolResult?: { render?: string }; keep?: { scope?: string; count?: number }; content?: { kind?: string } };
        budgetBytes?: number;
        keep?: { scope?: string; count?: number };
        content?: { kind?: string };
    };
    size?: {
        before?: { turns: number; messages: number; bytes: number };
        after?: { turns: number; messages: number; bytes: number };
        keptTurns?: number;
        droppedTurns?: number;
    };
    /** undo 事件回指的 compact id */
    ref?: string;
}

/** 算法中文名（`policy.mode`）；未知算法原样显示 —— 换算法加新分支即可 */
function algoName(mode: string | undefined): string {
    switch (mode) {
        case "budget":
            return "预算";
        case "reset":
            return "清零";
        case "keep":
            return "保留";
        default:
            return mode ?? "—";
    }
}

/** 算法的**过滤器表达**（算法私有，故按 mode 分派；换算法加新分支） */
function filterText(p: CompactEventRow["policy"]): string {
    if (!p) return "—";
    const md = p.modeData ?? p; // v3 嵌套 / v2 扁平
    if (p.mode === "budget") {
        const bb = md.budgetBytes;
        const kb = bb === undefined ? "?" : bb === 0 ? "0（=清零）" : `${Math.round(bb / 1024)} KB`;
        return `上限 ${kb}`;
    }
    if (p.mode === "keep") {
        const keep = md.keep;
        const scope = keep?.scope === "all" ? "全部轮次" : `最近 ${keep?.count ?? "?"} 轮`;
        const k = md.content?.kind;
        const content = k === "conclusion" ? "只留结论" : k === "text" ? "只留文本" : "全部";
        return `${scope} · ${content}`;
    }
    if (p.mode === "reset") return "不投任何历史轮";
    return "—";
}

const fmtBytes = (n: number | undefined): string => {
    if (n === undefined) return "—";
    if (n >= 1024) return `${(n / 1024).toFixed(1)} KB`;
    return `${n} B`;
};

export function CompactHistoryPanel(props: { uri: string; onClose: () => void }) {
    const [events, { refetch }] = createResource(
        () => props.uri,
        async (u) => (await localChatStore.compactEvents(u)) as CompactEventRow[],
    );
    const [busy, setBusy] = createSignal(false);
    const [maximized, setMaximized] = createSignal(false);

    /** 只列 compact 事件（measure / undo 是附属记录，不单独成行） */
    const rows = () => (events() ?? []).filter((e) => e.kind === "compact");
    /** 已被 undo 的 compact id（行上标"已撤销"） */
    const undone = () => new Set((events() ?? []).filter((e) => e.kind === "undo").map((e) => e.ref));

    const undo = async (ref: string) => {
        setBusy(true);
        try {
            await localChatStore.undoCompact(props.uri, ref);
            await refetch();
        } finally {
            setBusy(false);
        }
    };

    return (
        <div
            class="fixed inset-0 z-50 bg-black/60 flex items-center justify-center p-6"
            onClick={(e) => {
                if (e.target === e.currentTarget) props.onClose();
            }}
        >
            <div class={`bg-base-100 rounded-xl w-full flex flex-col ${maximized() ? "max-w-[96vw] h-[92vh]" : "max-w-3xl max-h-[90vh]"}`}>
                <div class="px-4 py-3 border-b flex items-center justify-between">
                    <div class="font-bold text-title">压缩历史（{rows().length} 次快照）</div>
                    <div class="flex items-center gap-1">
                        <DrawerMaxButton max={maximized()} onToggle={() => setMaximized((v) => !v)} />
                        <button class="btn btn-ghost btn-xs" onClick={props.onClose}>
                            ✕
                        </button>
                    </div>
                </div>
                <div class="px-4 py-1.5 text-caption opacity-60 border-b">
                    ⓘ 每次压缩 = 用**某算法**对历史消息定义的一个**过滤条件**（不可变快照）。当前配置改动
                    **不回改**这些快照；回溯看的就是当时这一次。
                </div>
                <div class="overflow-auto grow">
                    <Show
                        when={rows().length > 0}
                        fallback={<div class="p-6 opacity-60">还没有压缩记录。</div>}
                    >
                        <table class="table table-xs">
                            <thead>
                                <tr>
                                    <th>时间</th>
                                    <th>算法</th>
                                    <th>过滤器</th>
                                    <th class="text-right">轮次</th>
                                    <th class="text-right">消息</th>
                                    <th class="text-right">字节</th>
                                    <th>方式 / 理由</th>
                                    <th />
                                </tr>
                            </thead>
                            <tbody>
                                <For each={rows()}>
                                    {(e) => {
                                        const isUndone = () => !!e.id && undone().has(e.id);
                                        return (
                                            <tr>
                                                <td class="opacity-70 whitespace-nowrap">
                                                    {e.ts ? new Date(e.ts).toLocaleString() : "—"}
                                                </td>
                                                <td>
                                                    <span class="badge badge-ghost badge-xs">{algoName(e.policy?.mode)}</span>
                                                </td>
                                                <td class="opacity-80 text-caption">{filterText(e.policy)}</td>
                                                <td class="text-right tabular-nums">
                                                    {e.size?.before?.turns ?? "?"} → {e.size?.after?.turns ?? "?"}
                                                </td>
                                                <td class="text-right tabular-nums">
                                                    {e.size?.before?.messages ?? "?"} → {e.size?.after?.messages ?? "?"}
                                                </td>
                                                <td class="text-right tabular-nums">
                                                    {fmtBytes(e.size?.before?.bytes)} → {fmtBytes(e.size?.after?.bytes)}
                                                </td>
                                                <td class="opacity-80 text-caption">
                                                    <span class="badge badge-xs" classList={{ "badge-info": e.by === "auto" }}>
                                                        {e.by === "auto" ? "自动" : e.by === "ui" ? "界面" : "命令行"}
                                                    </span>
                                                    <span class="ml-1">{triggerText(e.trigger)}</span>
                                                    <Show when={isUndone()}>
                                                        <span class="ml-1 badge badge-warning badge-xs">已撤销</span>
                                                    </Show>
                                                </td>
                                                <td class="text-right">
                                                    <Show when={!isUndone() && e.id}>
                                                        <button
                                                            class="btn btn-ghost btn-xs text-warning"
                                                            disabled={busy()}
                                                            title="标记这次压缩作废（append-only，可审计）"
                                                            onClick={() => void undo(e.id!)}
                                                        >
                                                            撤销
                                                        </button>
                                                    </Show>
                                                </td>
                                            </tr>
                                        );
                                    }}
                                </For>
                            </tbody>
                        </table>
                    </Show>
                </div>
            </div>
        </div>
    );
}

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

import { createSignal, createResource, createEffect, on, For, Show, createMemo, onMount, onCleanup, type JSX } from "solid-js";
import { localChatStore } from "../store/localChatStore";
import {
    DEFAULT_COMPACT_POLICY,
    flatPolicyOf,
    type FlatCompactPolicy,
    type ToolResultMode,
} from "../../shared/context/compaction";
import {
    collapsedAtLevel,
    diffValues,
    foldLevelCount,
    subtreeChanges,
    visibleDiffRows,
    type YamlDiffRow,
} from "../../shared/yaml-lines";
import { requestViewYaml, type LayerRow, type RequestView } from "../../shared/context/request-view";
import { VIEW_BAR_H } from "../lib/layout-metrics";
import { DrawerMaxButton } from "./DrawerMaximize";

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
function FactRow(props: { row: LayerRow; isTotal: boolean; isLast: boolean }) {
    const saved = () => props.row.costDelta < 0;
    const zero = () => Math.abs(props.row.costDelta) < 1e-9;
    const symbol = () => (props.isTotal ? "" : props.isLast ? "└ " : "├ ");
    return (
        <tr title={props.row.label} class={props.isTotal ? "font-semibold" : ""}>
            <td class="pr-2 whitespace-nowrap">
                <span class={props.isTotal ? "" : "opacity-50 font-mono"}>{symbol()}</span>
                {props.row.name}
            </td>
            <td class="text-right tabular-nums opacity-70">{props.row.oldTokens.toLocaleString()}</td>
            <td class="text-right tabular-nums">{props.row.newTokens.toLocaleString()}</td>
            <td class={`text-right tabular-nums ${saved() ? "text-success" : zero() ? "opacity-50" : "text-error"}`}>
                {zero() ? "0" : `${props.row.costDelta < 0 ? "−" : "+"}$${Math.abs(props.row.costDelta).toFixed(4)}`}
            </td>
        </tr>
    );
}

export function CompactSessionPanel(props: { uri: string; onClose: () => void }) {
    // UI 用**扁平策略**（keepTurns/toolResult/headtail…）：它是稳定的输入面契约；
    // 三轴形状由 main 侧 normalizePolicy 统一生成（见 shared/context/compaction 的策略区）。
    const [pol, setPolRaw] = createSignal<FlatCompactPolicy>(flatPolicyOf(DEFAULT_COMPACT_POLICY));
    const setPol = (p: Partial<FlatCompactPolicy>) => setPolRaw({ ...pol(), ...p });
    const [busy, setBusy] = createSignal(false);
    const [err, setErr] = createSignal<string | null>(null);
    /**
     * 抽屉高度（px）：**贴着上方、从底部拖拽调整**（形态对齐 token 窗口的用量抽屉，
     * 而非居中 dialog）。默认 2/3 屏高；拖把握手在面板底边。
     */
    const [height, setHeight] = createSignal(Math.round(window.innerHeight * 0.66));
    /** 最大化：与拖拽共存 —— 最大化时占满可视高；一旦拖动即退出最大化 */
    const [maximized, setMaximized] = createSignal(false);
    const drawerHeight = () => (maximized() ? window.innerHeight : height());
    const startResize = (e: MouseEvent) => {
        e.preventDefault();
        const startY = e.clientY;
        const startH = height();
        const move = (ev: MouseEvent) => {
            setMaximized(false);
            const h = Math.round(startH + ev.clientY - startY);
            setHeight(Math.min(window.innerHeight - 8, Math.max(180, h)));
        };
        const up = () => {
            window.removeEventListener("mousemove", move);
            window.removeEventListener("mouseup", up);
        };
        window.addEventListener("mousemove", move);
        window.addEventListener("mouseup", up);
    };

    // 右栏视图控制
    const [sideBySide, setSideBySide] = createSignal(false);
    const [onlyDiff, setOnlyDiff] = createSignal(true);
    /**
     * 展开层级：0 = 只露根行；N = 全展开（N 随会话 YAML 深度而变）。
     * 「展开 i/N」按钮点一下 +1，到顶再回到 0 —— **逐级展开**，不搞「一键全开」。
     */
    const [expandLevel, setExpandLevel] = createSignal(Number.MAX_SAFE_INTEGER); // 默认展开到最大层级

    const turnCount = () => localChatStore.trees.length;

    // base 请求（打开面板取一次，参数变化不重取）
    const [base] = createResource(() => props.uri, (u) => localChatStore.requestView(u) as Promise<RequestView>);

    /** 已生成的历史摘要（文字 + 结构化 + 金额）；未生成 = null */
    const [summary, setSummary] = createSignal<{ text: string; data: unknown; cost: number | null } | null>(null);
    const [sumBusy, setSumBusy] = createSignal(false);
    const [sumErr, setSumErr] = createSignal<string | null>(null);

    // 预览（只算不写）：策略变化即重算（返回 mod 请求 + 事实表）
    const [pv] = createResource(
        () => ({ uri: props.uri, p: pol(), sum: summary()?.text }),
        (k) => localChatStore.compactPreview(k.uri, k.p, k.sum) as Promise<{
            before: { bytes: number };
            after: { bytes: number };
            keptTurns: number;
            droppedTurns: number;
            facts: LayerRow[];
            modRequest: RequestView;
        }>,
    );

    // 两级 diff：以两个请求**对象**做节点级对齐（不是 YAML 文本行）
    const rows = createMemo<YamlDiffRow[]>(() => {
        const b = base();
        const m = pv();
        if (!b || !m) return [];
        return diffValues(requestViewYaml(b), requestViewYaml(m.modRequest));
    });

    /** 可折叠深度数 = 「展开 i/N」的 N（i 从 0 到 N；i = N 时全展开） */
    const foldLevels = createMemo(() => foldLevelCount(rows()));
    /** 当前用于显示的档位（默认「最大」用 sentinel 表示，这里夹到 N） */
    const curLevel = createMemo(() => Math.min(expandLevel(), foldLevels()));
    /** 逐级展开：点一下多展开一级；到顶（N）回到 0 级循环 */
    const nextLevel = () => {
        const n = foldLevels();
        setExpandLevel((v) => (Math.min(v, n) >= n ? 0 : Math.min(v, n) + 1));
    };

    /** 手动折叠覆盖：点某个节点箭头时，单独翻转它的折叠态（叠加在层级展开之上） */
    const [manual, setManual] = createSignal<{ level: number; collapsed: Set<number> }>({ level: -1, collapsed: new Set() });
    const toggleFold = (i: number) => {
        const base = collapsed();
        const cur = new Set(base);
        if (cur.has(i)) cur.delete(i);
        else cur.add(i);
        setManual({ level: curLevel(), collapsed: cur });
    };
    /** 层级变化时丢弃手动覆盖（换级 = 重新按层级展开） */
    createEffect(on(curLevel, () => setManual({ level: -1, collapsed: new Set() }), { defer: true }));

    /** 折叠集合：由展开档位推出（折叠深度 >= 当前档位深度）；手动点击覆盖之 */
    const collapsed = createMemo<Set<number>>(() => {
        const lv = curLevel();
        const m = manual();
        return m.level === lv ? m.collapsed : collapsedAtLevel(rows(), lv);
    });
    /** 每个可折叠行子树内的变更数（折叠时在箭头上标出「里面有改动」） */
    const changes = createMemo(() => subtreeChanges(rows()));

    const shownIndexes = createMemo(() => visibleDiffRows(rows(), collapsed()));
    /**
     * 行对象缓存：**同一行索引复用同一对象引用**。
     *
     * 为什么必须缓存：Solid 的 `<For>` 按**引用**做 keyed 差分。若每次现造 `{i,row}`，
     * 展开/折叠后所有项引用都变 → For 判定"全换了" → 整个列表 DOM 重建 →
     * **焦点丢失、滚动条弹回顶部**（用户实测：点尖头展开一个节点，视线被拽回第一行）。
     * 引用稳定后，For 只增删真正变化的行，滚动位置与焦点原地不动。
     */
    const rowCache = new Map<number, { i: number; row: YamlDiffRow }>();
    /** 「只看差异」保留的上下文行数（变更行上下各留 N 行）——头尾裁剪保留的头/尾行因此可见 */
    const CONTEXT_LINES = 3;
    const renderRows = createMemo(() => {
        const idx = shownIndexes();
        const all = rows();
        const ch = changes();
        // 保留集 = 变更行 + 变更的祖先节头 + 变更行上下 CONTEXT 行（上下文只绕**变更行**展开，
        // 不绕祖先 —— 否则会把祖先上方不相关的行（如 tools 段末）也带进来）。
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

    /** 生成摘要（显式、花钱一次）；结果直接进预览 */
    const genSummary = async () => {
        setSumBusy(true);
        setSumErr(null);
        try {
            // 摘要的对象是**被丢弃的轮**；保留全部轮次时没有被丢弃的内容 —— 说清楚，别静默摘要出一堆空话
            const keepN = pol().keepTurns;
            if (keepN === "all") {
                setSumErr("保留全部轮次时没有可摘要的内容（摘要针对被丢弃的轮）");
                setSumBusy(false);
                return;
            }
            const r = (await localChatStore.summarize(props.uri, keepN)) as {
                text: string;
                data: unknown;
                cost: number | null;
            };
            setSummary(r);
        } catch (e) {
            setSumErr(String(e instanceof Error ? e.message : e));
        } finally {
            setSumBusy(false);
        }
    };

    const apply = async () => {
        setBusy(true);
        setErr(null);
        try {
            await localChatStore.compact(props.uri, pol(), pol().summary ? (summary() ?? undefined) : undefined);
            props.onClose();
        } catch (e) {
            setErr(String(e instanceof Error ? e.message : e));
        } finally {
            setBusy(false);
        }
    };

    const onKey = (e: KeyboardEvent) => {
        if (e.key === "Escape") {
            e.stopPropagation();
            props.onClose();
        }
    };
    onMount(() => document.addEventListener("keydown", onKey, true));
    onCleanup(() => document.removeEventListener("keydown", onKey, true));

    // 概要：当前 → 压缩后（估算 token）
    const estTok = (bytes: number) => Math.round(bytes / 4);
    const ratio = () => {
        const b = pv()?.before.bytes ?? 0;
        const a = pv()?.after.bytes ?? 0;
        return b > 0 ? Math.round((1 - a / b) * 100) : 0;
    };
    const diffCounts = createMemo(() => {
        let add = 0, del = 0;
        for (const r of rows()) {
            if (r.t === "add") add++;
            else if (r.t === "del") del++;
            else if (r.t === "change") { add++; del++; }
        }
        return { add, del };
    });

    return (
        <div class="fixed inset-0 z-50 flex flex-col" onClick={props.onClose}>
            <div class="absolute inset-0 bg-black/30" />
            <div
                class="relative flex shrink-0 flex-col overflow-hidden border-b border-base-300 bg-base-100 shadow-2xl"
                style={{ height: `${drawerHeight()}px` }}
                onClick={(e) => e.stopPropagation()}
            >
                <div class={`px-4 border-b flex items-center justify-between shrink-0 ${VIEW_BAR_H}`}>
                    <div class="font-bold text-title">压缩会话上下文</div>
                    <div class="text-caption opacity-70">
                        当前 {estTok(pv()?.before.bytes ?? 0).toLocaleString()} tok → 压缩后{" "}
                        {estTok(pv()?.after.bytes ?? 0).toLocaleString()} tok{" "}
                        <span class="text-success">(-{ratio()}%)</span>
                        <span class="opacity-60">　删 {diffCounts().del} / 增 {diffCounts().add} 行</span>
                    </div>
                    <div class="flex items-center gap-1">
                        <DrawerMaxButton max={maximized()} onToggle={() => setMaximized((v) => !v)} />
                        <button class="btn btn-ghost btn-xs" onClick={props.onClose}>
                            ✕
                        </button>
                    </div>
                </div>

                <div class="flex min-h-0 grow overflow-hidden">
                    {/* ── 左栏：压缩选项 + 压缩后估算（两个可折叠 view）────────── */}
                    <div class="w-[340px] shrink-0 border-r overflow-auto p-2 space-y-2">
                        <Block title="压缩选项">
                            <div class="space-y-3">
                                <section>
                                    <div class="text-caption font-semibold opacity-70 mb-1">① 保留范围</div>
                                    <input
                                        type="range"
                                        min="0"
                                        max={Math.max(1, turnCount())}
                                        step="1"
                                        class="range range-primary range-sm w-full"
                                        value={pol().keepTurns === "all" ? turnCount() : pol().keepTurns}
                                        disabled={pol().keepTurns === "all"}
                                        aria-label="保留最近轮数"
                                        onInput={(e) => setPol({ keepTurns: Number(e.currentTarget.value) })}
                                    />
                                    <div class="text-caption opacity-80">
                                        保留最近 <b>{pol().keepTurns}</b> 轮（共 {turnCount()} 轮）
                                        {pol().keepTurns === 0 ? " · 全部清零" : ""}
                                    </div>
                                    {/* "全留"必须单列一个开关：滑到最右只能留"共 N 轮"，而轮数是会长的 ——
                                        自动压缩的默认策略要的是"保留**所有**轮次的结论"，那是个不写死数字的意图 */}
                                    <label class="mt-1 flex items-center gap-1.5 cursor-pointer text-caption">
                                        <input
                                            type="checkbox"
                                            class="checkbox checkbox-xs checkbox-primary"
                                            checked={pol().keepTurns === "all"}
                                            onChange={(e) => setPol({ keepTurns: e.currentTarget.checked ? "all" : 6 })}
                                        />
                                        <span>全部保留（配合②只裁内容 ⇒ 留所有轮次的结论）</span>
                                    </label>
                                </section>

                                <section>
                                    <div class="text-caption font-semibold opacity-70 mb-1">② 内容（留过程 还是 只留结论）</div>
                                    <div class="flex flex-col gap-1 text-body">
                                        <label class="flex items-center gap-1.5 cursor-pointer">
                                            <input
                                                type="radio"
                                                class="radio radio-xs radio-primary"
                                                checked={(pol().content ?? "all") === "all"}
                                                onChange={() => setPol({ content: "all" })}
                                            />
                                            <span>全部（用户 + 助手文本 + 工具过程）</span>
                                        </label>
                                        <label class="flex items-center gap-1.5 cursor-pointer">
                                            <input
                                                type="radio"
                                                class="radio radio-xs radio-primary"
                                                checked={pol().content === "text"}
                                                onChange={() => setPol({ content: "text" })}
                                            />
                                            <span>只留文本（去掉工具调用与结果）</span>
                                        </label>
                                        <label class="flex items-center gap-1.5 cursor-pointer">
                                            <input
                                                type="radio"
                                                class="radio radio-xs radio-primary"
                                                checked={pol().content === "conclusion"}
                                                onChange={() => setPol({ content: "conclusion" })}
                                            />
                                            <span>只留结论（每轮只留最后一条助手文本）</span>
                                        </label>
                                        <Show when={(pol().content ?? "all") !== "all"}>
                                            <div class="ml-5 text-caption opacity-60">
                                                ⓘ 省掉的部分会在历史里**分段标注**（哪几行、为什么省），模型可按行号回取原文
                                            </div>
                                        </Show>
                                    </div>
                                </section>

                                <section>
                                    <div class="text-caption font-semibold opacity-70 mb-1">③ 工具结果（只对保留部分生效）</div>
                                    <div class="flex flex-col gap-1 text-body">
                                        {/* asis */}
                                        <label class="flex items-center gap-1.5 cursor-pointer">
                                            <input
                                                type="radio"
                                                class="radio radio-xs radio-primary"
                                                checked={pol().toolResult === "asis"}
                                                onChange={() => setPol({ toolResult: "asis" })}
                                            />
                                            <span>原样（不裁）</span>
                                        </label>

                                        {/* headtail：保留行数就放在本选项下面（不再漂到别的选项下） */}
                                        <label class="flex items-center gap-1.5 cursor-pointer">
                                            <input
                                                type="radio"
                                                class="radio radio-xs radio-primary"
                                                checked={pol().toolResult === "headtail"}
                                                onChange={() => setPol({ toolResult: "headtail" })}
                                            />
                                            <span>头尾裁剪（保留头尾，中间省略）</span>
                                        </label>
                                        <Show when={pol().toolResult === "headtail"}>
                                            <div class="ml-5 flex items-center gap-1.5 text-caption">
                                                <span>保留 前</span>
                                                <input
                                                    type="number"
                                                    class="input input-xs w-14"
                                                    value={pol().headtail.headLines}
                                                    aria-label="保留头部行数"
                                                    onInput={(e) => setPol({ headtail: { ...pol().headtail, headLines: Number(e.currentTarget.value) } })}
                                                />
                                                <span>行 后</span>
                                                <input
                                                    type="number"
                                                    class="input input-xs w-14"
                                                    value={pol().headtail.tailLines}
                                                    aria-label="保留尾部行数"
                                                    onInput={(e) => setPol({ headtail: { ...pol().headtail, tailLines: Number(e.currentTarget.value) } })}
                                                />
                                                <span>行</span>
                                            </div>
                                            <div class="ml-5 text-caption opacity-60">
                                                ⓘ 超过 {pol().headtail.headLines + pol().headtail.tailLines} 行的输出才裁剪；裁掉的原文落盘可寻回
                                            </div>
                                        </Show>

                                        {/* callpath */}
                                        <label class="flex items-center gap-1.5 cursor-pointer">
                                            <input
                                                type="radio"
                                                class="radio radio-xs radio-primary"
                                                checked={pol().toolResult === "callpath"}
                                                onChange={() => setPol({ toolResult: "callpath" })}
                                            />
                                            <span>只留调用+路径（整段换成原文路径）</span>
                                        </label>
                                        <Show when={pol().toolResult === "callpath"}>
                                            <div class="ml-5 text-caption opacity-60">整段输出换成一行指向原文的提示，模型可按路径回取。</div>
                                        </Show>
                                    </div>
                                </section>

                                <section>
                                    <label class="flex items-start gap-2 cursor-pointer">
                                        <input
                                            type="checkbox"
                                            class="checkbox checkbox-xs checkbox-primary mt-0.5"
                                            checked={pol().summary}
                                            onChange={(e) => setPol({ summary: e.currentTarget.checked })}
                                        />
                                        <span class="text-body">
                                            ④ 计算历史摘要并带进新会话
                                            <span class="block text-caption opacity-60">
                                                可选（额外调一次模型）。清零只丢会话历史，任务记忆仍在任务正文里。
                                            </span>
                                        </span>
                                    </label>
                                    <Show when={pol().summary}>
                                        <div class="ml-5 mt-1 flex items-center gap-2 text-caption">
                                            <button
                                                class="btn btn-outline btn-xs"
                                                aria-label="生成摘要"
                                                disabled={sumBusy() || busy()}
                                                onClick={() => void genSummary()}
                                            >
                                                {sumBusy() ? "生成中…" : summary() ? "重新生成摘要" : "生成摘要"}
                                            </button>
                                            <Show when={summary()}>
                                                <span class="text-success">
                                                    已生成{summary()!.cost != null ? `（$${summary()!.cost!.toFixed(4)}）` : ""}
                                                </span>
                                            </Show>
                                            <Show when={!summary()}>
                                                <span class="opacity-60">未生成时，预览显示模版骨架（占位）</span>
                                            </Show>
                                        </div>
                                        <Show when={sumErr()}>
                                            <div class="ml-5 mt-1 text-caption text-error">{sumErr()}</div>
                                        </Show>
                                    </Show>
                                </section>
                            </div>
                        </Block>

                        {/* 压缩后估算：压缩前 / 压缩后 / 预估节省。合计占首行，各层用 ├/└ 缩进表达层级 */}
                        <Block title="压缩后估算">
                            <table class="table table-xs w-full">
                                <thead>
                                    <tr class="text-caption">
                                        <th>被压缩的历史消息</th>
                                        <th class="text-right">压缩前</th>
                                        <th class="text-right">压缩后</th>
                                        <th class="text-right">预估节省</th>
                                    </tr>
                                </thead>
                                <tbody>
                                    <For each={pv()?.facts ?? []}>
                                        {(r, i) => (
                                            <FactRow
                                                row={r}
                                                isTotal={r.key === "total"}
                                                isLast={i() === (pv()?.facts.length ?? 1) - 1}
                                            />
                                        )}
                                    </For>
                                </tbody>
                            </table>
                            <div class="mt-1 text-caption opacity-60">
                                token 按字节/4 估算，仅用于对比（不进计费）；金额差按当前模型非缓存输入单价。
                            </div>
                        </Block>
                    </div>

                    {/* ── 右栏：请求 YAML diff ─────────────────────────── */}
                    <div class="grow flex flex-col overflow-hidden">
                        <div class="px-3 py-1.5 border-b flex items-center gap-3 shrink-0 text-caption">
                            <div class="join">
                                <button
                                    class={`btn btn-xs join-item ${!sideBySide() ? "btn-active" : "btn-ghost"}`}
                                    onClick={() => setSideBySide(false)}
                                >
                                    统一 diff
                                </button>
                                <button
                                    class={`btn btn-xs join-item ${sideBySide() ? "btn-active" : "btn-ghost"}`}
                                    onClick={() => setSideBySide(true)}
                                >
                                    并排
                                </button>
                            </div>
                            <label class="flex items-center gap-1 cursor-pointer">
                                <input
                                    type="checkbox"
                                    class="checkbox checkbox-xs"
                                    checked={onlyDiff()}
                                    onChange={(e) => setOnlyDiff(e.currentTarget.checked)}
                                />
                                只看差异
                            </label>
                            <button
                                class="btn btn-ghost btn-xs"
                                aria-label="逐级展开"
                                onClick={nextLevel}
                            >
                                展开 {curLevel()}/{foldLevels()}
                            </button>
                            <span class="opacity-50 ml-auto">请求结构 YAML（base vs mod）</span>
                        </div>

                        <div class="overflow-auto grow p-2 text-caption font-mono leading-[1.5]" data-compact-preview>
                            <Show when={!sideBySide()} fallback={
                                <table class="w-full border-collapse">
                                    <tbody>
                                        <For each={renderRows()}>
                                            {({ i, row }) => (
                                                <tr class={row.t === "add" ? "bg-success/10" : row.t === "del" || row.t === "change" ? "bg-error/10" : ""}>
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
                            }>
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

                <div class="px-4 py-2 border-t flex items-center justify-between gap-2 shrink-0">
                    <Show when={err()}>
                        <span class="text-caption text-error">{err()}</span>
                    </Show>
                    <div class="flex-1" />
                    <button class="btn btn-xs" onClick={props.onClose}>
                        取消
                    </button>
                    <button
                        class="btn btn-primary btn-xs"
                        aria-label="执行压缩"
                        disabled={busy()}
                        onClick={() => void apply()}
                    >
                        {busy() ? "压缩中…" : "压缩（历史保留）"}
                    </button>
                </div>
                {/* 底边拖拽把手：调整抽屉高度（对齐 token 窗口用量抽屉的形态） */}
                <div
                    class="h-1.5 shrink-0 cursor-row-resize bg-base-300 hover:bg-primary/50 active:bg-primary"
                    title="拖动调整高度"
                    aria-label="拖动调整高度"
                    onMouseDown={startResize}
                />
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


// ─── 历史会话（代列表 + 只读查看 + 撤销）────────────────

interface GenRow {
    seq: number;
    fromTurnId: string | null;
    startedAt: string | null;
    current: boolean;
    turns: number;
    messages: number;
    bytes: number;
    totalTokens: number;
    cost: number | null;
    compactId: string | null;
}

export function GenerationsPanel(props: { uri: string; onClose: () => void }) {
    const [gens, { refetch }] = createResource(() => props.uri, async (u) => (await localChatStore.generations(u)) as GenRow[]);
    const [openSeq, setOpenSeq] = createSignal<number | null>(null);
    const [opsView] = createResource(openSeq, async (seq) => (seq == null ? [] : await localChatStore.generationOps(props.uri, seq)));
    const [busy, setBusy] = createSignal(false);
    const [maximized, setMaximized] = createSignal(false);

    const undo = async (ref: string) => {
        setBusy(true);
        try {
            await localChatStore.undoCompact(props.uri, ref);
            await refetch();
        } finally {
            setBusy(false);
        }
    };

    const asText = (ops: { op: string; kind?: string; id: string }[]) =>
        ops
            .filter((o) => o.op === "delta")
            .map((o) => (o as unknown as { fields?: { content?: string } }).fields?.content ?? "")
            .filter(Boolean)
            .join("\n");

    return (
        <div
            class="fixed inset-0 z-50 bg-black/60 flex items-center justify-center p-6"
            onClick={(e) => {
                if (e.target === e.currentTarget) props.onClose();
            }}
        >
            <div
                class={`bg-base-100 rounded-xl w-full flex flex-col ${maximized() ? "max-w-[96vw] h-[92vh]" : "max-w-2xl max-h-[90vh]"}`}
            >
                <div class="px-4 py-3 border-b flex items-center justify-between">
                    <div class="font-bold text-title">历史会话（{gens()?.length ?? 0} 代）</div>
                    <div class="flex items-center gap-1">
                        <DrawerMaxButton max={maximized()} onToggle={() => setMaximized((v) => !v)} />
                        <button class="btn btn-ghost btn-xs" onClick={props.onClose}>
                            ✕
                        </button>
                    </div>
                </div>
                <div class="overflow-auto grow">
                    <Show when={openSeq() == null} fallback={
                        <div class="p-3">
                            <button class="btn btn-ghost btn-xs mb-2" onClick={() => setOpenSeq(null)}>
                                ← 返回列表
                            </button>
                            <div class="text-caption opacity-60 mb-1">只读 · 旧会话内容（不可续聊）</div>
                            <pre class="whitespace-pre-wrap text-caption font-mono opacity-80">{asText(opsView() ?? [])}</pre>
                        </div>
                    }>
                        <table class="table table-xs">
                            <thead>
                                <tr>
                                    <th>代</th>
                                    <th>起始</th>
                                    <th class="text-right">轮</th>
                                    <th class="text-right">消息</th>
                                    <th class="text-right">token</th>
                                    <th class="text-right">金额</th>
                                    <th />
                                </tr>
                            </thead>
                            <tbody>
                                <For each={gens()}>
                                    {(g) => (
                                        <tr>
                                            <td>
                                                第 {g.seq} 代 {g.current ? <span class="badge badge-primary badge-xs">当前</span> : null}
                                            </td>
                                            <td class="opacity-70">{g.startedAt ? new Date(g.startedAt).toLocaleString() : "—"}</td>
                                            <td class="text-right tabular-nums">{g.turns}</td>
                                            <td class="text-right tabular-nums">{g.messages}</td>
                                            <td class="text-right tabular-nums">{g.totalTokens.toLocaleString()}</td>
                                            <td class="text-right tabular-nums">{g.cost == null ? "—" : `$${g.cost.toFixed(4)}`}</td>
                                            <td class="text-right">
                                                <button class="btn btn-ghost btn-xs" onClick={() => setOpenSeq(g.seq)}>
                                                    查看
                                                </button>
                                                <Show when={!g.current && g.compactId}>
                                                    <button
                                                        class="btn btn-ghost btn-xs text-warning"
                                                        disabled={busy()}
                                                        title="撤销这次压缩（历史原地恢复，可审计）"
                                                        onClick={() => void undo(g.compactId!)}
                                                    >
                                                        撤销
                                                    </button>
                                                </Show>
                                            </td>
                                        </tr>
                                    )}
                                </For>
                            </tbody>
                        </table>
                    </Show>
                </div>
            </div>
        </div>
    );
}

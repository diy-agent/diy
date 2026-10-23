import { createSignal, createEffect, createMemo, on, For, Show } from "solid-js";
import { load as yamlLoad } from "js-yaml";
import { MarkdownView } from "./MarkdownView";
import { dedentYamlBlock } from "../../shared/yaml-lines";

/** JSON 树形查看：对象/数组逐层折叠，长字符串按真实换行展开。
 *  长字符串可切换预览格式（MD / JSON / YAML）：字符串里塞的往往是 markdown 正文、
 *  被转义的 JSON、或 YAML —— 直接看一堆 `\n` / 转义引号太难认，给几个「猜一猜」的渲染态。
 *  解决 JSON.stringify 一坨转义没法看的问题（请求体 messages[].content 等多行内容）。 */

const LONG_STR = 200;

/**
 * 展示语法：`json`（`{ "k": v }`，与数据源一致）或 `yaml`（`k: v` / `- `，无括号）。
 *
 * 为什么要两种：树视图服务两拨人 —— 流量页要对得上「真发出去的 JSON」，大脑页要对得上
 * 「模型看到的 YAML 信封」。给人读时 YAML 少两层括号、少一圈引号，同样内容短一截；
 * 但**不能全局改**，否则流量页的 JSON 原文与树视图打架（用户核对时会对不上字节）。
 * 因此缺省仍是 json，由调用方按场景选。
 */
export type TreeSyntax = "json" | "yaml";

/** 长字符串可切的预览格式（按内容猜：markdown 正文 / 内嵌 JSON / 内嵌 YAML） */
const FORMATS = [
    { v: "md", label: "MD", tip: "按 Markdown 渲染（猜测性预览）" },
    { v: "json", label: "JSON", tip: "按 JSON 解析后树形展示；解析失败会提示" },
    { v: "yaml", label: "YAML", tip: "按 YAML 解析后树形展示；解析失败会提示" },
] as const;

/**
 * 嵌套层级底色：逐层加深，让「谁在谁里面」一眼可见（不靠数缩进）。
 *
 * 为什么用 inline style 而不是工具类：层级是运行时才知道的，`bg-base-200/[0.04]` 这种
 * 动态 alpha 类 Tailwind 扫不到 → 不会生成，只能走 inline。颜色是中性偏蓝的灰，暗/亮主题
 * 下都是「比背景略亮一丢丢」的叠加，越深越明显，到 0.16 封顶（再深就看不清字了）。
 */
function depthTint(depth: number): { background: string } | undefined {
    if (depth <= 0) return undefined;
    const a = Math.min(0.055 + (depth - 1) * 0.045, 0.2);
    return { background: `rgba(125,145,175,${a.toFixed(3)})` };
}

/**
 * 猜测性预览（MD / JSON / YAML）的外框：按格式给不同底色 + 左侧色条，
 * 明确告诉用户「这块不是原文，是被猜成某种格式渲染的」，且一眼分得清猜成了哪种。
 * 原文（raw）不给底色 —— 只有「猜」出来的才需要提示。
 */
function fmtBox(fmt: "raw" | "md" | "json" | "yaml"): string {
    switch (fmt) {
        case "md":
            return "border-info/70 bg-info/15";
        case "json":
            return "border-success/70 bg-success/15";
        case "yaml":
            return "border-warning/70 bg-warning/15";
        default:
            return "border-base-300";
    }
}

/** 预览格式（含 `raw`） */
type Fmt = "raw" | "md" | "json" | "yaml";

/**
 * 猜一个长字符串该按哪种格式读（**默认值**，不是终态 —— 用户仍可用按钮推翻）。
 *
 * 为什么要猜：以前默认 `raw`，于是信封里嵌的 YAML（`system:` 的值）和多行 markdown
 * 全以「一坨带转义/带缩进的纯文本」出现，读者得自己先认出「这是 YAML」再手动点一下按钮。
 * 而那正是这块视图的主要用途（读模型到底看到了什么），猜错成本低于每次都要点。
 *
 * 判据顺序刻意保守：先 YAML（必须解析成对象/数组才算，纯词条解析成字符串一律不算），
 * 再 Markdown（显式标记：标题 / 代码围栏 / 列表 / 表格 / 引用），否则原文。
 */
function guessFmt(s: string): Fmt {
    const t = s.trim();
    if (t.length < 40) return "raw";
    if (/^- /.test(t) || /^(?:\{|[A-Za-z_][\w.$-]*\s*:)/.test(t)) {
        try {
            const d = yamlLoad(t);
            if (d !== null && typeof d === "object") return "yaml";
        } catch {
            /* 不是 YAML，继续猜 md */
        }
    }
    // Markdown 的**显式**标记：标题 / 代码围栏 / 引用 / 列表（含 markdown 常用的 `·` 点）
    // / 表格 / 粗体。只认这些手写时才会出现的记号 —— 宁可按原文，也不要把普通散文渲染成 MD。
    if (
        /(^|\n)(#{1,6} |```|> )/.test(t) ||
        /^\s*\|.*\|/m.test(t) ||
        /(^|\n)([-*+] |· |\d+\. )/.test(t) ||
        /\*\*[^*\n]+\*\*/.test(t)
    ) {
        return "md";
    }
    return "raw";
}

/** 字符串预览：原文 / Markdown / JSON / YAML 四态（后三者是「猜一猜」的渲染） */
function StringPreview(props: { fmt: "raw" | "md" | "json" | "yaml"; raw: string; syntax: TreeSyntax }) {
    return (
        <Show
            when={props.fmt === "md"}
            fallback={
                <Show when={props.fmt !== "raw"} fallback={<pre class="whitespace-pre-wrap font-mono text-body leading-relaxed">{props.raw}</pre>}>
                    <ParsedPreview raw={props.raw} kind={props.fmt as "json" | "yaml"} syntax={props.syntax} />
                </Show>
            }
        >
            <MarkdownView content={props.raw} class="text-body" />
        </Show>
    );
}

/** 把字符串按 JSON / YAML 解析后套进树视图；解析失败给一句人话（不静默退回原文让人误以为空） */
function ParsedPreview(props: { raw: string; kind: "json" | "yaml"; syntax: TreeSyntax }) {
    const res = createMemo(() => {
        try {
            const data =
                props.kind === "json"
                    ? JSON.parse(props.raw)
                    : // YAML：先按原文解析；失败再试「剥掉整体缩进」的版本（见 dedentYamlBlock）
                      (() => {
                          try {
                              return yamlLoad(props.raw);
                          } catch (e) {
                              const dedented = dedentYamlBlock(props.raw);
                              if (dedented === props.raw) throw e;
                              return yamlLoad(dedented);
                          }
                      })();
            return { ok: true as const, data };
        } catch (e) {
            return { ok: false as const, message: e instanceof Error ? e.message : String(e) };
        }
    });
    return (
        <Show
            when={res().ok}
            fallback={<div class="text-warning text-caption">不是合法 {props.kind.toUpperCase()}：{(res() as { message: string }).message}</div>}
        >
            <JsonTree data={(res() as { data: unknown }).data} syntax={props.syntax} />
        </Show>
    );
}

function JsonNode(props: { k?: string; v: unknown; depth: number; floor: () => number; syntax: TreeSyntax }) {
    const yn = (): boolean => props.syntax === "yaml";
    const [open, setOpen] = createSignal(props.depth <= props.floor());
    // 长字符串的预览格式：**缺省按内容猜**（YAML / MD），用户点按钮可推翻回原文
    const guess = (): Fmt => (typeof props.v === "string" ? guessFmt(props.v) : "raw");
    const [fmt, setFmt] = createSignal<Fmt>(guess());
    // 全局展开层级变化时同步；手动折叠在两次点击之间保留
    createEffect(on(() => props.floor(), (f) => setOpen(props.depth <= f)));
    const v = () => props.v;
    const isObj = () => v() !== null && typeof v() === "object";
    const isArr = () => Array.isArray(v());
    const keys = () => (isObj() && !isArr() ? Object.keys(v() as Record<string, unknown>) : []);
    const items = () => (isArr() ? (v() as Array<unknown>) : []);

    // 只有数组留计数器，对象的 {N} 去掉（干扰）
    const summary = () => (isArr() ? `Array(${items().length})` : "");
    /** yaml 折叠态的对象徽章：`N 键`（空对象给 `{}`，否则什么都没有，看着像坏了） */
    const emptyBadge = (): string => (keys().length === 0 ? "{}" : `${keys().length} 键`);
    // YAML 的键裸写（不加引号）：同一份数据少两字符，长键密集处（facts 投影）观感差别明显
    const keyLabel = () => (props.k !== undefined ? <span class="text-info">{yn() ? props.k : `"${props.k}"`}</span> : null);

    // 标量
    if (!isObj()) {
        if (typeof v() === "string") {
            const s = v() as string;
            const lines = s.split("\n");
            const long = lines.length > 1 || s.length > LONG_STR;
            if (!long) {
                return (
                    <div class="py-px">
                        {keyLabel()}
                        {props.k !== undefined && <span class="opacity-40">: </span>}
                        <span class="text-success">{yn() ? s : `"${s}"`}</span>
                    </div>
                );
            }
            return (
                <div class="py-px">
                    <div class="flex items-center gap-1">
                        <button class="opacity-60 hover:opacity-100" onClick={() => setOpen((o) => !o)}>
                            {open() ? "▾" : "▸"}
                        </button>
                        {keyLabel()}
                        {props.k !== undefined && <span class="opacity-40">: </span>}
                        <Show
                            when={open()}
                            fallback={
                                <button class="text-left opacity-70 hover:opacity-100" onClick={() => setOpen(true)}>
                                    <span class="text-success">
                                        {yn() ? lines[0]!.slice(0, 80) : `"${lines[0]!.slice(0, 80)}"`}
                                        {s.length > 80 ? "…" : ""}
                                    </span>
                                    <span class="ml-1 badge badge-xs badge-ghost">
                                        {lines.length > 1 ? `${lines.length}行` : `${s.length}字`}
                                    </span>
                                </button>
                            }
                        >
                            <span class="badge badge-xs badge-ghost">
                                {lines.length}行 · {s.length}字
                            </span>
                        </Show>
                        <Show when={open()}>
                            <span class="join">
                                <Show when={fmt() === guess() && guess() !== "raw"}>
                                    <span class="badge badge-xs badge-ghost" title="按内容自动猜的格式（点按钮可改）">
                                        自动
                                    </span>
                                </Show>
                                <For each={FORMATS}>
                                    {(f) => (
                                        <button
                                            class={`btn btn-xs join-item ${fmt() === f.v ? "btn-primary" : "btn-ghost"}`}
                                            aria-pressed={fmt() === f.v}
                                            title={f.tip}
                                            onClick={() => setFmt((cur) => (cur === f.v ? "raw" : f.v))}
                                        >
                                            {f.label}
                                        </button>
                                    )}
                                </For>
                            </span>
                        </Show>
                    </div>
                    <Show when={open()}>
                        {/* 叶子框用「格式色」而非层级色：这一层要回答的是「猜成了哪种格式」，
                            层级深浅交给外层容器（见下）。两者都上会互相盖掉。 */}
                        <div class={`ml-3 rounded-r border-l-2 pl-2 ${fmtBox(fmt())}`}>
                            <StringPreview fmt={fmt()} raw={s} syntax={props.syntax} />
                        </div>
                    </Show>
                </div>
            );
        }
        const color =
            typeof v() === "number" ? "text-warning" : v() === null ? "opacity-50" : "text-secondary";
        return (
            <div class="py-px">
                {keyLabel()}
                {props.k !== undefined && <span class="opacity-40">: </span>}
                <span class={color}>{JSON.stringify(v())}</span>
            </div>
        );
    }

    // 容器
    return (
        <div class="py-px">
            <div class="flex items-center gap-1">
                <button class="opacity-60 hover:opacity-100" onClick={() => setOpen((o) => !o)}>
                    {open() ? "▾" : "▸"}
                </button>
                {keyLabel()}
                {props.k !== undefined && <span class="opacity-40">: </span>}
                {/* JSON：`{…}` / `[…]` 括号 + 数组计数器；YAML：无括号，折叠态用 `N 键` / `N 项` 徽章 */}
                <Show
                    when={!yn()}
                    fallback={
                        <Show when={!open()}>
                            <button class="opacity-60 hover:opacity-100" onClick={() => setOpen(true)}>
                                <span class="badge badge-xs badge-ghost">
                                    {isArr() ? `${items().length} 项` : emptyBadge()}
                                </span>
                            </button>
                        </Show>
                    }
                >
                    <button class="opacity-70 hover:opacity-100 font-mono" onClick={() => setOpen((o) => !o)}>
                        {isArr() ? "[" : "{"}
                        <Show when={!open() && isArr()}>
                            <span class="opacity-60 text-caption"> {summary()} </span>
                        </Show>
                        <Show when={!open()}>{isArr() ? "]" : "}"}</Show>
                    </button>
                    <Show when={open() && isArr()}>
                        <span class="opacity-40 text-caption font-mono">{summary()}</span>
                    </Show>
                </Show>
            </div>
            <Show when={open()}>
                <div class="ml-3 rounded-r border-l-2 border-base-300 pl-2" style={depthTint(props.depth)}>
                    <Show when={isArr()} fallback={<For each={keys()}>{(k) => <JsonNode k={k} v={(v() as Record<string, unknown>)[k]} depth={props.depth + 1} floor={props.floor} syntax={props.syntax} />}</For>}>
                        <For each={items()}>
                            {(item, i) => (
                                <div class="flex gap-1">
                                    {/* YAML 的列表项是 `- `，没有下标；但审阅 messages[] 时需要序号对账，
                                        故 yaml 态把序号降为极淡的旁注（不占一列宽度心智） */}
                                    <span class="opacity-30 font-mono text-caption pt-0.5">{yn() ? "-" : i()}</span>
                                    <div class="flex-1 min-w-0">
                                        <JsonNode v={item} depth={props.depth + 1} floor={props.floor} syntax={props.syntax} />
                                    </div>
                                </div>
                            )}
                        </For>
                    </Show>
                    {/* YAML 没有闭合括号：结尾不给 `}` 行（给了反而像语法错误） */}
                    <Show when={!yn()}>
                        <div class="opacity-40 font-mono">{isArr() ? "]" : "}"}</div>
                    </Show>
                </div>
            </Show>
        </div>
    );
}

/** 数据最大嵌套深（展开轮转上限） */
function depthOf(v: unknown): number {
    if (v !== null && typeof v === "object") {
        const vs = Array.isArray(v) ? v : Object.values(v as Record<string, unknown>);
        if (vs.length === 0) return 1;
        return 1 + Math.max(...vs.map(depthOf));
    }
    return 0;
}

export function JsonTree(props: { data: unknown; syntax?: TreeSyntax; floor?: number }) {
    const syntax = (): TreeSyntax => props.syntax ?? "json";
    // 展开层级：点一次深一层，到顶后回到 1，往复
    const [local, setLocal] = createSignal(1);
    const max = () => Math.max(1, depthOf(props.data));
    const step = () => setLocal((f) => (f >= max() ? 1 : f + 1));
    /**
     * 受控模式（`floor` 给了值）：深度由调用方总闸给，本组件**不画自己的按钮**
     * —— 用户 2026-10-23：「全部展开和展开到 n 层 为啥是分开的 2 个按钮？合并可行吗？」
     * 两个阶梯并排 = 同一个问题有两个抓手（卡片开合 × 树深度），故上层合并后这里让位。
     */
    const floor = (): number => props.floor ?? local();
    return (
        <div class="font-mono text-body leading-relaxed">
            <Show when={props.floor === undefined}>
                <div class="flex justify-end pb-1">
                    <button class="btn btn-xs btn-ghost" onClick={step}>
                        {floor() >= max() ? `收起 ${max()}/${max()}层` : `展开到 ${floor() + 1}/${max()}层`}
                    </button>
                </div>
            </Show>
            <JsonNode v={props.data} depth={0} floor={floor} syntax={syntax()} />
        </div>
    );
}

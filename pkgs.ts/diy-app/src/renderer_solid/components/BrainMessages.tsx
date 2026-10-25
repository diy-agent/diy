// components/BrainMessages.tsx — 大脑页「发出去的消息（逐条审阅）」
//
// 为什么单独一个组件：本块要回答的问题与段账**不是同一把尺**：
//   · 段账（mind.ts）回答「字节是谁付的」（按可减性分组）；
//   · 本组件回答「模型实际看到的那几条消息，逐字长什么样」（逐条、可对照原文）。
// 两个视图共用同一份解析（`parseStepRequest`），区别只在渲染粒度。
//
// 三条硬要求（用户 2026-10-23）：
//   1. **逐条**：一条消息一张卡，各自可折 —— 别把 40 条糊成一整片 pre；
//   2. **可读**：信封是 YAML 文本，解析成树再看（长字符串再按 MD / YAML 二次猜，见 JsonTree）；
//      解析不了就按角色走 markdown / 等宽文本，**不硬撑**；
//   3. **`<>` 原文**：每张卡、以及整步消息，都有逐字原文入口 —— 读法有疑问时能一眼核对
//      「渲染出来的是不是发的那个」。
//
// 关于「经筛选、不含整个 request」：这里只呈现 `messages[]`，不含请求头 / 工具定义 / sampling 参数
// （与 `parseStepRequest` 的口径一致）。要完整请求体去流量页。
import { createMemo, createSignal, For, Show, type JSX } from "solid-js";
import { load as yamlLoad } from "js-yaml";
import { JsonTree } from "./JsonTree";
import { MarkdownView } from "./MarkdownView";
import type { StepMessage } from "../../shared/context/step-request";
import { utf8Bytes } from "../../shared/context/mind";

/** 角色配色（一份表，别在 JSX 里散着写） */
const ROLE_META: Record<string, { cls: string; label: string }> = {
    system: { cls: "badge-warning", label: "system" },
    user: { cls: "badge-primary", label: "user" },
    assistant: { cls: "badge-success", label: "assistant" },
    tool: { cls: "badge-neutral", label: "tool" },
};

interface YamlTry {
    ok: boolean;
    data?: unknown;
    /** 顶层键（结构视图的头一行提示用） */
    keys?: string[];
    error?: string;
}

/**
 * 试着把一条消息正文读成 YAML **映射**（信封就长这样）。
 *
 * 判据刻意保守：只认「看起来像映射」的（首字符是键名或 `{`），且解析结果必须是对象
 * —— 纯文本（含 markdown）解析成字符串/数组一律不当作结构，免得把用户的一句话
 * 渲染成一棵莫名其妙的树。解析失败**不吞**，把原因留给 UI 写明。
 */
function parseEnvelope(text: string): YamlTry {
    const t = text.trim();
    if (t === "") return { ok: false };
    if (!/^(?:\{|[A-Za-z_][\w.$-]*\s*:)/.test(t)) return { ok: false };
    try {
        const data = yamlLoad(t);
        if (data !== null && typeof data === "object" && !Array.isArray(data)) {
            return { ok: true, data, keys: Object.keys(data as Record<string, unknown>) };
        }
        return { ok: false };
    } catch (e) {
        return { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
}

function fmtBytes(n: number): string {
    if (!Number.isFinite(n) || n <= 0) return "0 B";
    if (n < 1024) return `${n} B`;
    if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
    return `${(n / 1024 / 1024).toFixed(2)} MB`;
}

/**
 * 剥 ANSI 转义（`\x1b[1m` 之类）。工具输出（vitest / npm / rg --color）自带颜色，
 * 折叠预览里原样显示就是一串 `\x1b[1m\x1b[30m`（实测第一眼全是噪声）；
 * 展开后的 `<>` 原文仍然逐字保留 —— 那是核对用，不是阅读用。
 */
// eslint-disable-next-line no-control-regex
const ANSI_RE = /\x1b\[[0-9;]*[A-Za-z]/g;

/** 首行预览（卡片折叠时的唯一信息，故要短） */
function firstLine(s: string, n = 90): string {
    const line = s.replace(ANSI_RE, "").split("\n").find((x) => x.trim() !== "") ?? "";
    return line.length > n ? `${line.slice(0, n)}…` : line;
}

/**
 * 折叠态的预览标题：**说人话**。
 *
 * 信封消息的首行是 `summary:` / `history:` / `runtime:` —— 那是结构，不是内容。
 * 用户 2026-10-23 点名：「user 消息未展开的预览 title 应该是用户的发言本身，提取出来」。
 * 于是顺序固定为：`user.message` → `user` 本体（字符串形态）→ 顶层键清单 → 首行原文。
 */
function previewOf(text: string, env: YamlTry): string {
    if (env.ok) {
        const o = env.data as Record<string, unknown>;
        const u = o.user;
        if (typeof u === "string") return firstLine(u, 120);
        if (u !== null && typeof u === "object") {
            const said = (u as Record<string, unknown>).message;
            if (typeof said === "string") return firstLine(said, 120);
        }
        const keys = env.keys ?? [];
        if (keys.length > 0) return keys.join(" · ");
    }
    return firstLine(text);
}

/** 一条消息的卡片：头（角色 / 量）+ 结构视图 + `<>` 原文 */
function MessageCard(props: { m: StepMessage; open: () => boolean; onToggle: () => void; floor: number }): JSX.Element {
    const [mode, setMode] = createSignal<"read" | "raw">("read");
    const env = createMemo(() => parseEnvelope(props.m.text));
    const meta = (): { cls: string; label: string } => ROLE_META[props.m.role] ?? { cls: "badge-ghost", label: props.m.role };
    return (
        <div class="rounded border border-base-300">
            <div class="flex w-full items-center gap-1 px-2 py-1 text-body">
                <button class="flex min-w-0 flex-1 items-center gap-1 text-left" onClick={props.onToggle}>
                    <span>{props.open() ? "▾" : "▸"}</span>
                    <span class="font-mono opacity-50 text-caption">#{props.m.index}</span>
                    <span class={`badge badge-xs ${meta().cls}`}>{meta().label}</span>
                    <Show when={env().ok}>
                        <span class="badge badge-xs badge-outline" title={`顶层键：${(env().keys ?? []).join(", ")}`}>
                            {"信封 "}
                            {(env().keys ?? []).length}
                        </span>
                    </Show>
                    <Show when={props.m.toolCalls.length > 0}>
                        <span class="badge badge-xs badge-ghost">{`tool-call ×${props.m.toolCalls.length}`}</span>
                    </Show>
                    <Show when={!props.open()}>
                        <span class="min-w-0 truncate opacity-60 text-caption">{previewOf(props.m.text, env())}</span>
                    </Show>
                </button>
                <span class="ml-auto shrink-0 font-mono text-caption opacity-50">
                    {`${fmtBytes(props.m.bytes)} · ≈${props.m.tokens} tok`}
                </span>
                <span class="join shrink-0">
                    <button
                        class={`btn btn-xs join-item ${mode() === "read" ? "btn-primary" : "btn-ghost"}`}
                        aria-pressed={mode() === "read"}
                        title="结构化 / 可读视图"
                        onClick={() => {
                            setMode("read");
                            if (!props.open()) props.onToggle();
                        }}
                    >
                        读
                    </button>
                    <button
                        class={`btn btn-xs join-item font-mono ${mode() === "raw" ? "btn-primary" : "btn-ghost"}`}
                        aria-pressed={mode() === "raw"}
                        title="逐字原文（就是真发出去的那段文本，不经任何解析）"
                        onClick={() => {
                            setMode("raw");
                            if (!props.open()) props.onToggle();
                        }}
                    >
                        {"<>"}
                    </button>
                </span>
            </div>
            <Show when={props.open()}>
                <div class="border-t border-base-300 bg-base-100 px-2 py-1">
                    <Show when={mode() === "raw"}>
                        <pre class="max-h-[60vh] overflow-auto whitespace-pre-wrap break-all font-mono text-caption leading-relaxed">{props.m.text}</pre>
                    </Show>
                    <Show when={mode() === "read"}>
                        <Show
                            when={env().ok}
                            fallback={
                                <Show
                                    when={props.m.role === "assistant"}
                                    fallback={
                                        <pre class="max-h-[60vh] overflow-auto whitespace-pre-wrap break-all font-mono text-caption leading-relaxed">
                                            {props.m.text}
                                        </pre>
                                    }
                                >
                                    <div class="max-h-[60vh] overflow-auto">
                                        <MarkdownView content={props.m.text} class="text-body" />
                                    </div>
                                </Show>
                            }
                        >
                            {/* 结构视图：YAML → 树，**用 yaml 语法渲**（信封本来就是 YAML，键裸写、无括号，
                                与原文对不上括号但读得快；要与线上字节核对时切 `<>`）。
                                长字符串（AGENTS.md 正文 / 事实值 / 嵌套信封）在叶子上会自动猜成 YAML/MD 展开
                                —— 那一层层级化由 JsonTree 负责（见其 guessFmt）。 */}
                            <JsonTree data={env().data} syntax="yaml" floor={props.floor} />
                        </Show>
                        <Show when={env().error && !env().ok}>
                            <div class="text-caption text-warning">{`不是合法 YAML（按原文显示）：${env().error ?? ""}`}</div>
                        </Show>
                    </Show>
                </div>
            </Show>
        </div>
    );
}

/**
 * 整步视图：消息列表 + 合计 + 整步 `<>`。
 *
 * 折展状态放组件内（`open` 的 Set）：消息列表每一步都不一样，跨步记忆折叠态没有意义
 * （按 index 记住会让新一步显示成上一步的折叠形态，反而误导）。
 */
/** 展开层级上限：1 层 = 卡片全展开，其上每层深入树一层。8 层之后该切 `<>` 原文了 */
const MAX_LEVEL = 8;

export function BrainMessages(props: { messages: readonly StepMessage[]; raw: string | null; note: string }): JSX.Element {
    /**
     * 展开层级（**一个总闸**）：0 = 全收起；L≥1 = 卡片全展开 + 树展开到 L 层。
     *
     * 为什么合并：原先有「全部展开/收起」（卡片）× 「展开到 n 层」（树）两个按钮 ——
     * 用户口径「这是同一件事的两个层级，不是两件事」。保留其一即可，故合成一把梯子：
     * 点一次 0→1→…→8→0，卡片开合是第 1 级，再往上只加深树。
     */
    const [level, setLevel] = createSignal(0);
    /** 单卡反选：点卡头可单独翻某张卡（在总闸基础上取反，不动总闸） */
    const [flipped, setFlipped] = createSignal<Set<number>>(new Set());
    const [rawOpen, setRawOpen] = createSignal(false);
    const isOpen = (i: number): boolean => (level() >= 1) !== flipped().has(i);
    const toggle = (i: number): void => {
        const next = new Set(flipped());
        if (next.has(i)) next.delete(i);
        else next.add(i);
        setFlipped(next);
    };
    const step = (): void => {
        setLevel((l) => (l >= MAX_LEVEL ? 0 : l + 1));
    };
    const totals = (): { bytes: number; tokens: number } => ({
        bytes: props.messages.reduce((n, m) => n + (m.bytes || utf8Bytes(m.text)), 0),
        tokens: props.messages.reduce((n, m) => n + m.tokens, 0),
    });
    return (
        <div class="flex flex-col gap-1 p-1">
            <div class="flex flex-wrap items-center gap-1 text-caption">
                <span class="badge badge-xs badge-ghost">{`${props.messages.length} 条消息`}</span>
                <span class="opacity-60 font-mono">{`合计 ${fmtBytes(totals().bytes)} · ≈${totals().tokens} tok`}</span>
                <div class="flex-1" />
                <button
                    class="btn btn-xs btn-ghost"
                    onClick={step}
                    title={`展开层级：0 = 全收起；1 = 卡片全展开（只见顶层键）；再点逐层展开树，${MAX_LEVEL} 层之后回到 0。单张卡点卡头可单独开关。`}
                >
                    {`展开 ${level()}/${MAX_LEVEL} 层`}
                </button>
                <button
                    class={`btn btn-xs font-mono ${rawOpen() ? "btn-primary" : "btn-ghost"}`}
                    aria-pressed={rawOpen()}
                    title="整步 messages[] 的逐字原文（美化 JSON；不含请求头 / 工具定义）"
                    onClick={() => setRawOpen((v) => !v)}
                >
                    {"<> 整步"}
                </button>
            </div>
            <Show when={rawOpen()}>
                <pre class="max-h-[50vh] overflow-auto whitespace-pre-wrap break-all rounded bg-base-100 p-1 font-mono text-caption leading-relaxed">
                    {props.raw ?? "（这条记录没有可用的请求正文）"}
                </pre>
            </Show>
            <Show when={props.note}>
                <div class="rounded border border-warning/40 bg-warning/10 px-2 py-1 text-caption">{props.note}</div>
            </Show>
            <For each={props.messages}>
                {(m) => (
                    <MessageCard
                        m={m}
                        open={() => isOpen(m.index)}
                        onToggle={() => toggle(m.index)}
                        floor={Math.max(1, level())}
                    />
                )}
            </For>
        </div>
    );
}

// src/shared/context/compact-when.ts
// 🎯 「**什么时候会压**」的文案真源（##423 块 2）：把配置里的触发器 + 当前阈值 + 实测用量
//    拧成几句人能读懂的话。组件只管排版，**句子与数字都从这里出**（可单测钉住）。
//
// ── 病根（用户 2026-10-25）──
// 「我觉得我们缺少对什么时候会压缩…的 ui 呈现，我已经完全被搞懵了。」
// 界面上只有「上限 xx KB」，没写**谁在何时把它推下去**：三条触发器、开着没开、阈值多少、
// 现在离阈值还差多远 —— 全靠自己读 yaml。
//
// ── 口径（别在 UI 里另起一套）──
// 判据真源 `shared/context/auto-compact.ts`：三个触发器都是**确定事实**，不是划算不划算的预测：
//   · systemContextChanged —— system 容器变了 ⇒ 前缀缓存必作废，此刻压零代价
//   · cacheExpired         —— 距上次请求 > 生效 TTL（实测优先，见 cache-ttl.ts）
//   · contextWindowOver    —— 该会话最后一步实测 total ≥ 阈值（**撞墙前**就压，不是事后重试；
//                            没有「溢出后收紧重试」这条机制，界面不许编）
// 加一条人工触发：面板上的「压缩」按钮（= 手动，不属于三触发器）。
//
// 纯函数：禁止 import node:*（渲染层直接用）。

import { fmtBudgetBytes } from "./delivery-badge";

export type CompactWhenMode = "off" | "notify" | "auto";

export interface CompactWhenInput {
    mode: CompactWhenMode;
    triggers: { systemContextChanged: boolean; cacheExpired: boolean; contextWindowOver: number };
    /** 生效 TTL（毫秒，实测优先）；`null` = 无实测也无先验 → 不写时长 */
    ttlMs: number | null;
    /** 压缩上限（字节）：这就是「一条上限」—— 排版用 */
    budgetBytes: number;
    /** 该会话最后一步实测 token（输入 + 输出）；`null` = 没有实测 */
    lastStepTokens: number | null;
    /** 模型窗口上限（token）；`null` = 未知 */
    windowLimit: number | null;
}

export interface CompactWhenRow {
    /** `systemContextChanged` / `cacheExpired` / `contextWindowOver` / `manual` */
    key: "systemContextChanged" | "cacheExpired" | "contextWindowOver" | "manual";
    /** 人读名 */
    label: string;
    /** `on` 开 / `off` 关 / `manual` 人工 */
    state: "on" | "off" | "manual";
    /** 一句话：**判据 + 当前实际值** */
    text: string;
    /** hover 补充解释（判据为什么成立；鼠标悬停即见） */
    hint: string;
}

/** 毫秒 → 人读（1 位小数，>1 小时走小时） */
export function fmtTtl(ms: number | null): string {
    if (ms == null) return "无实测时长";
    if (ms >= 3_600_000) return `${(ms / 3_600_000).toFixed(1)} 小时`;
    if (ms >= 60_000) return `${Math.round(ms / 60_000)} 分钟`;
    return `${Math.round(ms / 1000)} 秒`;
}

/** 窗口占用占比（百分数，1 位小数）；量不到 → null（不写 0） */
export function windowRatio(lastStepTokens: number | null, windowLimit: number | null): number | null {
    if (lastStepTokens == null || windowLimit == null || windowLimit <= 0) return null;
    return Math.round((lastStepTokens / windowLimit) * 1000) / 10;
}

/**
 * 三触发器 + 手动，逐条给「开着没开 + 判据 + 当前值」。
 *
 * 注意 `state` 与 `mode` 是**两件事**：`mode=off` 时触发器全都不跑（哪怕 `triggers.* = true`），
 * 所以 off 模式下每条都强制 `state: "off"` 并在 text 里说清「全局 off，三个都不跑」。
 */
export function compactWhenRows(i: CompactWhenInput): CompactWhenRow[] {
    const running = i.mode !== "off";
    const st = (on: boolean): "on" | "off" => (running && on ? "on" : "off");
    const ratio = windowRatio(i.lastStepTokens, i.windowLimit);
    const measured =
        i.lastStepTokens == null
            ? "本会话还没有实测用量"
            : `本会话最后一步 ${i.lastStepTokens} tok` +
              (ratio == null ? "" : `（占窗口 ${ratio}%）`);
    const winOff = i.triggers.contextWindowOver === 0;
    return [
        {
            key: "systemContextChanged",
            label: "系统上下文变",
            state: st(i.triggers.systemContextChanged),
            text: i.triggers.systemContextChanged
                ? running
                    ? "开 · system 容器一改就压（前缀缓存此刻必作废，压了白赚）"
                    : "开 · 但全局 mode=off，不跑"
                : "关",
            hint:
                "判据：每轮开头的 system 容器（提示词 / 工具表）与上一步不同 ⇒ 前缀缓存必然失效。" +
                "既然整段都要按全价重读，此刻压缩没有额外重建代价。不是「划不划算」的估算，是确定事实。",
        },
        {
            key: "cacheExpired",
            label: "缓存过期",
            state: st(i.triggers.cacheExpired),
            text: i.triggers.cacheExpired
                ? running
                    ? `开 · 距上次请求 > ${fmtTtl(i.ttlMs)} 就压`
                    : "开 · 但全局 mode=off，不跑"
                : "关",
            hint:
                "判据：距**上一次真实请求**的间隔 > 生效 TTL ⇒ 上游前缀缓存已过期，下一步本来就要全价读。" +
                "TTL 取实测优先（无实测才用先验），所以这里显示的就是**当下生效值**。",
        },
        {
            key: "contextWindowOver",
            label: "窗口超限",
            state: winOff ? "off" : st(true),
            text: winOff
                ? "关（阈值 0）"
                : `开 · 最后一步 ≥ ${i.triggers.contextWindowOver} tok 就压 · 现在 ${measured}`,
            hint:
                "判据：该会话最后一步的实测 total（输入 + 输出）≥ 阈值。" +
                "这是**硬约束**（再涨就撞墙），在发请求**之前**拦，不是请求失败后收紧重试 —— 全仓没有「溢出重试」这条路径，别在界面上编它。" +
                "阈值该设得比模型窗口小一截：窗口上限 " +
                (i.windowLimit == null ? "未知" : `${i.windowLimit} tok`) +
                "，撞满前留出输出空间。",
        },
        {
            key: "manual",
            label: "手动",
            state: "manual",
            text: "随时可用：面板右上「压缩」按钮（压完历史保留、可撤销）",
            hint: "人工触发，不受上面三个开关影响；mode=off 时这是**唯一**的压缩途径。",
        },
    ];
}

/** 一句话总结（徽章 / 表格里放不下四行时用） */
export function compactWhenSummary(i: CompactWhenInput): string {
    if (i.mode === "off") return "自动压缩：off（只有手动能压）";
    const on = compactWhenRows(i)
        .filter((r) => r.state === "on")
        .map((r) => r.label);
    const mode = i.mode === "auto" ? "检测到即压" : "检测到只提示";
    return `自动压缩：${mode} · 触发 ${on.length ? on.join(" / ") : "无（三个都关了，只剩手动）"}`;
}

/**
 * 「压成什么样」的一句话：上限 + 超出后的动作。
 * `modeData.budgetBytes` 是**唯一**的上限；它约束的是「按顺序挑历史」那部分的**值字节**。
 */
export function compactResultSentence(budgetBytes: number): string {
    if (budgetBytes === 0) return "上限 0（= 清零）：历史一条都不留，只剩每轮现建的 system / 工具表";
    return `上限 ${fmtBudgetBytes(budgetBytes)}：超出就按管道顺序挑，挑到装不下为止（挑剩下的不进本次请求）`;
}

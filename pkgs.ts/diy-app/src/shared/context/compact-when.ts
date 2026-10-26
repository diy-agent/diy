// src/shared/context/compact-when.ts
// 🎯 「**什么时候会压**」的文案真源（##423 块 2）——
//    ##432 刀 2 之后压缩变成了**事件制**，这里的判据必须跟着换：不再讲「三触发器 × 字节预算」。
//
// ── 现行判据（真源 `main/services/local-agent.ts::appliedHistoryRange`，别在 UI 另起一套）──
//   ① **第一次压**：还没有落盘边界 且 全量估算 > `history.limit.limitTokens`
//      ⇒ 发请求前用 `selectCompactableRange` **算一次**切点，写一条压缩事件（turns.jsonl 的 compaction entry）。
//   ② **之后再压**：已有边界，只有当**保留段自己**（保头 + 保留尾段，被丢掉那段不算）重新涨过上限时，
//      才再算一次并写新事件。「全量」在这条判据里是错的 —— 被丢的段永远算在内，那样会每步都"超限"。
//   ③ **每步投递**：按**已落盘边界**切，**不重算**（新增长只是追加到尾部，切点不动）。
//   ④ **手动**：「压缩」按钮随时可用，按当前上限立刻重算一次。
//
// 三触发器（systemContextChanged / cacheExpired / contextWindowOver）**仍然存在**，但
// ##442 起删了 off/notify/auto 三态：**到点就压**，只另写一条 `compact.jsonl` **审计记录**
// （##431 起降级为审计日志）—— **不改变投递切点**。界面上必须把这两件事分开说。
//
// 纯函数：禁止 import node:*（渲染层直接用）。

/** 已落盘的压缩边界（turns.jsonl 的 compaction entry，只取展示需要的三项） */
export interface CompactWhenBoundary {
    /** ISO 时间 */
    at: string;
    /** 那一次丢掉的条数 */
    dropped: number;
    /** 那一次生效的上限（token）—— 与当前上限不同就说明「压完之后改过上限」 */
    limitTokens: number;
}

export interface CompactWhenInput {
    /** 唯一旋钮：历史 token 上限 */
    limitTokens: number;
    /** 已落盘边界；null = 从没压过（投递 = 全量） */
    boundary: CompactWhenBoundary | null;
    /** 上次真发时投递出去的那段历史 ≈ token（最后一步轮首的投递快照）；null = 没记录 */
    retainedTokens: number | null;
    /** 该会话最后一步实测 token（输入 + 输出）；null = 没有实测 */
    lastStepTokens: number | null;
    /** 模型窗口上限（token）；null = 未知 */
    windowLimit: number | null;
}

export interface CompactWhenRow {
    /** `first` 首次 / `retained` 保留段再顶过上限 / `reuse` 每步按边界切 / `manual` 人工 */
    key: "first" | "retained" | "reuse" | "manual";
    /** 人读名 */
    label: string;
    /** `on` 现在满足 / `off` 现在用不上 / `manual` 人工 */
    state: "on" | "off" | "manual";
    /** 一句话：**判据 + 当前实际值** */
    text: string;
    /** hover 补充解释（判据为什么长这样；鼠标悬停即见） */
    hint: string;
}

/** 毫秒 → 人读（1 位小数，>1 小时走小时） */
export function fmtTtl(ms: number | null): string {
    if (ms == null) return "无实测时长";
    if (ms >= 3_600_000) return `${(ms / 3_600_000).toFixed(1)} 小时`;
    if (ms >= 60_000) return `${Math.round(ms / 60_000)} 分钟`;
    return `${Math.round(ms / 1000)} 秒`;
}

/** token 人读：千位分隔 + 单位（与 `history.limit.limitTokens` 同一个数域） */
export function fmtTokens(n: number): string {
    return `${Math.round(n).toLocaleString()} tok`;
}

/** 窗口占用占比（百分数，1 位小数）；量不到 → null（不写 0） */
export function windowRatio(lastStepTokens: number | null, windowLimit: number | null): number | null {
    if (lastStepTokens == null || windowLimit == null || windowLimit <= 0) return null;
    return Math.round((lastStepTokens / windowLimit) * 1000) / 10;
}

/** ISO → `MM-DD HH:mm`（只给刻度，不编时区） */
export function fmtStamp(iso: string): string {
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return iso;
    const p = (n: number) => String(n).padStart(2, "0");
    return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

/**
 * 四行：**首次** / **保留段再顶过上限** / **每步按边界切** / **手动**，逐条给「现在满不满足 + 当前值」。
 *
 * 顺序 = 判据的时间顺序（先有第一次，才有之后的复用与再压），不是紧急度。
 */
export function compactWhenRows(i: CompactWhenInput): CompactWhenRow[] {
    const limit = i.limitTokens;
    const b = i.boundary;
    const retained = i.retainedTokens;
    const gap = retained == null ? null : limit - retained;

    const firstText = b
        ? `已有边界（${fmtStamp(b.at)} 写的，丢 ${b.dropped} 条）⇒ 这条路只在「从没压过」时走`
        : `还没有边界：全量估算一旦超 ${fmtTokens(limit)}，下一步**发请求之前**算一次切点并写压缩事件`;

    const retainedText = !b
        ? "还没有边界（先等第一次压）"
        : retained == null
          ? `上限 ${fmtTokens(limit)} · 保留段还没有实测（等下一次真发记进账本）`
          : gap! <= 0
            ? `保留段 ${fmtTokens(retained)} 已顶过上限 ${fmtTokens(limit)} ⇒ 下一步就再压一次`
            : `保留段 ${fmtTokens(retained)} / 上限 ${fmtTokens(limit)} ⇒ 再涨 ${fmtTokens(gap!)} 才会再压一次`;

    return [
        {
            key: "first",
            label: "第一次压",
            state: b ? "off" : "on",
            text: firstText,
            hint:
                "判据：没有落盘边界、且全量估算 > 上限 ⇒ 发请求前算一次切点（`selectCompactableRange`），" +
                "写一条压缩事件。算一次就够：之后的每一步都不再重算。",
        },
        {
            key: "retained",
            label: "保留段再顶过上限",
            state: b ? "on" : "off",
            text: retainedText,
            hint:
                "判据：**只看保留段**（保头 + 尾部保留段）自己的 token，不把被丢掉那段算进来 ——" +
                "拿全量判会每步都「超限」，那就退回成每步重算的老毛病了。" +
                "一次压缩只保留到上限的一半，余下额度留给后续新增，所以正常是「涨一阵才再压一次」。",
        },
        {
            key: "reuse",
            label: "每步投递",
            state: "on",
            text: "按**已落盘边界**切：切点固定，新增长只追加到尾部，每步不重算",
            hint:
                "投递与压缩是两件事：投递每步都发生（按当前边界切），压缩只在事件时发生（改边界）。" +
                "所以「这一步压过没有」要问边界最后一次是什么时候写的，而不是问这一步有没有触发条件。",
        },
        {
            key: "manual",
            label: "手动",
            state: "manual",
            text: "随时可用：面板右上「压缩」按钮 / `diy agent local compact run`（历史保留、可撤销）",
            hint: "人工触发，不看是否已经到点 —— 立刻按当前上限重算一次边界。",
        },
    ];
}

/**
 * 自动压缩与投递的关系 —— **一句话划清**（##442 删 mode 后：到点就压）。
 * ##431 起 `compact.jsonl` 是纯审计日志，三触发器不再决定投递切点。
 */
export function autoCompactSentence(): string {
    return (
        "自动压缩：**到点就压**（窗口占比 / 系统上下文变 / 缓存过期），另记一条审计（`compact.jsonl`），" +
        "**不改投递切点** —— 投递只认上面那个已落盘的边界。"
    );
}

/** 一句话总结（徽章 / 表格里放不下四行时用） */
export function compactWhenSummary(i: CompactWhenInput): string {
    const where = i.boundary ? `已压过（${fmtStamp(i.boundary.at)}，丢 ${i.boundary.dropped} 条）` : "还没压过";
    return `历史 ${where} · 上限 ${fmtTokens(i.limitTokens)}`;
}

/**
 * 「压成什么样」的一句话：上限 + 超出后的动作。
 * `history.limit.limitTokens` 是**唯一**的上限（token）：从最后一步往前累加，装不下就停；
 * 保头 600 token 硬编码、切点 tool 配对平衡、一次压缩保留到上限的一半，边界只在压缩事件时算一次。
 */
export function compactResultSentence(limitTokens: number): string {
    return (
        `上限 ${fmtTokens(limitTokens)}：从最后一步往前累加，装得下就装、装不下就停，一次只保留到上限的一半` +
        "（保头 600 tok 硬编码永不丢；切点必须 tool 配对平衡）；边界**只在压缩事件时算一次**，之后每步只按它切"
    );
}

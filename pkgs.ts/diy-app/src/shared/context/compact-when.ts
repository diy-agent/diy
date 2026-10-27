// src/shared/context/compact-when.ts
// 🎯 「**什么时候会压**」的文案真源（##423 块 2）——
//    ##432 刀 2 之后压缩变成了**事件制**，这里的判据必须跟着换：不再讲「三触发器 × 字节预算」。
//
// ── 现行判据（真源 `main/services/local-agent.ts::appliedHistoryRange`，别在 UI 另起一套）──
//   ① **第一次压**：还没有落盘边界 且 全量估算 > 保留量（窗口 × `history.limit.retainRatio`）
//      ⇒ 发请求前用 `selectCompactableRange` **算一次**切点，写一条压缩事件（turns.jsonl 的 compaction entry）。
//   ② **之后再压**：已有边界，只有当**保留段自己**（保头 + 保留尾段，被丢掉那段不算）重新涨过上限时，
//      才再算一次并写新事件。「全量」在这条判据里是错的 —— 被丢的段永远算在内，那样会每步都"超限"。
//   ④ **切点规则**（##442，向 dsh 看齐）：从尾往前装够保留量，切点往前挪到最近的 user 消息
//      （配对靠结构保证），压完仍超触发线 ⇒ 不压；无保头、无事后配平、无绝对 token 上限。
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
    /** 那一次生效的保留量（token = 当时窗口 × retainRatio）—— 与当前算出的不同就是「窗口/比例变了」 */
    retainTokens: number;
    /** 那次压缩时的模型窗口上限（token；0 = 当时取不到） */
    windowTokens: number;
}

export interface CompactWhenInput {
    /** 唯一旋钮：保留比例（窗口 × 本值 = 保留量，压缩后留这么多） */
    retainRatio: number;
    /** 触发比例（`triggers.windowOverRatio`，窗口 × 本值 = 触发线，涨到这么高才再压） */
    windowOverRatio: number;
    /** 模型窗口上限（token）；null = 未知 */
    windowLimit: number | null;
    /** 已落盘边界；null = 从没压过（投递 = 全量） */
    boundary: CompactWhenBoundary | null;
    /** 上次真发时投递出去的那段历史 ≈ token（最后一步轮首的投递快照）；null = 没记录 */
    retainedTokens: number | null;
    /** 该会话最后一步实测 token（输入 + 输出）；null = 没有实测 */
    lastStepTokens: number | null;
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

/** token 人读：千位分隔 + 单位（与 `history.limit.retainRatio × 窗口` 同一个数域） */
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
    // 两个数别混：*保留量* = 压缩后留多少（窗口 × retainRatio）；
    // *触发线* = 涨到多少才再压（窗口 × windowOverRatio）。再压判据用的是**触发线**
    // —— 拿保留量当阈值会让"压完刚好≈保留量 ⇒ 下一步涨 1 token 就又超"（##442 单测实测）。
    const limit = i.windowLimit == null ? null : Math.floor(i.windowLimit * i.retainRatio);
    const trigger = i.windowLimit == null ? null : Math.floor(i.windowLimit * i.windowOverRatio);
    const b = i.boundary;
    const retained = i.retainedTokens;
    const gap = retained == null || trigger == null ? null : trigger - retained;

    const firstText = b
        ? `已有边界（${fmtStamp(b.at)} 写的，丢 ${b.dropped} 条）⇒ 这条路只在「从没压过」时走`
        : limit == null
          ? "模型窗口上限未知 ⇒ **不压**（不猜数）；确定模型后才会开始"
          : `还没有边界：全量估算一旦超**触发线** ${fmtTokens(trigger!)}（窗口 ${fmtTokens(i.windowLimit!)} × ${i.windowOverRatio}），下一步**发请求之前**算一次切点（保留 ${fmtTokens(limit)} = 窗口 × ${i.retainRatio}）并写压缩事件`;

    const retainedText = !b
        ? "还没有边界（先等第一次压）"
        : limit == null
          ? "窗口上限未知 ⇒ 不压"
          : retained == null
          ? `保留 ${fmtTokens(limit)} · 保留段还没有实测（等下一次真发记进账本）`
          : gap! <= 0
            ? `保留段 ${fmtTokens(retained)} 已顶过触发线 ${fmtTokens(trigger!)} ⇒ 下一步就再压一次`
            : `保留段 ${fmtTokens(retained)} / 触发线 ${fmtTokens(trigger!)} ⇒ 再涨 ${fmtTokens(gap!)} 才会再压一次`;

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
    const keep =
        i.windowLimit == null
            ? `${i.retainRatio} × 窗口（窗口未知）`
            : `${fmtTokens(Math.floor(i.windowLimit * i.retainRatio))}（触发 ${fmtTokens(Math.floor(i.windowLimit * i.windowOverRatio))}）`;
    return `历史 ${where} · 保留 ${keep}`;
}

/**
 * 「压成什么样」的一句话：保留量 + 动作（##442 向 dsh 看齐后的全部规则）。
 */
export function compactResultSentence(retainRatio: number): string {
    const pct = Math.round(retainRatio * 1000) / 10;
    return (
        `保留窗口的 ${pct}%（缺省 16%，128k→20k / 1M→160k）：从最后一条往前累加，装够就停，` +
        "切点往前挪到最近的 user 消息（tool 的 call/result 因此永不拆开）；压完仍超触发线 ⇒ 不压；" +
        "边界**只在压缩事件时算一次**，之后每步只按它切"
    );
}

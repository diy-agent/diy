/**
 * notice.ts — 「用户可见提示」的**信息契约**（##391）。
 *
 * 用户原话（2026-10-20，起点是一条没来由的绿色 toast「会话实时更新已恢复」）：
 * 「所有用户可见的提示都需要有来源 / 原因 / 详情等，需提供详情按钮展开 2 级信息，
 *   不然我也不知道 app 在干啥，提示这个是啥意思，详情里需要介绍机制。」
 *
 * 于是把「一条提示该说什么」固化成**三个必填字段**，而不是散落在各调用点的文案：
 *   · `source` —— **谁**发的（机制名 + 代码位置）：出问题时人和 agent 都能顺着它找到代码
 *   · `reason` —— **为什么此刻**发（带具体数值 / 时刻）：没有数字的提示 = 形容词，无法复盘
 *   · `detail` —— **机制**说明（多行）：在监测什么 / 何时会有这条 / 怎么消 / 对用户意味着什么
 *
 * 护栏：`assertNoticeMeta` 对空值**抛错**（不是 console.warn）—— 提示是编程产物，
 * 少一个字段就是调用点写错了，静默降级等于让债务悄悄长回来（`tests/core/notice-contract.test.ts`
 * 用空 source / reason / detail 三条用例钉住）。
 *
 * 纯函数 + 零依赖：store / 组件 / 单测（node 环境）共用同一份实现。
 */

/** 提示的二级信息（##391 R1）：详情面板的三段，也就是「谁发的 / 为什么现在发 / 怎么消」 */
export interface NoticeMeta {
    /** 谁发的：机制名 + 代码位置（如 `会话实时更新 · opsWatch（localChatStore.ts）`） */
    source: string;
    /** 为什么此刻发：**带具体数值 / 时刻**（如「订阅中断 14s（12:31:05 → 12:31:19）后恢复」） */
    reason: string;
    /** 机制说明：多行，一行一件事（在监测什么 / 何时会有这条 / 怎么消 / 对用户意味着什么） */
    detail: string;
}

/** 三个必填字段（校验顺序即报错顺序，也是详情面板的展示顺序） */
export const NOTICE_FIELDS = ["source", "reason", "detail"] as const;

/** 字段中文名（详情面板 / 复制文本 / 报错都用它，避免各处各写一套） */
export const NOTICE_FIELD_LABEL: Record<(typeof NOTICE_FIELDS)[number], string> = {
    source: "来源",
    reason: "原因",
    detail: "机制",
};

/**
 * 校验并规整二级信息。**空 / 纯空白即抛错**（##391 验收 2 的反例护栏）。
 *
 * 为什么抛错而不是补默认值：默认值会让「没填」看起来像「填了」——
 * 用户照样得到一条说不出所以然的提示，而这正是本任务要根治的病。
 */
export function assertNoticeMeta(meta: Partial<NoticeMeta> | null | undefined): NoticeMeta {
    const out = { source: "", reason: "", detail: "" };
    for (const f of NOTICE_FIELDS) {
        const v = String(meta?.[f] ?? "").trim();
        if (!v) {
            throw new Error(
                `[notice] 提示缺 ${f}（${NOTICE_FIELD_LABEL[f]}）：` +
                    `用户可见提示必须能回答「谁发的 / 为什么现在发 / 怎么消」—— 见 rule.ui-notice（##391）`,
            );
        }
        out[f] = v;
    }
    return out;
}

/** 本地时刻 `HH:MM:SS`（提示里的「时刻」一律用它，用户对表看日志时不必再做时区换算） */
export function formatClock(ts: number): string {
    const d = new Date(ts);
    const p = (n: number) => String(n).padStart(2, "0");
    return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

/**
 * 人读时长（`14s` / `1m03s` / `820ms`）。
 * 规则：≥10s 取整秒（「14s」比「14.3s」好读），<10s 留一位小数（「1.2s」区分得开）。
 */
export function formatDuration(ms: number): string {
    if (!Number.isFinite(ms) || ms <= 0) return "0ms";
    if (ms < 1000) return `${Math.round(ms)}ms`;
    const s = ms / 1000;
    if (s < 10) return `${s.toFixed(1)}s`;
    if (s < 60) return `${Math.round(s)}s`;
    const m = Math.floor(s / 60);
    const rest = Math.round(s - m * 60);
    return `${m}m${String(rest).padStart(2, "0")}s`;
}

/**
 * 复制到剪贴板的纯文本（**三段齐全**，#391 R2「面板内容可复制，便于反馈」）。
 * 格式固定成「来源 / 原因 / 机制」三行起：贴进对话里，agent 一眼就知道该去看哪段代码。
 */
export function noticeCopyText(meta: NoticeMeta, extra?: { message?: string; when?: number }): string {
    const head = extra?.message ? [`提示：${extra.message}`] : [];
    const at = extra?.when ? [`时刻：${formatClock(extra.when)}`] : [];
    return [
        ...head,
        ...at,
        `${NOTICE_FIELD_LABEL.source}：${meta.source}`,
        `${NOTICE_FIELD_LABEL.reason}：${meta.reason}`,
        `${NOTICE_FIELD_LABEL.detail}：`,
        meta.detail,
    ].join("\n");
}

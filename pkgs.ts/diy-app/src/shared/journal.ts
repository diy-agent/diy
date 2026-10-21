/**
 * shared/journal.ts — 任务日志（journal）RPC 契约（##404）
 *
 * 为什么需要它：任务 body 混了三样东西 —— **现在要做什么**（正文 / 台账）、
 * **现在是什么**（事实）、**发生过什么**（一次次的处理记录 / review / 踩坑）。
 * 第三类**只增不减**，是 body 膨胀的主因（实测 342 个任务 body 合计 4.25 MB、最大
 * 349 KB，其中绝大部分是日志）。
 *
 * 三分法的判据（写在这里，防止再混回去）：
 *   · 能改写成「现在是什么」且可校验、带证据 → **fact**（`@diy/facts`）
 *   · 能改写成「我某时刻做了什么 / 踩了什么 / 否掉了什么」 → **journal**（本契约）
 *   · 能改写成「接下来要做什么」 → **任务 body**
 *
 * journal 是 **append-only 事件流**：不改、不删、不做语义校验。它的价值是「事后可查」，
 * 不是「每轮都读」 —— 这正是它能把 body 摘小的原因。它**不替代 git log**：git 记的是
 * 代码怎么变，journal 记的是当时为什么这么定、踩过什么、什么被否掉了。
 */
import { z } from 'zod';

/**
 * 五种 kind，每种只回答一个问题（写错 kind = 以后查不到）：
 *   decision 定了什么方案 / 否掉了什么（含理由）
 *   pitfall  踩了什么坑（现象 → 根因 → 怎么绕）
 *   review   验收 / 检查结论（**含"哪些没验"**）
 *   progress 里程碑落地（通常带 commit）
 *   learn    查证到的新认识（不是决策，是发现）
 */
export const JOURNAL_KINDS = ['decision', 'pitfall', 'review', 'progress', 'learn'] as const;
export const JournalKindSchema = z.enum(JOURNAL_KINDS);
export type JournalKind = z.infer<typeof JournalKindSchema>;

/** 一行一条（jsonl）的条目；`ts` 由服务端生成（不信任调用方时钟） */
export const JournalEntrySchema = z.object({
    ts: z.string(),
    kind: JournalKindSchema,
    /** 一行标题：**必填** —— 强制浓缩，"标题写不出 = 这条不该记" */
    title: z.string(),
    /** 可选正文（markdown）。能一句话说完就别写 */
    body: z.string().optional(),
    /** 引用：commit sha / 任务 uri / 事实 gid / `<路径>:<行>` */
    refs: z.array(z.string()).optional(),
    /** 归属任务（`projects/<pid>/tasks/<tid>`；**必填，不做"当前任务"推导**） */
    task: z.string(),
    /** 产生它的会话轮次（可选，便于对照 llm.jsonl） */
    round: z.string().optional(),
});
export type JournalEntry = z.infer<typeof JournalEntrySchema>;

/** 落盘后回显：seq = 该任务内的行号（1-based，稳定且可引用 `#12`） */
export const JournalRowSchema = JournalEntrySchema.extend({ seq: z.number() });
export type JournalRow = z.infer<typeof JournalRowSchema>;

export const JournalAddSchema = z.object({
    task: z.string(),
    /** 本次新增（按 seq 升序） */
    added: z.array(JournalRowSchema),
    /** 追加后该任务的总条数 */
    total: z.number(),
});

export const JournalProblemSchema = z.object({
    seq: z.number(),
    detail: z.string(),
});
export type JournalProblem = z.infer<typeof JournalProblemSchema>;

export const JournalFindSchema = z.object({
    task: z.string(),
    /** 文件总条数（含未匹配） */
    total: z.number(),
    matched: z.number(),
    rows: z.array(JournalRowSchema),
    /** 已渲染好的 markdown（CLI 直接打印，`--json` 时忽略） */
    text: z.string(),
    /** 坏行（半截写入 / 手改坏）—— 跳过而不是整份失败，否则一条坏行毁掉全部历史 */
    problems: z.array(JournalProblemSchema),
});

export const JournalStatsSchema = z.object({
    task: z.string(),
    total: z.number(),
    bytes: z.number(),
    byKind: z.record(JournalKindSchema, z.number()),
    /** 最早 / 最新条目的时间（空库为 null） */
    first: z.string().nullable(),
    last: z.string().nullable(),
    problems: z.array(JournalProblemSchema),
});

/** 批量导入的载荷：JSON 数组（`--file` 指向的整份文件）；`ts` 可自带（回灌历史） */
export const JournalImportItemSchema = JournalEntrySchema.omit({ task: true }).partial({ ts: true });
export const JournalImportSchema = z.object({
    task: z.string(),
    dryRun: z.boolean(),
    accepted: z.number(),
    rejected: z.number(),
    errors: z.array(z.object({ index: z.number(), detail: z.string() })),
});

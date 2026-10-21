/**
 * shared/facts.ts — 事实库 RPC 契约（##404）
 *
 * 为什么这里有 zod 而内核没有：内核（`@diy/facts`）是纯 TS 类型 + 纯函数，**不认识 zod**
 * （它要被 CLI 之外的消费者复用）；RPC 边界才需要"从任意输入解析出形状"。
 *
 * 形状漂移的护栏：文件末尾那条 `_SchemaMatchesKernel` 编译期断言 —— schema 与内核 `Fact`
 * 一旦不同步，`tsc` 先红，而不是等某次 `diy facts submit` 在运行时丢字段。
 *
 * 校验的两层分工（别混）：
 *   1. zod（这里）—— **形状**：字段名 / 类型 / 未知字段
 *   2. 内核 `validateFacts` —— **语义**：subject 不许含 `#`、probe 档必须有命令、scope 三轴合法
 * 走 RPC 时两层都跑：zod 在入参，内核在落盘前（`@diy/facts/node` 的 submit）。
 */
import { z } from 'zod';

export const EnvSchema = z.enum(['production', 'development', 'test']);

export const ScopeSchema = z.object({
    env: z.union([EnvSchema, z.array(EnvSchema)]).optional(),
    paths: z.array(z.string()).optional(),
    task: z.string().optional(),
});

export const EvidenceSchema = z.object({
    /** 证据档：user（用户明说）· probe（命令可复现）· code（可定位）· inference（推断，默认 proposed） */
    source: z.enum(['user', 'probe', 'code', 'inference']),
    /** 可定位证据 `<路径>:<行>`（仓库相对或 `~/` 开头） */
    at: z.string().optional(),
    /** 可执行探针命令（source=probe 必填） */
    probe: z.string().optional(),
    /** 探针输出指纹（只存指纹，不存输出） */
    probeDigest: z.string().optional(),
    /** 最近一次实际验证日期（ISO-8601） */
    verifiedAt: z.string().optional(),
});

/**
 * 关系边（判别联合：判别键同级 = 公共字段，分支私有进 `data`，见 rule.discriminated-union）。
 * 目标粒度**按关系而异**：`depends-on` 指 claim（跨环境取正确变体）、`supersedes` 指 fact id。
 */
export const RefSchema = z.discriminatedUnion('rel', [
    z.object({
        rel: z.literal('depends-on'),
        data: z.object({ toClaim: z.string(), when: ScopeSchema.optional() }),
    }),
    z.object({
        rel: z.literal('supersedes'),
        data: z.object({ toFactId: z.string(), within: ScopeSchema.optional() }),
    }),
]);

export const FactSchema = z.object({
    /** 稳定审计锚点（`supersedes.to` 指着它，故不可由 subject+scope 派生） */
    id: z.string(),
    /** 对象（受控词表内） */
    subject: z.string(),
    aspect: z.string(),
    value: z.string(),
    scope: ScopeSchema.optional(),
    review: z.enum(['proposed', 'accepted', 'rejected']),
    lifecycle: z.enum(['active', 'superseded', 'expired']),
    evidence: EvidenceSchema,
    refs: z.array(RefSchema).optional(),
});

export const SubjectSchema = z.object({
    key: z.string(),
    description: z.string().optional(),
    aliases: z.array(z.string()).optional(),
});

/** 一条问题（与 `@diy/facts/node` 的 RepoProblem 同形：level 决定阻不阻断） */
export const ProblemSchema = z.object({
    level: z.enum(['error', 'warning']),
    code: z.string(),
    detail: z.string(),
    facts: z.array(z.string()).optional(),
});

export const FactsStatusSchema = z.object({
    dir: z.string(),
    facts: z.number(),
    claims: z.number(),
    subjects: z.number(),
    files: z.number(),
    problems: z.array(ProblemSchema),
});

export const FactsGetSchema = z.object({
    /** 是否找到（找不到**不是**错误：`diy facts get` 就是拿来试探有没有这条的） */
    resolved: z.array(
        z.object({
            claim: z.string(),
            /** 命中的 fact（含来源文件，便于人去看真源） */
            facts: z.array(FactSchema.extend({ file: z.string() })),
        }),
    ),
    /** 每个 claim 的裁决理由（选了哪条 / 为什么没选） */
    notes: z.array(z.string()),
});

export const FactsSubmitReportSchema = z.object({
    dryRun: z.boolean(),
    added: z.array(z.string()),
    updated: z.array(z.object({ id: z.string(), before: z.string(), after: z.string() })),
    unchanged: z.array(z.string()),
    newSubjects: z.array(z.string()),
    files: z.array(z.object({ file: z.string(), before: z.number(), after: z.number() })),
});

export const FactsSubmitSchema = z.object({
    report: FactsSubmitReportSchema,
    problems: z.array(ProblemSchema),
});

export const FactsAffectedSchema = z.object({
    ids: z.array(z.string()),
});

/**
 * 编译期护栏：schema 与内核 `Fact` 形状必须一致（不一致 → `tsc` 红，不用等运行时）。
 * 用 `extends` 而不是 `Equals`：schema 允许多出可选字段是无害的，**少了或类型不对**才是病。
 */
export type _SchemaMatchesKernel = z.infer<typeof FactSchema> extends import('@diy/facts').Fact ? true : never;
export const _schemaShapeOk: _SchemaMatchesKernel = true;

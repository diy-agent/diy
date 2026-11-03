/**
 * shared/facts.ts — 事实库 RPC 契约（##404）
 *
 * 为什么这里有 zod 而内核没有：内核（`@diy-agent/facts`）是纯 TS 类型 + 纯函数，**不认识 zod**
 * （它要被 CLI 之外的消费者复用）；RPC 边界才需要"从任意输入解析出形状"。
 *
 * 形状漂移的护栏：文件末尾那条 `_SchemaMatchesKernel` 编译期断言 —— schema 与内核 `Fact`
 * 一旦不同步，`tsc` 先红，而不是等某次 `diy facts submit` 在运行时丢字段。
 *
 * 校验的两层分工（别混）：
 *   1. zod（这里）—— **形状**：字段名 / 类型 / 未知字段
 *   2. 内核 `validateFacts` —— **语义**：subject 不许含 `#`、probe 档必须有命令、scope 三轴合法
 * 走 RPC 时两层都跑：zod 在入参，内核在落盘前（`@diy-agent/facts/node` 的 submit）。
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

/** 一条问题（与 `@diy-agent/facts/node` 的 RepoProblem 同形：level 决定阻不阻断） */
export const ProblemSchema = z.object({
    level: z.enum(['error', 'warning']),
    code: z.string(),
    detail: z.string(),
    facts: z.array(z.string()).optional(),
});

export const FactsStatusSchema = z.object({
    dir: z.string(),
    /** 顶层计数 = **本根**（不含额外只读库；额外库在 `extra`） */
    facts: z.number(),
    claims: z.number(),
    subjects: z.number(),
    files: z.number(),
    /** 额外只读库（设备级）并入的量：读跨根、写不跨根 */
    extra: z.object({
        facts: z.number(),
        claims: z.number(),
        subjects: z.number(),
        dirs: z.array(z.string()),
    }),
    /**
     * 按 subject 的**字节账**（`bytes` = 可用事实的 value 字节和，按字节降序）。
     *
     * 为什么必须有它：预算的单位是字节，而计数只给 claims 数 —— 人看不到"这个话题占多少"
     * 就没法决定该把它放 `full` 还是 `index`（实测 `rule` 一个主题就 9.3 KB）。
     */
    bySubject: z.array(
        z.object({
            subject: z.string(),
            claims: z.number(),
            facts: z.number(),
            bytes: z.number(),
            expose: z.enum(['full', 'index', 'none']),
        }),
    ),
    /** `full` 档字节和 / 预算（`used > limit` ⇒ problems 里有 `facts/expose-budget`） */
    exposeBudget: z.object({ used: z.number(), limit: z.number() }),
    problems: z.array(ProblemSchema),
});

export const FactsGetSchema = z.object({
    /** 是否找到（找不到**不是 RPC 错误**：CLI 侧以退出码 1 表达，见下方 `factsGetExitCode`） */
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

/**
 * `diy facts get` 的退出码判据（CLI 输出层用，见 CliConfig.exitCodeOf）。
 *
 * 分界（别扩大）：**按名取实体**查不到 ⇒ 1（同 `grep` 无匹配 / `cat` 缺文件）；
 * `find` / `brief` / `status` 这类搜索 / 列举**不实现此判据** —— 空结果是正常结果，退出码 0。
 *
 * 只看 `resolved` 是否**全空**：多 claim 查询里「部分命中」是合法用法（命中就给了值），
 * 抛错或判失败都会毁掉它。返回体照旧给 `resolved: []` + `notes`，人要先看见原因再拿退出码。
 */
export function factsGetExitCode({
    rpcName,
    result,
}: {
    rpcName: string;
    result: unknown;
}): number | undefined {
    if (rpcName !== 'diy.facts.get') return undefined;
    const resolved = (result as { resolved?: unknown } | null | undefined)?.resolved;
    return Array.isArray(resolved) && resolved.length === 0 ? 1 : undefined;
}

/**
 * 目录级摘要（`diy facts brief <subject>`）：一个 subject 的全部 aspect + 值首句。
 *
 * `preview` 是**线索**不是结论：完整值走 `get`。`variants > 1` 是"该问一句当前环境"的信号
 * （与投递投影的 cell.variants 同一个含义，两处别各定义）。
 *
 * **可省字段的判据**（##5 第 9 轮实测：`brief app.find` 10.5 KB 里 5.3 KB 是元数据）：
 * 缺省值不写、重复值上提。`review`/`lifecycle` 只在非 accepted/active（异常态才是信号）；
 * `variants` 只在 >1；`file` 同主题同源时提到主题级，否则落在条目上。
 */
export const FactsBriefItemSchema = z.object({
    subject: z.string(),
    /** subject 词表里的说明（没有则 null —— 不是空串） */
    desc: z.string().nullable(),
    claims: z.number(),
    facts: z.number(),
    /** 该主题全部条目同源一个文件时给出（此时条目上没有 `file`） */
    file: z.string().optional(),
    entries: z.array(
        z.object({
            aspect: z.string(),
            gid: z.string(),
            preview: z.string(),
            variants: z.number().optional().describe("变体数（>1 才出现）"),
            review: z.string().optional().describe("只在非 accepted 时出现"),
            lifecycle: z.string().optional().describe("只在非 active 时出现"),
            file: z
                .string()
                .optional()
                .describe("来源文件（该主题条目不同源时才逐条给；同源时见主题级 `file`）"),
        }),
    ),
    notes: z.array(z.string()),
});

/**
 * 多主题摘要的返回：`subjects` 恒为数组（单主题也是 1 元素 —— 形状不随入参变，
 * 消费方不必写两套分支）。给了 `--budget` 才有 `budget` 回执。
 *
 * `--budget` 语义：按主题序 → aspect 序**逐条贪心装**，装不下就停 —— `truncated` 是"没装下的
 * 条目数"，既不是错误也不是"数据没有"；一条都装不下时 `notes` 给最小单元与建议值
 * （让「预算太小」与「没数据」可区分）。
 */
export const FactsBriefSchema = z.object({
    subjects: z.array(FactsBriefItemSchema),
    /** 给了 `--budget` 才有：`used` = 最终输出的 UTF-8 字节（与收到的那串文本同一口径） */
    budget: z.object({ limit: z.number(), used: z.number() }).optional(),
    /** 因预算被裁掉的条目数（>0 ⇒ 按主题序 → aspect 序截成了前缀） */
    truncated: z.number().optional(),
    /** 一条都没装下时的说明（预算太小 + 建议值）—— 让「没数据」与「预算太小」可区分 */
    notes: z.array(z.string()).optional(),
});

/**
 * 全文检索（`diy facts find <词>`）：claim / id / value 子串命中，多词 = 与。
 * `total` 是命中总数，`hits` 可能被 limit 截断（二者不等就是截断了）。
 */
export const FactsFindSchema = z.object({
    keyword: z.string(),
    hits: z.array(
        z.object({
            gid: z.string(),
            id: z.string(),
            preview: z.string(),
            hitIn: z.array(z.string()),
            review: z.string(),
            lifecycle: z.string(),
        }),
    ),
    total: z.number(),
    notes: z.array(z.string()),
});

export const FactsLandingSchema = z.object({
    /** 实际写入的 `knowledge/` **绝对路径** */
    dir: z.string(),
    /** 计算 `rel` 的根（仓库根；设备级库是家目录） */
    root: z.string(),
    /** 相对仓库根的路径（如 `knowledge` / `.diy/knowledge`） */
    rel: z.string(),
    /** 调用方 cwd（敲命令的那个 shell；没带就不给） */
    callerCwd: z.string().optional(),
});

export const FactsSubmitReportSchema = z.object({
    dryRun: z.boolean(),
    /**
     * 落点回显（##437）：实际写进哪个 `knowledge/`。**dry-run 也带** —— 提前看见，
     * 不必先写错一次（##408：worktree 里提交写进了主仓，一切"成功"、只是落点不对）。
     */
    landing: FactsLandingSchema,
    added: z.array(z.string()),
    updated: z.array(z.object({ id: z.string(), before: z.string(), after: z.string() })),
    unchanged: z.array(z.string()),
    newSubjects: z.array(z.string()),
    /** 本批从**本地**词表删掉的 subject（`dropSubjects` 载荷；不存在于本库的不列） */
    droppedSubjects: z.array(z.string()),
    files: z.array(z.object({ file: z.string(), before: z.number(), after: z.number() })),
    /** 本批物理删除的 id（改名 = drop 旧 id + 写新 id，同批事务） */
    dropped: z.array(z.string()),
    /**
     * 本批**顺手建了库**（只在真写了、且写前 `facts/` 不存在时出现）。
     *
     * 为什么要有：`--dir <path>` 是手敲的路径，写错一个新目录也会"成功" —— 不提示就等于
     * 默许知识进了另一个库。`--in task:<uri>` / `global` 同样会带（路径是推导的，建库是预期
     * 行为，带上是给人确认"库在哪"）。**不阻止、不静默**：这是唯一允许的形态。
     */
    created: z.object({ dir: z.string() }).optional(),
});

export const FactsSubmitSchema = z.object({
    report: FactsSubmitReportSchema,
    problems: z.array(ProblemSchema),
});

export const FactsAffectedSchema = z.object({
    ids: z.array(z.string()),
});


/** 真源原文（UI「原 YAML」视图）：不解析、不校验，读什么给什么 */
export const FactsRawSchema = z.object({
    dir: z.string(),
    in: z.string(),
    exists: z.boolean(),
    files: z.array(z.object({ name: z.string(), text: z.string() })),
    /** 词表：可能有**两份**（本地局部扩词 + 继承仓库的全局词表），name 标明来源 */
    subjects: z.array(z.object({ name: z.string(), text: z.string() })),
});

/** 投影结果：真源 → 给 LLM 看的形态（可换算法 / 按预算裁 / 变体解析成当前值） */
export const FactsProjectSchema = z.object({
    algorithm: z.enum(['yaml-nested', 'flat-gid', 'md-list']),
    text: z.string(),
    bytes: z.number(),
    /** 真正渲染出来的 gid */
    shown: z.array(z.string()),
    /** 被预算裁掉的 gid（不是错误，超预算才会非空） */
    omitted: z.array(z.string()),
    /** 当前作用域不适用而跳过的（**正常**：路径型事实在别的目录就该消失） */
    skipped: z.array(z.string()),
    /** 真问题：冲突 / 库内无此 claim —— 这类必须让人看见 */
    problems: z.array(z.object({ gid: z.string(), code: z.string(), detail: z.string().optional() })),
});

/**
 * 编译期护栏：schema 与内核 `Fact` 形状必须一致（不一致 → `tsc` 红，不用等运行时）。
 * 用 `extends` 而不是 `Equals`：schema 允许多出可选字段是无害的，**少了或类型不对**才是病。
 */
export type _SchemaMatchesKernel = z.infer<typeof FactSchema> extends import('@diy-agent/facts').Fact ? true : never;
export const _schemaShapeOk: _SchemaMatchesKernel = true;

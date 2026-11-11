/**
 * api-domains/facts/api.ts —— 2026-11-06 从 services/api-def.ts 拆出。
 *
 * import 待手工补（各域依赖不同）。
 */
import { z } from "zod";
import { RpcSchema, defineService } from "@diy-agent/rpc";
import {
    EnvSchema,
    FactsAffectedSchema,
    FactsBriefSchema,
    FactsFindSchema,
    FactsGetSchema,
    FactsProjectSchema,
    FactsRawSchema,
    FactsStatusSchema,
    FactsSubmitSchema,
} from "../../../../shared/facts";

export const factsRoutes = RpcSchema.group({
    desc:
        `项目级事实库（##404）：agent **只经这里读写事实，不碰 YAML 文件**（手改必错）。真源 knowledge/facts/*.yaml，判据在 @diy-agent/facts。` +
        `\n\n**不知道一件东西该去哪查 → \`diy facts brief where\`**：\`where\` 主题是「统一汇入点」，每个通道（facts / runtime / journal / traffic / 文件）一条，只写"去哪查"、不写值（通道才变，所以不腐坏）`,
    children: {
        status: RpcSchema.unary({
            desc: `事实库体检：条目 / claim / 词表计数 + 全部问题（与 ./sha.sh check 同一套判据，不会出现"CLI 绿、CI 红"）。顶层计数 = **本根**，额外只读库（设备级）单列在 \`extra\` —— 混一桶会造出"我啥也没干库就暴涨"的假象`,
            input: {
                dir: z.string().optional().cliOption({ desc: "knowledge 目录（缺省自动向上找）" }),
                in: z
                    .string()
                    .optional()
                    .cliOption({
                        desc: "库的位置：缺省 = 仓库 knowledge/；global = 设备级 <数据根>/knowledge；task:<taskUri> = 任务级库（<任务目录>/knowledge，词表继承仓库）",
                    }),
            },
            output: FactsStatusSchema,
        }),
        brief: RpcSchema.unary({
            desc: `目录级：列若干 subject 的**全部 aspect**（gid + 值首句 ≤80 字）。链上正文删掉后靠它"扫一眼有哪些条目"，再决定精确 \`get\` 哪条。**多个主题用逗号**、**通配 \`app.*\` 展开全部同前缀主题**（kb 索引按前缀折叠后，展开就靠这一条命令）—— 一次调用搞定，省下的是一整轮前缀重发。元数据只给**异常态**（review≠accepted / lifecycle≠active / variants>1），同源时 \`file\` 提到主题级`,
            input: {
                subject: z
                    .string()
                    .cliArg({ placeholder: "<subject,...>", desc: "主题（如 find / tool / rule；多个用逗号分隔）" }),
                maxChars: z.number().optional().cliOption({ desc: "每条摘要字数上限（缺省 80）" }),
                budget: z.number().optional().cliOption({
                    desc: "总字节上限（UTF-8，按**最终输出的 JSON** 量，含 budget/truncated/notes 回执）：按主题序 → aspect 序**逐条贪心装**，装不下就停（余下记 `truncated`）。利用率接近 100%，不再有「整主题砍」的断崖；一条都装不下时给 `notes` 说明最小单元与建议值",
                }),
                dir: z.string().optional().cliOption({ desc: "knowledge 目录（缺省自动向上找）" }),
                in: z
                    .string()
                    .optional()
                    .cliOption({
                        desc: "库的位置：缺省 = 仓库 knowledge/；global = 设备级 <数据根>/knowledge；task:<taskUri> = 任务级库（<任务目录>/knowledge，词表继承仓库）",
                    }),
            },
            output: FactsBriefSchema,
        }),
        find: RpcSchema.unary({
            desc: `全文检索：claim / id / value 上大小写不敏感子串，多个关键词用逗号分隔 = **全都要命中**。命中内容排在命中键名之前`,
            input: {
                keyword: z.string().cliArg({ placeholder: "<关键词,...>", desc: "关键词（多个用逗号分隔 = 与）" }),
                limit: z.number().optional().cliOption({ desc: "最多返回几条（缺省 20；total 不受影响）" }),
                maxChars: z.number().optional().cliOption({ desc: "每条摘要字数上限（缺省 80）" }),
                dir: z.string().optional().cliOption({ desc: "knowledge 目录（缺省自动向上找）" }),
                in: z
                    .string()
                    .optional()
                    .cliOption({
                        desc: "库的位置：缺省 = 仓库 knowledge/；global = 设备级 <数据根>/knowledge；task:<taskUri> = 任务级库（<任务目录>/knowledge，词表继承仓库）",
                    }),
            },
            output: FactsFindSchema,
        }),
        get: RpcSchema.unary({
            desc: `按 claim（subject#aspect）取当前作用域下的值；多个 claim 用逗号分隔。悬空 / 冲突带错误码返回，**不当成"没找到"**`,
            input: {
                claim: z.string().cliArg({ placeholder: "<subject#aspect>", desc: "claim（多个用逗号分隔）" }),
                env: EnvSchema.optional().cliOption({ desc: "作用域：环境（production|development|test）" }),
                path: z.string().optional().cliOption({ desc: "作用域：代码路径（多个用逗号分隔，仓库相对）" }),
                task: z.string().optional().cliOption({ desc: "作用域：任务 URI" }),
                dir: z.string().optional().cliOption({ desc: "knowledge 目录（缺省自动向上找）" }),
                in: z
                    .string()
                    .optional()
                    .cliOption({
                        desc: "库的位置：缺省 = 仓库 knowledge/；global = 设备级 <数据根>/knowledge；task:<taskUri> = 任务级库（<任务目录>/knowledge，词表继承仓库）",
                    }),
            },
            output: FactsGetSchema,
        }),
        submit: RpcSchema.unary({
            desc: `整批写入事实（**全过才写**：一条不过整批拒，磁盘不动）。**库不存在 = 空库，直接写**：目录由落盘层顺手建出（\`report.created = { dir }\` 即"本批新建了库"，\`--dir\` 手敲路径写错时靠它发现）。载荷 JSON \`{ facts: [...], subjects?: [...], drop?: [...], expose?: {<subject>: full|index|none} }\`（field 值为 - 读 stdin）；--dry-run 只回显差异。\`expose\` = 主题暴露档与事实**同一事务**（改档位也别手改 YAML）：\`full\` 进正文 / \`index\` 只进索引（缺省）/ \`none\` 两处都不给；\`full\` 的字节和超预算 ⇒ 整批拒写（不许沉默超限）。\`drop\` = 物理删除的 id，与写入**同批事务** —— 改名 = \`drop\` 旧 id + 写新 id + 补 supersedes 边，一次成型（分成两次 = 中间态悬空边或断头事实）；删完照样跑整套判据，删错了以「边悬空」当场拒写\n\n**四种载荷各自的形状**（字段名写错当场拒，不再崩在内部）：\n· facts[] = { subject, aspect, value, format?, review?, lifecycle?, scope?, refs?, evidence } —— \`format\` 缺省 \`md\`（不必写，值是 md 文本，表格/列表随便写）；只有**机器消费**的值才写 \`format: json\`（submit 当场 JSON.parse 校验，写错逗号即拒，错误码 facts/value-format）；evidence = { source: user|probe|code|inference, at?, quote?, probe?, probeDigest?, verifiedAt? } —— at 有**两**种写法：<路径>:<行>（默认，行号随文件漂）/ **<rev>:<路径>:<行>（钉住提交：行号在该 rev 里校验，源文件后续瘦身不影响）** —— 迁移类事实一律用后者；行可省；**source: probe 用 probe（探针命令）而不是 at**（探针没有文件行号可指，可不写 at）\n· subjects[] = { key, description?, aliases? } —— 字段名是 **key**（不是 subject / name / id）；每个 subject 必须有 description\n· drop[] = fact id 字符串（物理删事实；改名 = drop 旧 id + 写新 id + 补 supersedes 边）\n· dropSubjects[] = subject key 字符串（删**本地**词表条目；删不掉的三种情况各有错误码：仍被事实用 → facts/subject-drop-in-use · 继承来的 → facts/subject-drop-not-local · 同批既声明又删 → facts/subject-drop-declared）\n· expose = { \"<subject>\": full|index|none }\n\n**事务边界**：四种载荷 + facts 的 schema 校验**任一不过 ⇒ 磁盘一个字都不动**（含词表）。返回 \`problems\` 里带错误码，重提即可 —— 不会有\"事实没写进去、词表却多了一行\"的半截状态。`,
            input: {
                file: z
                    .string()
                    .cliOption({ readFile: true, placeholder: "<file|->", desc: "载荷 JSON 文件（- = stdin）" }),
                dryRun: z.boolean().optional().cliOption({ desc: "只算不写：回显将新增 / 修改什么" }),
                dir: z
                    .string()
                    .optional()
                    .cliOption({ desc: "knowledge 目录（缺省：DIY_FACTS_DIR > **调用方 cwd** 向上找 > 主进程 cwd）" }),
                /**
                 * 调用方 cwd（parser 自动注入，不是可敲的选项）—— 缺省库目录的**判据**（##437）。
                 * handler 跑在 app 主进程，`process.cwd()` 是应用目录（主仓）：用它当缺省
                 * 会让 worktree 里的 `facts submit` 写进主仓（##408）。
                 */
                cwd: z.string().optional().cliOption({ callerCwd: true }),
                in: z
                    .string()
                    .optional()
                    .cliOption({
                        desc: "库的位置：缺省 = 仓库 knowledge/；global = 设备级 <数据根>/knowledge；task:<taskUri> = 任务级库（<任务目录>/knowledge，词表继承仓库）",
                    }),
            },
            output: FactsSubmitSchema,
        }),
        raw: RpcSchema.unary({
            desc: `真源**原文**（UI「原 YAML」视图用）：不解析不校验，读什么给什么 —— 包括注释与字段顺序`,
            input: {
                dir: z.string().optional().cliOption({ desc: "knowledge 目录（缺省自动向上找）" }),
                in: z
                    .string()
                    .optional()
                    .cliOption({
                        desc: "库的位置：缺省 = 仓库 knowledge/；global = 设备级 <数据根>/knowledge；task:<taskUri> = 任务级库（词表继承仓库）",
                    }),
            },
            output: FactsRawSchema,
        }),
        project: RpcSchema.unary({
            desc: `**投影**：真源 → 给 LLM 看的形态（变体解析成当前值 / 按 ns 分组 / 可换算法 / 可按字节预算裁剪）`,
            input: {
                algorithm: z
                    .enum(["yaml-nested", "flat-gid", "md-list"])
                    .optional()
                    .cliOption({ desc: "渲染算法（缺省 yaml-nested）" }),
                maxBytes: z.number().optional().cliOption({ desc: "字节预算（超了按 ns 优先级从尾部裁，不截断单条）" }),
                env: EnvSchema.optional().cliOption({ desc: "解析上下文：环境（缺省不假设）" }),
                path: z.string().optional().cliOption({ desc: "解析上下文：代码路径（逗号分隔）" }),
                task: z.string().optional().cliOption({ desc: "解析上下文：任务 URI" }),
                includeProposed: z.boolean().optional().cliOption({ desc: "把 proposed（未 accepted）也算进来" }),
                dir: z.string().optional().cliOption({ desc: "knowledge 目录（缺省自动向上找）" }),
                in: z
                    .string()
                    .optional()
                    .cliOption({
                        desc: "库的位置：缺省 = 仓库 knowledge/；global = 设备级 <数据根>/knowledge；task:<taskUri> = 任务级库（词表继承仓库）",
                    }),
            },
            output: FactsProjectSchema,
        }),
        affected: RpcSchema.unary({
            desc: `影响面：哪些事实的 scope.paths 覆盖这些文件（动代码前先问一句，比读整份文档便宜）`,
            input: {
                files: z.string().cliOption({ placeholder: "<path,...>", desc: "文件路径（逗号分隔，仓库相对）" }),
                dir: z.string().optional().cliOption({ desc: "knowledge 目录（缺省自动向上找）" }),
                in: z
                    .string()
                    .optional()
                    .cliOption({
                        desc: "库的位置：缺省 = 仓库 knowledge/；global = 设备级 <数据根>/knowledge；task:<taskUri> = 任务级库（<任务目录>/knowledge，词表继承仓库）",
                    }),
            },
            output: FactsAffectedSchema,
        }),
    },
});

export const factsService = defineService({ name: "diy.facts", api: factsRoutes });

/**
 * 新模型（##87）：模块自带模块层，app 前缀由宿主给。
 * `server.use({ prefix: "diy", api: factsApi, handlers: { facts: … } })`
 * 与上面的 `factsService` 完全等价（后者 = prefix "diy" + 模块层 "facts"）。
 */
export const factsApi = RpcSchema.group({ children: { facts: factsRoutes } });

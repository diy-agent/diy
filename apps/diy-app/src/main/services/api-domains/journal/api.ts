/**
 * api-domains/journal/api.ts —— 2026-11-06 从 services/api-def.ts 拆出。
 *
 * import 待手工补（各域依赖不同）。
 */
import { z } from "zod";
import { RpcSchema, defineService } from "@diy-agent/rpc";
import {
    JournalAddSchema,
    JournalFindSchema,
    JournalImportSchema,
    JournalRawSchema,
    JournalStatsSchema,
} from "../../../../shared/journal";

export const journalRoutes = RpcSchema.group({
    desc: `任务日志（##404）：**append-only 事件流**（decision / pitfall / review / progress / learn）。三分法：能改写成「现在是什么」→ \`diy facts\`；「接下来做什么」→ 任务 body；「发生过什么」→ 这里。日志不参与每轮上下文，所以 body 可以瘦`,
    children: {
        add: RpcSchema.unary({
            desc: `追加一条日志（只追加、不改不删；title 一行必填 —— 标题写不出多半是该拆）`,
            input: {
                task: z
                    .string()
                    .cliArg({
                        placeholder: "<projects/N/tasks/M>",
                        desc: "任务 URI（**必填，不做「当前任务」推导**）",
                    }),
                kind: z
                    .enum(["decision", "pitfall", "review", "progress", "learn"])
                    .cliOption({
                        desc: "kind：decision 决策 / pitfall 踩坑 / review 结论 / progress 里程碑 / learn 发现（**传英文值**，中文只是说明）",
                    }),
                title: z.string().cliOption({ placeholder: "<text>", desc: "一行标题（标题写不出 = 这条该拆）" }),
                body: z
                    .string()
                    .optional()
                    .cliOption({
                        placeholder: "<text>",
                        inlineText: { fileOpt: "--body-file", textOpt: "--body-text" },
                        desc: "可选正文（**内联**，不是文件路径：值形如单行路径会被拒）",
                    }),
                bodyText: z
                    .string()
                    .optional()
                    .cliOption({ placeholder: "<text>", desc: "可选正文（显式内联，与 --body 同义但不做路径护栏）" }),
                bodyFile: z
                    .string()
                    .optional()
                    .cliOption({ readFile: true, placeholder: "<file|->", desc: "可选正文来自文件（- = stdin）" }),
                refs: z
                    .string()
                    .optional()
                    .cliOption({
                        placeholder: "<a,b>",
                        desc: "引用：commit / 任务 uri / 事实 gid / 路径:行（逗号分隔）",
                    }),
                round: z.string().optional().cliOption({ desc: "会话轮次 id（可选）" }),
                author: z.string().optional().cliOption({
                    placeholder: "<role[:name]>",
                    desc: "谁写的：system（客观判定）/ agent:<名>（模型叙述）/ human:<名>（用户原话，**必须配 --anchor**）",
                }),
                anchor: z.string().optional().cliOption({
                    placeholder: "<type:...>",
                    desc: "指向哪：node:<id> / message:<id> / task-field:<field> / doc-range:<rev>:<offset>:<quote>",
                }),
            },
            output: JournalAddSchema,
        }),
        raw: RpcSchema.unary({
            desc: `日志文件**原文**（UI「原 JSONL」视图用）：只读字节、只数行 —— 坏行也照原样给出来`,
            input: {
                task: z.string().cliArg({ placeholder: "<projects/N/tasks/M>", desc: "任务 URI" }),
            },
            output: JournalRawSchema,
        }),
        find: RpcSchema.unary({
            desc: `查日志（缺省最近优先、全 kind）。\`--grep\` 搜 title/body/refs；输出是渲染好的 markdown`,
            input: {
                task: z.string().cliArg({ placeholder: "<projects/N/tasks/M>", desc: "任务 URI" }),
                kind: z.string().optional().cliOption({ placeholder: "<k1,k2>", desc: "筛选 kind（逗号分隔）" }),
                since: z.string().optional().cliOption({ placeholder: "<date>", desc: "起始时间（含）" }),
                until: z.string().optional().cliOption({ placeholder: "<date>", desc: "截止时间（含）" }),
                grep: z.string().optional().cliOption({ placeholder: "<text>", desc: "子串过滤（title/body/refs）" }),
                limit: z.number().optional().cliOption({ desc: "最多几条（缺省 20，-1 = 全部）" }),
                order: z.enum(["asc", "desc"]).optional().cliOption({ desc: "排序（缺省 desc = 最近优先）" }),
            },
            output: JournalFindSchema,
        }),
        stats: RpcSchema.unary({
            desc: `日志体检：总条数 / 字节 / 按 kind 计数 / 首尾时间（body 瘦身前后用它对账）`,
            input: {
                task: z.string().cliArg({ placeholder: "<projects/N/tasks/M>", desc: "任务 URI" }),
            },
            output: JournalStatsSchema,
        }),
        import: RpcSchema.unary({
            desc: `批量导入（回灌历史）。载荷 = JSON 数组 \`[{kind,title,body?,refs?,ts?}]\`；**整批校验通过才写**，--dry-run 只算`,
            input: {
                task: z.string().cliArg({ placeholder: "<projects/N/tasks/M>", desc: "任务 URI" }),
                file: z.string().cliOption({ readFile: true, placeholder: "<file|->", desc: "载荷 JSON（- = stdin）" }),
                dryRun: z.boolean().optional().cliOption({ desc: "只算不写" }),
            },
            output: JournalImportSchema,
        }),
    },
});

export const journalService = defineService({ name: "diy.journal", api: journalRoutes });

/**
 * 新模型（##87）：模块自带模块层，app 前缀由宿主给。
 * `server.use({ prefix: "diy", api: journalApi, handlers: { journal: … } })`
 * 与上面的 `journalService` 完全等价（后者 = prefix "diy" + 模块层 "journal"）。
 */
export const journalApi = RpcSchema.group({ children: { journal: journalRoutes } });

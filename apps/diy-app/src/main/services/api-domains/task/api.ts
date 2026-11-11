/**
 * api-domains/task/api.ts —— 从 services/api-def.ts 拆出。
 */
import { z } from "zod";
import { RpcSchema } from "@diy-agent/rpc";
import { StatusOk, StatusDataUri } from "../../../../shared/status";
import { ChangeTypeSchema, PrioritySchema } from "../../../core/task-fields";
import { DraftFieldSchema, DraftsData, TaskDetailSchema } from "../../../../shared/task-detail";
import { TaskStateSchema } from "../../../core/task-state";
import { TaskNodeSchema } from "../../../../shared/task-node";

/** 从 api-def.ts 复制（那边是局部常量，没导出） */
const CreateResult = z.object({
    status: z.string(),
    data: z.object({
        uri: z.string(),
        /** 实际落到的 project id */
        project: z.string(),
        label: z.string().optional(),
        path: z.string().optional(),
    }),
});
/** 从 api-def.ts 复制（那边是局部常量，没导出） */
const StrippedHeadReportSchema = z.object({
    keys: z.array(z.string()),
    /** 被剥掉的头**原文**（调用方据此核对丢了什么内容 —— 只报键名看不出） */
    head_text: z.string(),
    /** 与文件现有头不一致、**未写回**的键（文件头才是权威） */
    differs: z.array(z.string()).optional(),
});
/** 从 api-def.ts 复制（那边是局部常量，没导出） */
const StatusDataTaskWrite = z.object({
    status: z.string(),
    data: z.object({
        uri: z.string(),
        /** 入参 `--body` 其实是「整份文件」→ 头已剥离取正文（`--append-body` 的严判据见 core/task.ts） */
        body_head_stripped: StrippedHeadReportSchema.optional(),
        /** 入参 `--append-body` 其实是「整份文件」→ 头已剥离取正文 */
        append_head_stripped: StrippedHeadReportSchema.optional(),
        /** 本次实际追加的字符数 */
        appended_chars: z.number().optional(),
    }),
});

export const taskRoutes = RpcSchema.group({
    desc: `任务管理`,
    children: {
        create: RpcSchema.unary({
            desc: `
            创建任务

            正文（body）输入契约（##338 / ##376）—— **三选一**，同时给多个会被拒（不猜、不按顺序取）：
              \`--body <文本>\`        任务内容（内联正文；值形如**单行文件路径** → 直接报错并提示正确写法）
              \`--body-text <文本>\`   任务内容（显式内联文本：与 \`--body\` 同义，但不做「形如路径」护栏）
              \`--body-file <file|->\` 任务内容：从**文件**读（\`-\` = stdin；相对路径按当前目录解析）
            与 \`task edit\` 同一套选项形状与同一条裁决（\`core/task.ts::resolveBodyOverride\`）。
            注意：create 是新建任务，**不做「整份任务文件剥头」**（没头可覆盖），传整份文件会把头写进正文。

            归属检测（##430）：cwd 落在**另一个** project 的目录（含其 worktree）里 ⇒ 直接拒绝并列出候选
            （多项目各自自增、同号会撞车，事后很难发现）。确要在那个 project 下建 → 显式加 \`--force\`。
            成功时回显 uri + project + label + path（只回 uri 时看不出落到了哪个仓）。
            `,
            input: {
                title: z.string().min(1, "标题不能为空").max(200).cliArg({ desc: "任务标题" }),
                project: z.string().cliArg({ desc: "所属 project id" }),
                parent: z.string().optional().cliOption({ short: "p", desc: "父任务 URI" }),
                body: z
                    .string()
                    .optional()
                    .cliOption({
                        placeholder: "<text>",
                        inlineText: { fileOpt: "--body-file", textOpt: "--body-text" },
                        desc: "任务内容（**内联正文**，不是文件路径：值形如单行路径会被拒）",
                    }),
                bodyText: z
                    .string()
                    .optional()
                    .cliOption({
                        placeholder: "<text>",
                        desc: "任务内容（显式内联文本：与 `--body` 同义，但不做「形如路径」护栏）",
                    }),
                bodyFile: z.string().optional().cliOption({
                    placeholder: "<file|->",
                    readFile: true,
                    desc: "任务内容：从**文件**读（`-` = stdin；相对路径按当前目录解析）—— **不剥 frontmatter**（新建任务无头可覆盖，传整份文件会把头写进正文）",
                }),
                persona: z
                    .string()
                    .optional()
                    .cliOption({
                        desc: "agent 人物 id（不传 = 跟随缺省；传值 = 固定绑定，人物决定模型/参数/行为指令）",
                    }),
                change_type: ChangeTypeSchema.optional().cliOption({
                    desc: "变更性质（feat/fix/docs/…，见 conventional commits）",
                }),
                module: z.string().optional().cliOption({ desc: "模块（可 `/` 分层，如 agent/ui）" }),
                priority: PrioritySchema.optional().cliOption({ desc: "优先级 P0-P3（不传=未定级）" }),
                /** 调用方 cwd（parser 自动注入，不是可敲的选项）—— 归属检测用（见 api-impl 的 task.create）。 */
                cwd: z.string().optional().cliOption({ callerCwd: true }),
                /** 归属检测的逃生口：确知要在「cwd 所在项目之外」建任务时显式声明。 */
                force: z.boolean().optional().cliOption({
                    desc: "跳过「cwd 归属不符」的拦截（确要在别的项目下建任务时用；默认会拒绝并要求改 --project）",
                }),
            },
            output: CreateResult,
        }),
        list: RpcSchema.unary({
            desc: `列出任务`,
            input: {
                project: z.string().optional().cliOption({ short: "p", desc: "按 project 筛选" }),
            },
            output: z.object({
                status: z.string(),
                data: z.object({
                    /** 任务 URI 列表（形状不变：`string[]`；细分信息在 `projects` 里） */
                    tasks: z.any(),
                    /** 结果涉及到的 project 归属（id → label/path）：多项目同号时靠它区分（##430） */
                    projects: z
                        .array(z.object({ id: z.string(), label: z.string().optional(), path: z.string().optional() }))
                        .optional(),
                }),
            }),
        }),
        /** 加载整棵任务树（renderer 侧栏用；2026-11 从 api-def 顶层 unary 归到 task 域） */
        tree: RpcSchema.unary({
            desc: `加载任务树（供 renderer 反向调用）`,
            input: {},
            output: z.object({ status: z.string(), data: z.array(TaskNodeSchema) }),
        }),
        show: RpcSchema.unary({
            desc: `查看任务详情（含未提交草稿 ui_drafts）`,
            input: {
                uri: z.string().cliArg({ desc: "任务 URI" }),
            },
            output: z
                .object({ status: z.string(), data: z.any() })
                .or(z.object({ status: z.string(), msg: z.string() })),
        }),

        /**
         * 任务详情（**renderer 专用**）—— 与 `show` 同一份数据 + `has_session` / `has_draft`。
         *
         * 2026-11 从 api-def 的顶层 `getTask` 归到这里。字段清单不在此手抄：
         * 契约是 `shared/task-detail.ts` 的 `TaskDetailSchema`（单一真源，renderer 的
         * `TaskDetail` 类型也从它推导）。历史教训：handler 与 output 各抄一份，漏一处就
         * 静默丢字段（zod 默认 strip 未声明键）。
         */
        detail: RpcSchema.unary({
            desc: `按 URI 获取任务详情（供 renderer 反向调用；未找到时 data 为 null）`,
            input: { uri: z.string().cliArg({ desc: "任务 URI" }) },
            output: z.object({
                status: z.string(),
                data: TaskDetailSchema.nullable(),
            }),
        }),

        /** 半编辑草稿：用户未提交的输入（agent 输入框 / 任务编辑框），落任务目录 .diy/drafts.yaml */
        drafts: RpcSchema.group({
            desc: `未提交草稿（agent 输入 / 任务编辑框；落任务目录 .diy/drafts.yaml）`,
            children: {
                show: RpcSchema.unary({
                    desc: `读取任务的未提交草稿（无草稿时 data 为 null）`,
                    input: {
                        uri: z.string().cliArg({ desc: "任务 URI" }),
                    },
                    output: z.object({ status: z.string(), data: DraftsData.nullable() }),
                }),
                set: RpcSchema.unary({
                    desc: `
                写入草稿（合并语义：只覆盖传入的字段）

                字段按白名单平铺，不用 JSON 参数：白名单固定且短，平铺后 --help 逐字段可见，
                也免去 shell 里 JSON 引号的层层转义。传空字符串（如 --title ""）= 清除该字段；
                不传 = 保持原值。已提交（保存/取消）后应显式清除，否则草稿会盖住新数据。

                正文草稿（body）与 \`task edit\` 同一套输入契约（##338 / ##376）—— **三选一**：
                  \`--body <文本>\`        内容草稿（内联正文；值形如**单行文件路径** → 直接报错）
                  \`--body-text <文本>\`   内容草稿（显式内联文本：不做「形如路径」护栏）
                  \`--body-file <file|->\` 内容草稿：从**文件**读（\`-\` = stdin）
                `,
                    input: {
                        uri: z.string().cliArg({ desc: "任务 URI" }),
                        title: z.string().optional().cliOption({ desc: "标题草稿（空串=清除）" }),
                        body: z
                            .string()
                            .optional()
                            .cliOption({
                                placeholder: "<text>",
                                inlineText: { fileOpt: "--body-file", textOpt: "--body-text" },
                                desc: "内容草稿（空串=清除；**内联正文**，不是文件路径：值形如单行路径会被拒）",
                            }),
                        bodyText: z
                            .string()
                            .optional()
                            .cliOption({
                                placeholder: "<text>",
                                desc: "内容草稿（显式内联文本：与 `--body` 同义，但不做「形如路径」护栏）",
                            }),
                        bodyFile: z.string().optional().cliOption({
                            placeholder: "<file|->",
                            readFile: true,
                            desc: "内容草稿：从**文件**读（`-` = stdin；相对路径按当前目录解析）",
                        }),
                        agent_input: z.string().optional().cliOption({ desc: "agent 输入框草稿（空串=清除）" }),
                        base_updated: z
                            .string()
                            .optional()
                            .cliOption({ desc: "草稿基点：任务当前 updated（用于检测过期）" }),
                    },
                    output: z.object({ status: z.string(), data: DraftsData }),
                }),
                clear: RpcSchema.unary({
                    desc: `清除草稿字段（不传 fields 清空全部字段；传 [] 什么都不清。只动草稿字段，不动待投递的插话队列；文件在字段与队列都空时才删除）`,
                    input: {
                        uri: z.string().cliArg({ desc: "任务 URI" }),
                        // CLI 数组统一走 JSON 形式（parser 只对 ZodArray 做 JSON.parse）：
                        // 必须写 --fields '["title"]'，写 --fields title 会得到 "expected array"。renderer 侧传数组。
                        fields: z
                            .array(DraftFieldSchema)
                            .optional()
                            .cliOption({ desc: `只清指定字段（JSON 数组，如 '["title"]'）` }),
                    },
                    output: StatusOk,
                }),
            },
        }),
        edit: RpcSchema.unary({
            desc: `
            编辑任务

            正文（body）输入契约（##322 / ##338）—— **整篇覆盖三选一、追加三选一**，同时给多个会被拒
            （不猜、不按顺序取）：
              \`--body <文本>\`        整篇覆盖（内联正文；值形如**单行文件路径** → 直接报错并提示正确写法）
              \`--body-text <文本>\`   整篇覆盖（显式内联文本，不做路径护栏 —— 正文本身就是一行路径时用它）
              \`--body-file <file|->\` 整篇覆盖（从文件读，\`-\` = stdin；等价 \`--body "$(cat f)"\`，但不受 ARG_MAX 限制）
              \`--append-body\` / \`--append-body-file\` / \`--append-body-text\`：追加的同样三态。
            为什么把"传文件"和"传文本"分开：在此之前 \`--body\` 只收文本，而 \`--append-body\` 收 \`<file|->\` ——
            两侧不对称，直觉上"都是传文件"，于是 \`diy task edit X --body /tmp/x.md\` 把**路径串当正文静默存下**、
            原正文丢失且无告警（##290 / ##294 / ##87 三例现场）。

            两者都接受"整份任务文件"（frontmatter + 正文）作输入：头会被**剥离**后丢弃（文件头才是权威），
            在返回值里回报剥了哪些键与**被剥掉的原文** —— 于是 \`--body "$(cat AGENTS.md)"\` 不再产生双头。
            判据不对称：\`--append-body\` 更严（追加一份"带 front matter 的文档"是常态，只认已知键会把
            文档头的 \`title:\` 当成任务头吞掉）。
            `,
            input: {
                uri: z.string().cliArg({ desc: "任务 URI" }),
                title: z.string().optional().cliOption({ short: "t", desc: "新标题" }),
                state: TaskStateSchema.optional().cliOption({ desc: "新状态" }),
                body: z
                    .string()
                    .optional()
                    .cliOption({
                        placeholder: "<text>",
                        inlineText: { fileOpt: "--body-file", textOpt: "--body-text" },
                        desc: "新内容，整篇覆盖（**内联正文**，不是文件路径：值形如单行路径会被拒；至少 10 字符；传整份文件自动剥头）",
                    }),
                bodyText: z
                    .string()
                    .optional()
                    .cliOption({
                        placeholder: "<text>",
                        desc: "新内容，整篇覆盖（显式内联文本：与 `--body` 同义，但不做「形如路径」护栏）",
                    }),
                bodyFile: z.string().optional().cliOption({
                    placeholder: "<file|->",
                    readFile: true,
                    desc: "新内容，整篇覆盖：从**文件**读（`-` = stdin；相对路径按当前目录解析；传整份文件自动剥头）",
                }),
                appendBody: z.string().optional().cliOption({
                    placeholder: "<file|->",
                    readFile: true,
                    desc: "追加内容：文件路径（相对路径按当前目录解析），`-` 读 stdin。追加在原正文之后（空行分隔），不必先读任务文件（= `--append-body-file`）",
                }),
                appendBodyFile: z.string().optional().cliOption({
                    placeholder: "<file|->",
                    readFile: true,
                    desc: "追加内容：文件路径（`-` = stdin）—— 与 `--append-body` 同义，是同一件事的显式名",
                }),
                appendBodyText: z
                    .string()
                    .optional()
                    .cliOption({
                        placeholder: "<text>",
                        desc: "追加内容：**内联文本**（`--append-body` 的对称项：追加也能直接给文本，不必先落盘）",
                    }),
                parent: z.string().optional().cliOption({ desc: "父任务 URI（空字符串=取消父子关系）" }),
                // 三态：不传=保持原绑定 / `default`（或空串）=**跟随缺省**（取消固定绑定）/ 值=换绑到该人物。
                // 换绑是续聊（会话与上下文不动），新模型**下一轮**生效。
                persona: z
                    .string()
                    .optional()
                    .cliOption({ desc: "agent 人物 id（不传=保持；default=跟随缺省；值=固定绑定，模型下一轮生效）" }),
                change_type: z.string().optional().cliOption({ desc: "变更性质（feat/fix/…；空字符串=清除）" }),
                module: z.string().optional().cliOption({ desc: "模块（空字符串=清除）" }),
                priority: z.string().optional().cliOption({ desc: "优先级 P0-P3（空字符串=清除回未定级）" }),
            },
            output: StatusDataTaskWrite,
        }),
        move: RpcSchema.unary({
            desc: `移动任务（改变父级）`,
            input: {
                uri: z.string().cliArg({ desc: "任务 URI" }),
                parent: z.string().cliArg({ desc: "新父任务 URI（空字符串=取消父子关系）" }),
            },
            output: StatusDataUri,
        }),
        delete: RpcSchema.unary({
            desc: `删除任务`,
            input: {
                uri: z.string().cliArg({ desc: "任务 URI" }),
            },
            output: StatusDataUri,
        }),
    },
});


/**
 * 新模型（##87）：模块自带模块层，app 前缀由宿主给。
 * `server.use({ prefix: "diy", api: taskApi, handlers: { task: … } })`
 * 与上面的 `taskService` 完全等价（后者 = prefix "diy" + 模块层 "task"）。
 */
export const taskApi = RpcSchema.group({ children: { task: taskRoutes } });

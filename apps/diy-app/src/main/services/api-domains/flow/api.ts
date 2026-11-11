/**
 * api-domains/flow/api.ts —— 从 services/api-def.ts 拆出。
 */
import { z } from "zod";
import { RpcSchema } from "@diy-agent/rpc";
import {
    FlowNodeSchema,
    FlowEdgeSchema,
    FlowArtSchema,
    FlowViewSchema,
    FlowArtifactViewSchema,
    FlowThreadsSchema,
    kvList,
} from "../../../../shared/flow";

export const flowRoutes = RpcSchema.group({
    desc: `工作流实例（与任务绑定；状态真源 = 任务目录 flow/state.json，见 ##319）`,
    children: {
        list: RpcSchema.unary({
            desc: `列出可用工作流定义（--instances 改为扫盘列出已绑定的实例）`,
            input: {
                instances: z.boolean().optional().cliOption({ desc: "改为列出各任务上的实例（含位置）" }),
            },
            output: z.object({
                workflows: z.array(
                    z.object({
                        id: z.string(),
                        name: z.string(),
                        entry: z.string(),
                        nodes: z.number(),
                        edges: z.number(),
                    }),
                ),
                instances: z
                    .array(
                        z.object({
                            uri: z.string(),
                            workflowId: z.string(),
                            position: z.string().nullable(),
                            error: z.string().optional(),
                        }),
                    )
                    .optional(),
            }),
        }),

        show: RpcSchema.unary({
            desc: `看实例：当前节点 + 折线 + 出边 + 参数值（含 state.json 与 path.jsonl 的对账，不一致即报）`,
            input: {
                uri: z.string().cliArg({ desc: "任务 URI（projects/<pid>/tasks/<tid>）" }),
            },
            output: FlowViewSchema,
        }),

        view: RpcSchema.unary({
            desc: `取某个节点、某次驻留的产物视图（袋里的 raw → render 插件 → { renderer, payload }）。缺省 = 当前节点的最后一次驻留 —— UI 点折线上任意一步看图靠它`,
            input: {
                uri: z.string().cliArg({ desc: "任务 URI（projects/<pid>/tasks/<tid>）" }),
                node: z.string().optional().cliOption({ desc: "节点 id（缺省 = 当前节点）" }),
                seq: z.number().optional().cliOption({ desc: "第几次驻留（1-based；缺省 = 该节点最后一次）" }),
            },
            output: FlowArtifactViewSchema,
        }),

        artifact: RpcSchema.group({
            desc: `节点产物的**写入**（袋 = 任务目录 flow/artifacts/<节点 id>.json，下标 = 驻留 seq − 1；读走 \`flow view\`）`,
            children: {
                put: RpcSchema.unary({
                    desc: `放一份产物 raw 进袋（写前**先试译一次**：译不出来一个字节都不写）。内容能当 JSON 解析就是那个值，否则原样当字符串`,
                    input: {
                        uri: z.string().cliArg({ desc: "任务 URI（projects/<pid>/tasks/<tid>）" }),
                        node: z.string().cliOption({ desc: "节点 id（产物属于哪个节点）" }),
                        seq: z.number().optional().cliOption({ desc: "第几次驻留（1-based；缺省 = 该节点最后一次）" }),
                        file: z.string().cliOption({
                            placeholder: "<file|->",
                            readFile: true,
                            desc: "产物内容：文件路径（相对路径按当前目录解析），`-` 读 stdin。JSON 能解析就用那个值，否则当字符串",
                        }),
                    },
                    output: FlowArtifactViewSchema,
                }),
            },
        }),

        thread: RpcSchema.group({
            desc: `打回**讨论线程**（##342）：锚点 = 折线上**真发生过的一次打回边**（不造数据）—— 旁注 / 留痕，不参与驱动判据（删了不影响推进）`,
            children: {
                list: RpcSchema.unary({
                    desc: `列讨论线程（真打回边 ∪ 讨论流锚点）：每条线程 = 一个锚点 + 它的发言（append-only）。\`--thread\` 只看那一条`,
                    input: {
                        uri: z.string().cliArg({ desc: "任务 URI（projects/<pid>/tasks/<tid>）" }),
                        thread: z
                            .string()
                            .optional()
                            .cliOption({ desc: "只看这条线程（形如 review->implement#2）；缺省列全部" }),
                    },
                    output: FlowThreadsSchema,
                }),
                post: RpcSchema.unary({
                    desc: `往线程里发一条言（三出口里的 resolved / escalate 都走它）。**锚点必须在折线上確有那次打回**（假锚点拒）；正文空 ⇒ 拒`,
                    input: {
                        uri: z.string().cliArg({ desc: "任务 URI（projects/<pid>/tasks/<tid>）" }),
                        thread: z
                            .string()
                            .cliOption({ desc: "线程 id（形如 review->implement#2，见 `flow thread list`）" }),
                        text: z.string().cliOption({
                            placeholder: "<file|->",
                            readFile: true,
                            desc: "发言正文：文件路径（相对路径按当前目录解析）或 `-` 读 stdin",
                        }),
                        type: z
                            .enum(["note", "resolved", "escalate"])
                            .default("note")
                            .optional()
                            .cliOption({
                                desc: "note=普通发言（缺省）/ resolved=宣布线程已解决（位置不动）/ escalate=升级人裁决",
                            }),
                        author: z.string().optional().cliOption({ desc: "发言作者（缺省 cli；升级人裁决常写 human）" }),
                    },
                    output: FlowThreadsSchema,
                }),
            },
        }),

        start: RpcSchema.unary({
            desc: `建实例：绑定工作流 + 参数值过内核闸门（**不自动进入**入口，首次 advance 才进入；已有**未进入**实例会被重写，已进入则拒 —— 换工作流/换配置 = 另起一次运行）`,
            input: {
                uri: z.string().cliArg({ desc: "任务 URI" }),
                workflow: z.string().optional().cliOption({ desc: "工作流 id（见 `diy flow list`）" }),
                param: kvList().optional().cliOption({ desc: "参数值 `节点 id.局部名=值`（缺省用声明里的 default）" }),
            },
            output: FlowViewSchema,
        }),

        finish: RpcSchema.unary({
            desc: `收尾：宣布实例已走完（置 done）。**只允许在结构终端节点上**（没有 next 出边）；guard 那一半由宣布者担责（prompt: 不可观测）`,
            input: {
                uri: z.string().cliArg({ desc: "任务 URI" }),
                note: z.string().optional().cliOption({ desc: "审计正文的后缀备注（不参与领域态）" }),
            },
            output: FlowViewSchema,
        }),

        advance: RpcSchema.unary({
            desc: `推进：走 next 边（首次 = 进入入口节点；不许跳步）`,
            input: {
                uri: z.string().cliArg({ desc: "任务 URI" }),
                to: z.string().optional().cliOption({ desc: "目标节点 id" }),
                ref: kvList().optional().cliOption({ desc: "宿主关联（写进 Visit.ref）" }),
                note: z.string().optional().cliOption({ desc: "审计正文的后缀备注（不参与领域态）" }),
            },
            output: FlowViewSchema,
        }),

        bounce: RpcSchema.unary({
            desc: `打回：走 bounce 边（目标节点再驻留一次，不新建节点）。带 \`--opinion\` 时把**意见正文**一等落进讨论流（挂这次打回的锚点）`,
            input: {
                uri: z.string().cliArg({ desc: "任务 URI" }),
                to: z.string().optional().cliOption({ desc: "目标节点 id" }),
                ref: kvList().optional().cliOption({ desc: "宿主关联（写进 Visit.ref）" }),
                note: z.string().optional().cliOption({ desc: "审计正文的后缀备注（不参与领域态）" }),
                opinion: z.string().optional().cliOption({
                    placeholder: "<file|->",
                    readFile: true,
                    desc: "意见正文（##342）：落进讨论流并挂在这次打回的锚点上；文件路径或 `-` 读 stdin。缺省只落审计后缀（--note）",
                }),
                author: z.string().optional().cliOption({ desc: "发言作者（缺省 cli；驱动环起的轮次用 agent 标识）" }),
            },
            output: FlowViewSchema,
        }),

        params: RpcSchema.group({
            desc: `实例参数值（权威 = flow/state.json）`,
            children: {
                get: RpcSchema.unary({
                    desc: `看参数值 + 参数声明（供表单 / 文档渲染）`,
                    input: { uri: z.string().cliArg({ desc: "任务 URI" }) },
                    output: z.object({
                        uri: z.string(),
                        workflowId: z.string(),
                        workflowName: z.string(),
                        authority: z.string().describe("权威文件（state.json 的绝对路径）"),
                        entered: z.boolean(),
                        values: z.record(z.string(), z.any()),
                        schema: z.array(z.any()),
                        defaults: z.record(z.string(), z.any()),
                    }),
                }),
                set: RpcSchema.unary({
                    desc: `改参数值（**只在尚未进入时**允许：换配置 = 另起一次运行）`,
                    input: {
                        uri: z.string().cliArg({ desc: "任务 URI" }),
                        param: kvList().optional().cliOption({ desc: "新的参数值（未给的项回落声明里的 default）" }),
                    },
                    output: FlowViewSchema,
                }),
            },
        }),

        prompt: RpcSchema.unary({
            desc: `按当前节点装配提示词（hint 内核插值 + 既有 prompt-registry 渲染；只读）`,
            input: { uri: z.string().cliArg({ desc: "任务 URI" }) },
            output: z.object({
                uri: z.string(),
                workflowId: z.string(),
                nodeId: z.string(),
                nodeName: z.string(),
                hint: z.string().describe("插值后的节点提示（内核 renderHint）"),
                prompt: z.string().describe("装配结果（prompt-registry 渲染的节）"),
                bytes: z.number(),
            }),
        }),
        /**
         * ##341 起 flow 域多两条**驱动**命令（一个系统推、一个自动轮转）。
         * 与既有命令的分别：`advance` / `bounce` 是**宣布**（不评价 guard），它们走内核的**求值**那条路。
         */
        step: RpcSchema.unary({
            desc: `系统推一步：当前节点 guard 全可观测 ⇒ 真求值（pred:/action:）并自动推进；尚未进入 ⇒ 进入入口。含 prompt: 的节点一步都不推（返回 awaiting-actor）`,
            input: {
                uri: z.string().cliArg({ desc: "任务 URI" }),
                cwd: z
                    .string()
                    .optional()
                    .cliOption({ desc: "命令类插件（pred:/action:）的工作目录；缺省 = 应用进程 cwd" }),
            },
            output: z.object({
                status: z
                    .enum(["moved", "done", "stuck", "awaiting-actor"])
                    .describe("moved=推成了 / done=走完 / stuck=停在边上 / awaiting-actor=这一步要 actor 宣布"),
                to: z.string().nullable(),
                kind: z.enum(["entry", "next", "bounce"]).nullable(),
                reason: z.string().describe("stuck / awaiting-actor 的原因（其余为空串）"),
                view: FlowViewSchema,
            }),
        }),
        run: RpcSchema.serverStream({
            desc: `驱动环（##341）：按 next.mode 三分流自动轮转 —— system 真求值自动推（绿线）· actor+agent 起一轮 agent 收结论后推进/打回 · actor+human 停下等人。**客户端断开即中断**（可停）；判据一律读 flow show（幂等，重复 run 接着走）`,
            input: {
                uri: z.string().cliArg({ desc: "任务 URI" }),
                maxSteps: z.number().optional().cliOption({ desc: "步数护栏（缺省 32）" }),
                cwd: z.string().optional().cliOption({ desc: "命令类插件的工作目录；缺省 = 应用进程 cwd" }),
            },
            output: z.string().describe("逐行 JSON 帧：{kind:'step'|'turn'|'stop', …}（给人看的输出，不是真源）"),
        }),
    },
});


/**
 * 新模型（##87）：模块自带模块层，app 前缀由宿主给。
 * `server.use({ prefix: "diy", api: flowApi, handlers: { flow: … } })`
 * 与上面的 `flowService` 完全等价（后者 = prefix "diy" + 模块层 "flow"）。
 */
export const flowApi = RpcSchema.group({ children: { flow: flowRoutes } });

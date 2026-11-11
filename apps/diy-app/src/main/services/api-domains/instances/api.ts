/**
 * api-domains/instances/api.ts —— 2026-11-06 从 services/api-def.ts 拆出。
 *
 * import 待手工补（各域依赖不同）。
 */
import { z } from "zod";
import { RpcSchema, defineService } from "@diy-agent/rpc";
import { InstanceRowSchema, InstanceSelfSchema, RevealResultSchema } from "../../../../shared/instance-row";

export const instancesRoutes = RpcSchema.group({
    desc: `实例大盘（扫描本机 diy 实例 + 唤起指定实例）`,
    children: {
        ls: RpcSchema.unary({
            desc: `列出本机所有 diy 实例（对齐表格文本，供人读；程序读请用 instances.list）`,
            input: {},
            output: z.string().describe("表格文本（含表头与汇总行）"),
        }),
        list: RpcSchema.unary({
            desc: `列出本机所有 diy 实例（结构化行，供 UI / 程序消费）`,
            input: {},
            output: z.object({ rows: z.array(InstanceRowSchema) }),
        }),
        self: RpcSchema.unary({
            desc: `本实例自报身份 + 活跃会话 + 窗口状态（别的实例扫描时调用；无窗口实例 window=null）`,
            input: {},
            output: InstanceSelfSchema,
        }),
        reveal: RpcSchema.unary({
            desc: `唤起**本**实例窗口（重建 + 前置 + 全屏；由别的实例的 instances.focus 调用）`,
            input: {},
            output: RevealResultSchema,
        }),
        focus: RpcSchema.unary({
            desc: `
            唤起指定实例（窗口前置 + 全屏）

            主路 = 让目标实例**自己** show+focus+setFullScreen（RPC，确定且无需系统权限）；
            RPC 不可用（无端口 / 无响应）时降级到**系统级唤起**（平台支持时才可用；macOS 上需 Automation 权限，可能弹窗）。
            两路都失败即报错 —— 不静默吞。
            `,
            input: {
                pid: z.number().optional().cliOption({ desc: "目标实例 pid（与 --port 二选一）" }),
                port: z.number().optional().cliOption({ desc: "目标实例 RPC 端口（与 --pid 二选一）" }),
            },
            output: z.object({
                pid: z.number().nullable(),
                port: z.number().nullable(),
                via: z.string().describe("rpc（目标实例自己唤起）| system（系统级降级）"),
                reason: z.string(),
            }),
        }),
    },
});

export const instancesService = defineService({ name: "diy.instances", api: instancesRoutes });

/**
 * 新模型（##87）：模块自带模块层，app 前缀由宿主给。
 * `server.use({ prefix: "diy", api: instancesApi, handlers: { instances: … } })`
 * 与上面的 `instancesService` 完全等价（后者 = prefix "diy" + 模块层 "instances"）。
 */
export const instancesApi = RpcSchema.group({ children: { instances: instancesRoutes } });

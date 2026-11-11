/**
 * api-domains/watch/api.ts —— 2026-11-06 从 services/api-def.ts 拆出。
 *
 * import 待手工补（各域依赖不同）。
 */
import { z } from "zod";
import { RpcSchema } from "@diy-agent/rpc";

export const watchRoutes = RpcSchema.group({
    desc: `文件系统监控（projects/ 增删改 → 实时推送）`,
    children: {
        fileChange: RpcSchema.serverStream({
            desc: `文件变更事件流 — 持续订阅，FileWatcher 检测到 projects/ 下文件变更后 yield`,
            input: {},
            output: z.object({
                event: z.string().describe("变更类型：task-change（projects/ 下任务树相关变更）"),
                ts: z.number().describe("变更发生时间戳（ms）"),
            }),
        }),
    },
});


/**
 * 新模型（##87）：模块自带模块层，app 前缀由宿主给。
 * `server.use({ prefix: "diy", api: watchApi, handlers: { watch: … } })`
 * 与上面的 `watchService` 完全等价（后者 = prefix "diy" + 模块层 "watch"）。
 */
export const watchApi = RpcSchema.group({ children: { watch: watchRoutes } });

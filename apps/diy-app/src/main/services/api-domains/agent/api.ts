/**
 * api-domains/agent/api.ts — `agent` 域的契约（**组合** persona / local / usage）
 *
 * 2026-11-06 从 `services/api-def.ts` 拆出。按用户定的方案 B：**内部再分**，
 * 因为 agent 整段 736 行 —— 全塞一个文件等于没拆。
 *
 * ```
 * agent/
 * ├── api.ts      ← 本文件：只做组合
 * ├── persona.ts  ← 人物（配置实体，任务持引用）
 * ├── local.ts    ← 本地自定义 agent（ai-sdk 块协议；含 steer / compact） 680 行
 * └── usage.ts    ← token 用量（单条 unary，不是子组）
 * ```
 */
import { RpcSchema, defineService } from "@diy-agent/rpc";
import { personaRoutes } from "./persona";
import { localRoutes } from "./local";
import { usageRoute } from "./usage";

export const agentRoutes = RpcSchema.group({
    desc: `Agent 管理`,
    children: {
        persona: personaRoutes,
        local: localRoutes,
        usage: usageRoute,
    },
});

export const agentService = defineService({ name: "diy.agent", api: agentRoutes });

/**
 * 新模型（##87）：模块自带模块层，app 前缀由宿主给。
 * `server.use({ prefix: "diy", api: agentApi, handlers: { agent: … } })`
 * 与上面的 `agentService` 完全等价（后者 = prefix "diy" + 模块层 "agent"）。
 */
export const agentApi = RpcSchema.group({ children: { agent: agentRoutes } });

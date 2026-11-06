/**
 * api.ts — workbench 对外的 RPC 契约（**唯一真源**）
 *
 * 2026-11-06 从 `protocol.ts` 分流出来：
 *   · `protocol.ts` 留 `rendererApi`（意图测试方向）与类型 re-export
 *   · 这里只放 workbench 自己的契约 + service 描述符
 *
 * 为什么单独成文：`gen-service-types` 的扫描约定是 `<pkg>/src/api.ts`，
 * 生成物落到 `src/gen/api.generated.d.ts`。契约和生成的类型分居两处，
 * 手写代码与派生物互不打扰。
 *
 * ⚠️ **模块名与方法路径是跨进程契约**：改名 = 老客户端全挂（同 protobuf 的字段号）。
 */
import { z } from "zod";
import { RpcSchema, defineService } from "@diy-agent/rpc";

/** 页面描述（与 `./page.js` 的 PageInfo 同形；这里给 renderer 侧的 zod 校验用） */
const pageInfoSchema = z.object({
    id: z.string(),
    title: z.string(),
    description: z.string().optional(),
});

export const workbenchRoutes = RpcSchema.router({
    page: RpcSchema.router({
        /** 有哪些页面（侧栏用它渲染入口） */
        list: RpcSchema.unary({ input: {}, output: z.array(pageInfoSchema) }),
        /**
         * 调某个页面的一个方法（转发到插件）。
         *
         * `args` 故意是 `unknown` —— 每个方法自己的形状由插件定义，这里不做二次校验
         * （插件内部已有 `recordOf` / `requiredString` 那套）。rpc 层只保证**送达**。
         */
        invoke: RpcSchema.unary({
            input: {
                pageId: z.string(),
                method: z.string(),
                args: z.unknown().optional(),
            },
            output: z.unknown(),
        }),
    }),
});

export type WorkbenchApi = typeof workbenchRoutes;

/**
 * **模块化的 API 单元**。
 *
 * 两端都用**这一个值** —— 模块名与路由不可能漂移：
 *   · 服务端：`workbenchService.bind(server, { page: { list, invoke } })`
 *   · 客户端：`workbenchService.use(client)`
 */
export const workbenchService = defineService({
    name: "diy.ui.workbench",
    api: workbenchRoutes,
});

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

// ═══════════════════════════════════════════════════
//  renderer 方向（意图测试）
// ═══════════════════════════════════════════════════

/**
 * **renderer 侧**的契约（main → renderer）。与 `workbenchRoutes` 方向相反：
 * 上面的由主进程实现、页面调用；这里由页面实现、主进程调用。
 *
 * 用途是**意图测试** —— 测试从外面发指令直接驱动 UI 内部状态，不走真实鼠标：
 *
 * ```ts
 * await ui.fill('.chat-panel input', 'name');   // 直接设值
 * await ui.click('.chat-primary');               // 派发事件（不经命中测试）
 * await ui.waitState('bots.length', 1);          // 等信号填充
 * ```
 *
 * 与 E2E 的分工：E2E 验「显示对不对」（拖拉 / 遮挡 / 大小），走真鼠标、慢、少；
 * 意图测试验「逻辑对不对」，走这条通道、快、多。见 `docs/testing.md`。
 */
export const rendererRoutes = RpcSchema.router({
    ui: RpcSchema.router({
        /** 给一个输入框设值并派发 input/change（模拟用户输入） */
        fill: RpcSchema.unary({
            input: { selector: z.string(), value: z.string() },
            output: z.void(),
        }),
        /** 点击一个元素（直接 dispatchEvent，不经过命中测试） */
        click: RpcSchema.unary({
            input: { selector: z.string() },
            output: z.void(),
        }),
        /**
         * 等某个状态成立（轮询页面里的 `window.__diyTestState`）。
         *
         * 为什么不用「等 DOM 出现」：DOM 出现 ≠ 数据到位。状态断言才是意图级的，
         * 且不受动画 / 渲染批次影响。
         */
        waitState: RpcSchema.unary({
            input: { path: z.string(), equals: z.unknown(), timeoutMs: z.number().default(5000) },
            output: z.void(),
        }),
        /** 读当前状态快照（测试断言用；不是给 UI 自己用的） */
        readState: RpcSchema.unary({ input: { path: z.string() }, output: z.unknown() }),
    }),
});

export type RendererApi = typeof rendererRoutes;

/**
 * renderer 侧的 service。
 *
 * 换写法的收益与 workbench 同：两端用**同一个值**，前缀 `diy.ui.renderer.` 不可能漂移。
 */
export const rendererService = defineService({
    name: "diy.ui.renderer",
    api: rendererRoutes,
});

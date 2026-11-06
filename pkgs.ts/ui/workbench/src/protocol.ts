// protocol.ts — 主进程 ↔ renderer 的 **RPC 契约**（2026-11-04，B1）
//
// 之前是手写 IPC：两个字符串常量 + `ipcMain.handle` / `ipcRenderer.invoke`。
// 换到 @diy-agent/rpc 换来四件事：
//   ① main → renderer 通道（自研 IPC 只有 renderer → main 单向）
//   ② 取消（AbortSignal 透传 — 现在 renderer 点「停止」到不了主进程）
//   ③ 流式（StreamHandle — 现在 send 只能等整轮结束拿快照）
//   ④ Web 迁移（rpc 已有 http / ws transport，换 transport 即可）
//
// 为什么保留 `{ pageId, method, args }` 这个形状（方案 A）：
//   插件方法是**动态**的（pageId / method 运行时决定），而 rpc 的 router 是静态树。
//   两个办法：① 每个方法注册成一个 RPC 路径 ② 保留 invoke 这层
//   选 ② —— 调用方一行不用改，收益（取消/流/双向）已经拿到；
//   将来如果要做「按方法粒度鉴权/审计」，再升级成 ①（那时才需要静态路径）。

import { z } from "zod";
import { RpcSchema, defineService } from "@diy-agent/rpc";

/** 页面描述（与 `./page.ts` 的 PageInfo 同形；这里给 renderer 侧的 zod 校验用） */
const pageInfoSchema = z.object({
    id: z.string(),
    title: z.string(),
    description: z.string().optional(),
});

const workbenchRoutes = RpcSchema.router({
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
 * **模块化的 API 单元**（2026-11-06，@diy-agent/rpc 的 defineService）。
 *
 * 为什么不再直接导出 `workbenchApi`：
 *   · 以前所有 procedure 共用全局扁平命名空间（`page.list` / `task.get`），
 *     两个模块都有 `list` 就撞车
 *   · 客户端必须 `createTypedClient(client, 整棵树)`，想用 workbench 三个方法
 *     得先持有全仓 api 定义
 *
 * 现在：两端都用**这一个值** —— 模块名与路由不可能漂移。
 */
export const workbenchService = defineService({
    name: "diy.ui.workbench",
    api: workbenchRoutes,
});

/**
 * **renderer 侧**方法的契约（main → renderer，B2）。
 *
 * 与 `workbenchApi` 方向相反：上面的由主进程实现、页面调用；这里由页面实现、主进程调用。
 * 用途是**意图测试** —— 测试从外面发指令，直接驱动 UI 内部状态，不走真实鼠标：
 *
 * ```ts
 * await ui.fill('.chat-panel input', 'name');   // 直接设值
 * await ui.click('.chat-primary');               // 派发事件（不经命中测试）
 * await ui.waitState('bots.length', 1);          // 等信号填充
 * ```
 *
 * 与 E2E 的分工：E2E 验「显示对不对」（拖拉/遮挡/大小），走真鼠标、慢、少；
 * 意图测试验「逻辑对不对」，走这条通道、快、多。见 docs/testing.md。
 */
export const rendererApi = RpcSchema.router({
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

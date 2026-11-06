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
import { RpcSchema } from "@diy-agent/rpc";

// workbench 自己的契约在 `./api.js`（`gen-service-types` 扫 `<pkg>/src/api.ts`），
// 这里 re-export 保住既有的 `from "./protocol.js"` 引用。
export { workbenchService, workbenchRoutes, type WorkbenchApi } from "./api.js";


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

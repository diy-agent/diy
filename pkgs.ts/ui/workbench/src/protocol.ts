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

/** 页面描述（与 `./page.ts` 的 PageInfo 同形；这里给 renderer 侧的 zod 校验用） */
const pageInfoSchema = z.object({
    id: z.string(),
    title: z.string(),
    description: z.string().optional(),
});

export const workbenchApi = RpcSchema.router({
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

export type WorkbenchApi = typeof workbenchApi;

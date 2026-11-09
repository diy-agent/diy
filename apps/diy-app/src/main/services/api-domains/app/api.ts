/**
 * api-domains/app/api.ts —— `app` 域：进程/环境自述
 *
 * 2026-11 从 api-def 的两个顶层 unary 合并而来：
 * · `getAppStatus`（pid / uptime / heapUsed）
 * · `getAppInfo`（port / diyHome / env / branch / 版本 / 系统内存 …）
 *
 * **为什么合并**：两者都回答「这个进程现在是什么」，字段重叠 pid；
 * 更麻烦的是**两个 `memory` 同名不同物**（进程堆 vs 系统内存）——
 * 合并后拆成 `heapUsed`（字节，程序判据）与 `systemMemory`（人读），语义不再混淆。
 */
import { z } from "zod";
import { RpcSchema, defineService } from "@diy-agent/rpc";

export const appRoutes = RpcSchema.group({
    desc: `应用自述（进程 / 环境 / 版本）`,
    children: {
        info: RpcSchema.unary({
            desc: `应用信息：进程（pid/uptime/heapUsed）+ 环境（port/diyHome/env/branch/cache/userData/cdp）+ 版本 + 系统内存`,
            input: {},
            // 形状与老 `getAppInfo` 1:1：**不包** {status, data}（那个 wrapper 是给成对命令用的）
            output: z.object({
                    pid: z.number(),
                    uptime: z.number().describe("进程已运行秒数"),
                    heapUsed: z.number().describe("进程堆占用（字节；程序判据用它，人读用 systemMemory）"),
                    port: z.number().describe("RPC 端口（0 = 未起）"),
                    diyHome: z.string(),
                    diyHomeDisplay: z.string().describe("家目录缩写后的展示形式"),
                    repoDisplay: z.string().describe("代码仓展示形式（哪个 worktree / 分支）"),
                    env: z.string().describe("DIY_ENV：production / development / test"),
                    branch: z.string().describe("当前运行代码所在 git 分支（拿不到时空串）"),
                    cache: z.string(),
                    userData: z.string().describe("Electron userData 目录（非 Electron 时给占位）"),
                    cdp: z.string().describe("CDP 调试地址（未启用 / serve 模式为空串）"),
                    electron: z.string().describe("非 Electron 环境给可读占位而不是 undefined"),
                    node: z.string(),
                    chrome: z.string(),
                    platform: z.string(),
                    systemMemory: z.object({ totalGb: z.string(), freeGb: z.string() }),
            }),
        }),
    },
});

export const appService = defineService({ name: "diy.app", api: appRoutes });

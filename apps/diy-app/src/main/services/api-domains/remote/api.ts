/**
 * api-domains/remote/api.ts —— 2026-11-06 从 services/api-def.ts 拆出。
 *
 * import 待手工补（各域依赖不同）。
 */
import { z } from "zod";
import { RpcSchema, defineService } from "@diy-agent/rpc";
import { DiscoverFailureSchema, RemoteDiscoverResultSchema, RemotePingResultSchema, RemoteSelfSchema } from "../../../../shared/remote";

export const remoteRoutes = RpcSchema.group({desc: `远程实例（本机 /ping 身份 + local·mdns·tailscale·manual 四路发现；无鉴权，仅限内网）`,
        children: {
          self: RpcSchema.unary({
            desc: `本实例的远程身份与 /ping 端点（id 永不变；displayName 可改）`,
            input: {},
            output: RemoteSelfSchema,
          }),
          rename: RpcSchema.unary({
            desc: `改本实例显示名（id 不变；空串 = 回落 hostname）`,
            input: { name: z.string().cliArg({ desc: "新显示名（空串 = 回落 hostname）" }) },
            output: RemoteSelfSchema,
          }),
          ping: RpcSchema.unary({
            desc: `ping 一台 diy 实例的 /ping（拿身份 / 判存活；失败返回 ok:false 而不是报错）`,
            input: {
              endpoint: z.string().cliArg({ desc: "目标基址，如 http://192.168.1.5:9400（缺端口时嘟 9400）" }),
              timeoutMs: z.number().optional().cliOption({ desc: "超时毫秒（缺省 1500）" }),
            },
            output: RemotePingResultSchema,
          }),
          discover: RpcSchema.unary({
            desc: `发现可用 diy 实例（人读列表；合并去重后列出来选，不自动连接）`,
            input: {
              sources: z.union([z.string(), z.array(z.string())]).optional().cliOption({
                desc: "只跑这几路（逗号分隔或 JSON 数组；缺省 local,mdns,tailscale，给了 manual 时再加 manual）",
              }),
              manual: z.union([z.string(), z.array(z.string())]).optional().cliOption({
                desc: "手动输入的地址（逗号分隔或 JSON 数组；缺端口时嘟 9400）",
              }),
              mdnsTimeoutMs: z.number().optional().cliOption({ desc: "mDNS 收集时长毫秒（缺省 1500）" }),
            },
            output: z.string().describe("人读列表（无结果时给一句提示）"),
          }),
          list: RpcSchema.unary({
            desc: `发现可用 diy 实例（结构化行，供 UI / 程序消费）`,
            input: {
              sources: z.union([z.string(), z.array(z.string())]).optional().cliOption({ desc: "只跑这几路（同上）" }),
              manual: z.union([z.string(), z.array(z.string())]).optional().cliOption({ desc: "手动输入的地址（同上）" }),
              mdnsTimeoutMs: z.number().optional().cliOption({ desc: "mDNS 收集时长毫秒" }),
            },
            output: z.object({
              rows: RemoteDiscoverResultSchema.shape.rows,
              errors: z.array(DiscoverFailureSchema),
            }),
          }),
        },});

export const remoteService = defineService({ name: "diy.remote", api: remoteRoutes });

/**
 * 新模型（##87）：模块自带模块层，app 前缀由宿主给。
 * `server.use({ prefix: "diy", api: remoteApi, handlers: { remote: … } })`
 * 与上面的 `remoteService` 完全等价（后者 = prefix "diy" + 模块层 "remote"）。
 */
export const remoteApi = RpcSchema.group({ children: { remote: remoteRoutes } });

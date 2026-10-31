// 远程实例的共享契约（renderer / CLI / main 同一份 zod schema）。
//
// 形状的真源是 `@diy-agent/remote` 的 TS 类型（`PingInfo` / `DiscoveredInstance`）；
// 这里只负责把它们变成 RPC 能给出去、UI 能校验的运行时 schema。两处必须同步改。

import { z } from "zod";

/** `GET /ping` 的响应体（无鉴权，字段只到「能识别 + 能判断活着」为止） */
export const PingInfoSchema = z.object({
    id: z.string().describe("永不变的实例 id（首次启动生成，存 $DIY_HOME/instance-id）"),
    displayName: z.string().describe("可改的显示名（缺省 hostname）"),
    variant: z.string().describe("产物变体：prod / lab / test / preview"),
    version: z.string().describe("实例版本"),
    pid: z.number().describe("进程 pid"),
    startedAt: z.string().describe("进程启动时刻（ISO）"),
    uptimeMs: z.number().describe("已运行毫秒数"),
});

/** 一条发现结果（合并去重后的一行） */
export const DiscoveredRowSchema = z.object({
    id: z.string().nullable().describe("实例 id；发现阶段未知为 null"),
    displayName: z.string().nullable().describe("显示名；未知为 null"),
    endpoint: z.string().describe("基址（http://host:port，不含 /ping）"),
    source: z.string().describe("最优来源：manual / local / tailscale / mdns"),
    sources: z.array(z.string()).describe("参与合并的全部来源（按可信度排序）"),
    meta: z.record(z.string(), z.string()).optional().describe("发现器附带的证据（variant / pid / host…）"),
});

/** 一路发现器失败（不影响别的路） */
export const DiscoverFailureSchema = z.object({
    source: z.string().describe("哪一路：local / mdns / tailscale / manual"),
    message: z.string().describe("人读一句话"),
});

export const RemoteDiscoverResultSchema = z.object({
    rows: z.array(DiscoveredRowSchema).describe("合并去重后的候选（列给用户选，不自动连接）"),
    text: z.string().describe("人读列表（`diy remote discover` 的出口）"),
    errors: z.array(DiscoverFailureSchema).describe("失败的那几路（空数组 = 全部正常）"),
});

export const RemotePingResultSchema = z.object({
    ok: z.boolean().describe("是否拿到合法的 /ping 响应"),
    info: PingInfoSchema.nullable().describe("成功时的身份载荷"),
    error: z.string().nullable().describe("失败原因（人读）"),
    elapsedMs: z.number().describe("耗时（毫秒）"),
});

export const RemoteSelfSchema = z.object({
    id: z.string().describe("本实例 id（永不变）"),
    displayName: z.string().describe("本实例显示名"),
    variant: z.string().describe("产物变体"),
    endpoint: z.string().describe("本实例对外可连基址（绑 0.0.0.0 时给 127.0.0.1）"),
    host: z.string().describe("实际绑定地址"),
    port: z.number().describe("/ping 实际端口"),
    mdns: z.boolean().describe("是否已通过 mDNS 广播"),
    ping: PingInfoSchema.describe("本实例 /ping 会返回的载荷"),
});

export type DiscoveredRow = z.infer<typeof DiscoveredRowSchema>;
export type DiscoverFailure = z.infer<typeof DiscoverFailureSchema>;
export type RemoteDiscoverResult = z.infer<typeof RemoteDiscoverResultSchema>;
export type RemotePingResult = z.infer<typeof RemotePingResultSchema>;
export type RemoteSelf = z.infer<typeof RemoteSelfSchema>;

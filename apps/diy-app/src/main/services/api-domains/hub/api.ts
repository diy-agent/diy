/**
 * api-domains/hub/api.ts —— 2026-11-06 从 services/api-def.ts 拆出。
 *
 * import 待手工补（各域依赖不同）。
 */
import { z } from "zod";
import { RpcSchema, defineService } from "@diy-agent/rpc";

export const hubRoutes = RpcSchema.group({desc: `Hub 配对（邀请码 + Owner 审批 + Token 长连；地址即身份）`,
        children: {
          init: RpcSchema.unary({
            desc: `生成 / 复用 Hub 身份（私钥进系统钥匙串；hub.json 只有公钥）并记下对外地址`,
            input: {
              endpoint: z.string().optional().cliOption({ desc: "对外真实地址，如 https://c-mac.gute-fish.ts.net/hub" }),
              tlsCert: z.string().optional().cliOption({ desc: "TLS 证书路径（tailscale cert 之类）" }),
              tlsKey: z.string().optional().cliOption({ desc: "TLS 私钥路径" }),
            },
            output: z.object({
              status: z.string(),
              data: z.object({
                hubNodeId: z.string(),
                domainId: z.string(),
                publicKey: z.string(),
                endpoint: z.string().nullable(),
              }),
            }),
          }),
          invite: RpcSchema.unary({
            desc: `建邀请：6 位码 + 真实地址 + 邀请 URL（二维码内容就是 URL，不含码）。--auto-approve = 一键连接（60 秒有效，无需输码/批准）`,
            input: {
              autoApprove: z.boolean().optional().cliOption({ desc: "一键连接：卫星点开链接直接连上，不走批准（--auto-approve）" }),
              protocol: z
                .enum(["code", "pinned-key"])
                .optional()
                .cliOption({ desc: "配对协议：code(6位码) / pinned-key(公钥指纹 TOFU)（--protocol）" }),
            },
            output: z.object({
              status: z.string(),
              data: z.object({
                code: z.string(),
                address: z.string(),
                inviteUrl: z.string(),
                expiresAt: z.string(),
              }),
            }),
          }),
          pending: RpcSchema.unary({
            desc: `待审批的配对申请（人据此决定放不放进来）`,
            input: {},
            output: z.object({
              status: z.string(),
              data: z.object({
                requests: z.array(
                  z.object({
                    requestId: z.string(),
                    nodeId: z.string(),
                    displayName: z.string(),
                    requestedAt: z.string(),
                  }),
                ),
              }),
            }),
          }),
          approve: RpcSchema.unary({
            desc: `批准配对申请（Token 经卫星的长轮询回到它自己的钥匙串，这里不回显）`,
            input: { requestId: z.string().cliArg({ desc: "配对申请 id" }) },
            output: z.object({
              status: z.string(),
              data: z.object({ nodeId: z.string(), displayName: z.string(), requestStatus: z.string() }),
            }),
          }),
          reject: RpcSchema.unary({
            desc: `拒绝配对申请`,
            input: { requestId: z.string().cliArg({ desc: "配对申请 id" }) },
            output: z.object({ status: z.string(), data: z.object({ requestStatus: z.string() }) }),
          }),
          revoke: RpcSchema.unary({
            desc: `撤销已配对成员（断现有连接 + 拒绝重连 403）`,
            input: { nodeId: z.string().cliArg({ desc: "卫星 node id" }) },
            output: z.object({ status: z.string(), data: z.object({ nodeId: z.string(), membershipStatus: z.string() }) }),
          }),
          status: RpcSchema.unary({
            desc: `Hub 身份 + 已配对成员（在线数 / 已撤销）`,
            input: {},
            output: z.object({
              status: z.string(),
              data: z.object({
                identity: z
                  .object({
                    hubNodeId: z.string(),
                    domainId: z.string(),
                    publicKey: z.string(),
                    endpoint: z.string().optional(),
                    createdAt: z.string(),
                  })
                  .nullable(),
                memberships: z.array(
                  z.object({
                    nodeId: z.string(),
                    displayName: z.string(),
                    status: z.string(),
                    online: z.number(),
                    createdAt: z.string(),
                  }),
                ),
              }),
            }),
          }),
          join: RpcSchema.unary({
            desc: `卫星入网：不带 --code 只显示要连接的地址（不发秘密）；带 --code 才提交申请并等待批准`,
            input: {
              url: z.string().cliArg({ desc: "邀请 URL（https://host/hub/pair?inv=...）" }),
              code: z.string().optional().cliOption({ desc: "主控屏幕上的 6 位码；不给则只显示地址" }),
              waitMs: z.number().optional().cliOption({ desc: "等待批准毫秒数（缺省 120000）" }),
              autoJoin: z.boolean().optional().cliOption({ desc: "一键连接：邀请自带授权，不需要输码（--auto-join）" }),
              protocol: z
                .enum(["code", "pinned-key"])
                .optional()
                .cliOption({ desc: "配对协议（--protocol）；pinned-key 时不需要 code" }),
            },
            output: z.object({
              status: z.string(),
              data: z.object({
                preview: z.boolean(),
                address: z.string(),
                hubNodeId: z.string(),
                domainId: z.string().optional(),
                joinStatus: z.string().optional(),
                membershipId: z.string().optional(),
                endpoint: z.string().optional(),
              }),
            }),
          }),
          link: RpcSchema.unary({
            desc: `卫星侧本地连接信息（link.json；不含 token）`,
            input: {},
            output: z.object({
              status: z.string(),
              data: z
                .object({
                  domainId: z.string(),
                  hubNodeId: z.string(),
                  hubPublicKey: z.string(),
                  hubEndpoint: z.string(),
                })
                .nullable(),
            }),
          }),
          connection: RpcSchema.unary({
            desc: `卫星侧长连状态（##511）：idle / no-token / connecting / online / offline / revoked —— 只有 online 才是真连上`,
            input: {},
            output: z.object({
              status: z.string(),
              data: z.object({
                state: z.string().describe("idle / no-token / connecting / online / offline / revoked"),
                hubNodeId: z.string().nullable(),
                hubEndpoint: z.string().nullable(),
                attempt: z.number().optional(),
                reason: z.string().optional(),
              }),
            }),
          }),
        },});

export const hubService = defineService({ name: "diy.hub", api: hubRoutes });

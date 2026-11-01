// api.ts — apps/web 的**声明式 RPC 定义**（纯 zod + @diy-agent/rpc，无 IO、无 Node API）。
//
// 为什么走 rpc 而不手写路由（##485 用户裁决）：
//   · 与 diy-app 的 electron IPC 同一套 Envelope / 声明式方法：错误码、入参校验、超时语义统一；
//   · **换 binding 不改业务**：本文件与 pages.ts / auth.ts 都不认识传输层 —— 服务端既能把同一份
//     router 挂到 ChannelServerBinding（浏览器走 WebSocket），也能挂到 HttpServerBinding
//     （Node 客户端走 h2c；见 tests/http-binding.test.ts 与 server.ts 的 startHttpRpc）。
//
// 方法命名 `web.<域>.<方法>`（与 `diy.app.*` 同一口径；全名 = 拍平的路径）。
//
// 授权分两类，别混：
//   · `web.auth.*`  —— 建立授权关系本身（request / status / login 对任何人开放；
//                      pending / approve / deny / revoke / tokens 是**副方管理面**，仅回环）；
//   · `web.page.*`  —— 真正的业务调用（页面清单 / 页面方法），**必须带有效 token**。

import { RpcSchema } from '@diy-agent/rpc';
import { z } from 'zod';

/** 缺省 Subject（主方自报的身份地址；格式见 ##484） */
const SubjectSchema = z.string().min(1).max(200);

const RequestStatusSchema = z.enum(['pending', 'approved', 'denied']);

/** `web.auth.request` —— ① 主方 → 副方：连接请求（只自报身份，别的都别带） */
const RequestInput = { subject: SubjectSchema };
const RequestOutput = z.object({
    requestId: z.string(),
    status: RequestStatusSchema,
    /** 本服务自己的身份地址（主方拿去核对「我在连谁」） */
    address: z.string(),
});

/** `web.auth.status` —— 主方轮询：③ 副方确认后才拿得到 token */
const StatusInput = { requestId: z.string() };
const StatusOutput = z.object({
    status: RequestStatusSchema,
    /** 仅 approved 时非 null：**副方生成**的 token */
    token: z.string().nullable(),
    expiresAt: z.string().nullable(),
});

/** `web.auth.login` —— ④ 主方拿 token 登录本连接 */
const LoginInput = { token: z.string().min(1) };
const LoginOutput = z.object({ subject: z.string(), expiresAt: z.string() });

/** `web.auth.state` —— 本连接当前状态（页面刷新后判断要不要重登） */
const ConnStateOutput = z.object({
    connected: z.boolean(),
    subject: z.string().nullable(),
    expiresAt: z.string().nullable(),
});

/** 副方管理面：待确认请求 / 已授权列表 */
const PendingOutput = z.object({
    requests: z.array(
        z.object({
            id: z.string(),
            subject: z.string(),
            note: z.string().nullable(),
            requestedAt: z.string(),
        }),
    ),
});
const TokensOutput = z.object({
    tokens: z.array(
        z.object({
            id: z.string(),
            subject: z.string(),
            issuedAt: z.string(),
            expiresAt: z.string(),
            revokedAt: z.string().nullable(),
        }),
    ),
});
const ApproveInput = { requestId: z.string() };
const ApproveOutput = z.object({ requestId: z.string(), token: z.string(), expiresAt: z.string() });
const DecideInput = { requestId: z.string() };
const DecideOutput = z.object({ requestId: z.string() });
const RevokeInput = { token: z.string().min(1) };
const RevokeOutput = z.object({ revoked: z.number() });

/** 页面（与 @diy-agent/workbench 的 PageInfo / page:invoke 同形 —— chat-page 的 ctx.invoke 直接对接） */
const PageInfoOutput = z.array(z.object({ id: z.string(), title: z.string() }));
// 注意：schema 推导不做 Partial ⇒ 这几个 key 在**类型上**都得传（args 允许 undefined，但要显式带上）。
// 而 `z.unknown()` 连 undefined 都拒（nonoptional），所以 args 必须 `.optional()`：无参方法才调得通。
const InvokeInput = { pageId: z.string().min(1), method: z.string().min(1), args: z.unknown().optional() };

export const webApi = RpcSchema.router({
    web: RpcSchema.group({
        desc: 'apps/web 宿主（无 Electron 的远程 web UI）',
        children: {
            auth: RpcSchema.group({
                desc: '单向授权（token 由副方签发；revoke 后主方不自动重试）',
                children: {
                    request: RpcSchema.unary({
                        desc: '主方发起连接请求（副方待确认）',
                        input: RequestInput,
                        output: RequestOutput,
                    }),
                    status: RpcSchema.unary({
                        desc: '主方轮询确认结果（approved 时拿到副方生成的 token）',
                        input: StatusInput,
                        output: StatusOutput,
                    }),
                    login: RpcSchema.unary({
                        desc: '主方用 token 登录本连接',
                        input: LoginInput,
                        output: LoginOutput,
                    }),
                    logout: RpcSchema.unary({
                        desc: '主方断开本次连接（不清 token）',
                        input: {},
                        output: z.object({ ok: z.boolean() }),
                    }),
                    state: RpcSchema.unary({
                        desc: '本连接当前状态',
                        input: {},
                        output: ConnStateOutput,
                    }),
                    pending: RpcSchema.unary({
                        desc: '副方：待确认请求（仅回环）',
                        input: {},
                        output: PendingOutput,
                    }),
                    tokens: RpcSchema.unary({
                        desc: '副方：已授权列表（仅回环，不含 token 明文）',
                        input: {},
                        output: TokensOutput,
                    }),
                    approve: RpcSchema.unary({
                        desc: '副方：允许并记住（在副方生成 token）',
                        input: ApproveInput,
                        output: ApproveOutput,
                    }),
                    deny: RpcSchema.unary({
                        desc: '副方：拒绝',
                        input: DecideInput,
                        output: DecideOutput,
                    }),
                    revoke: RpcSchema.unary({
                        desc: '副方：断开本次连接（撤销这一个 token）',
                        input: RevokeInput,
                        output: RevokeOutput,
                    }),
                    revokeAll: RpcSchema.unary({
                        desc: '副方：撤销全部 token（全部断开）',
                        input: {},
                        output: RevokeOutput,
                    }),
                },
            }),
            page: RpcSchema.group({
                desc: '页面调用（需要有效 token）',
                children: {
                    list: RpcSchema.unary({
                        desc: '页面清单（= 工作台 page:list）',
                        input: {},
                        output: PageInfoOutput,
                    }),
                    invoke: RpcSchema.unary({
                        desc: '调用某页面的一个方法（= 工作台 page:invoke）',
                        input: InvokeInput,
                        output: z.unknown(),
                    }),
                },
            }),
        },
    }),
});

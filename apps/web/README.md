# apps/web —— 无 Electron 的 web 宿主

一张端口干三件事：`GET /ping`（纯 HTTP）、静态托管 chat-page 的 renderer、WebSocket 上跑
`@diy-agent/rpc` 的声明式 RPC。**没有任何 Electron**（##485 判据 6）。

```bash
node apps/web/main.mjs --port 8080 --home /tmp/diy-web      # 判据 1（缺能力包 lib/ 会自动补编）
curl -s localhost:8080/ping                                  # 判据 1 的验证
./sha.sh check                                               # 本目录：typecheck + lint
./sha.sh test                                                # 判据 3/4/5/7 的自动化证据
```

## 三种形式与单向控制（##485 body）

```
a  浏览器 → 远程 web        本地无安装，纯网页
b  本地 app 主动连远程       本地是主，远程是副
c  远程 app 连本地           远程是主，本地是副（= b 换个发起方）
```

b / c 机制一样，只是谁发起 —— 本刀把「配对 + 授权」实现一次，方向由发起方决定。

```
① 主 → 副：web.auth.request { subject }
② 副 UI：web.auth.pending 看到请求 → web.auth.approve / deny
③ 副生成 token（`diyweb_<uuid>`，有效期缺省 8h），写进 $DIY_HOME/web/auth.json（0600）
④ 主轮询 web.auth.status → approved 拿到 token → web.auth.login { token } 绑到这条连接
⑤ 副随时 web.auth.revoke ⇒ 主方下一次调用 UNAUTHENTICATED（HTTP 绑定下就是 401）
```

### 两条安全要点（别改）

1. **token 只能由副方生成**。唯一的签发点是 `auth.ts` 的 `approve()`；而 `approve` 只挂在
   副方管理面（`pending / approve / deny / revoke / tokens`），**仅回环可调**（`handlers.ts` 的
   `requireOperator`）。跨机的主方连方法都够不到 ⇒ 「主方自签」在拓扑上不可达。
   tests 里有两条钉子：主方编的 token `verify` 为 null；非回环来源 `approve` → PERMISSION_DENIED。
2. **revoke 之后主方不自动重试**。`gateway.ts` 的 `invoke` 一次就是一次，不重连、不重试、不续签；
   renderer 收到 UNAUTHENTICATED 就清 token、回登录页，等副方重新确认。
   测试的结构证据：`stats.pageInvokes` 不增、`pageRejects` **恰好**等于客户端调用次数（有重试会翻倍）。

「记住」≠「绕过确认」：approve 只是发一枚长期 token，revoke 之后照样得重新走 ①②③。

## 为什么 RPC 走 WebSocket 而不是 HttpServerBinding（重要）

`pkgs.ts/diy-rpc/src/transport/http/` 那套绑定是 **node:http2** 的：
服务端吃 `ServerHttp2Stream`（`http-server-binding.ts:23`），客户端 `http2.connect()`（`http-client-binding.ts:12,38`）。
浏览器**不支持 h2c**（明文 HTTP/2），本轮又不做 TLS（反代解决）—— 于是浏览器侧没有可用的 http 绑定。

落地方式是「同一份业务，两种绑定」：

| 调用方                             | 绑定                                            | 传输                                                    |
| ---------------------------------- | ----------------------------------------------- | ------------------------------------------------------- |
| 浏览器（本刀的主场景）             | `ChannelServerBinding` / `ChannelClientBinding` | WebSocket（`@diy-agent/rpc/ws` 的 `WsTransport`）       |
| Node 调用方（CLI / 别的 diy 实例） | `HttpServerBinding` / `HttpClientBinding`       | h2c（`startWebServer({ httpRpcPort })` 或测试里自己起） |

两边的**方法、zod 校验、错误码、授权状态完全同一份**（`api.ts` / `handlers.ts` 不认识传输）。
`tests/http-binding.test.ts` 把同一份 router 挂到 HttpServerBinding 上跑，并用 curl 拿到字面的 **401**
—— 换 binding 不改业务，这条是实测的，不是声称的。

## 组成

| 文件          | 干什么                                                                                    |
| ------------- | ----------------------------------------------------------------------------------------- |
| `api.ts`      | 声明式 RPC 定义（`RpcSchema` + zod）：`web.auth.*` / `web.page.*`                         |
| `auth.ts`     | 授权内核（纯状态机）+ 落盘 store（`$DIY_HOME/web/auth.json`，0600）                       |
| `handlers.ts` | 把方法挂到某个 binding：每连接一份授权状态；副方管理面仅回环                              |
| `pages.ts`    | 页面宿主：`loadPages` 装 `@diy-agent/chat-page/main` + `@diy-agent/app-chat/sessions`     |
| `server.ts`   | HTTP（/ping + 静态）+ WebSocket upgrade；可选 h2c RPC 端口                                |
| `gateway.ts`  | 浏览器侧：WebSocket → `ChannelClientBinding` → `createTypedClient` → `WorkbenchGateway`   |
| `renderer.ts` | 浏览器入口：登录页 / 等待确认 / 工作台（`registerPage(chatPageView)` + `mountWorkbench`） |
| `main.mjs`    | 启动器：esbuild 现编 → import 真入口（判据 1 的那条命令）                                 |

## 装配复用（页面一行不改）

- 页面：`@diy-agent/chat-page`（renderer 用它的 `renderer-diui` 入口，与 apps/chat 一致）
- 多会话宿主：`@diy-agent/app-chat/sessions` 的 `createChatSessions({ home })`
  —— 为此给 apps/chat 的 `exports` 加了 `"./sessions"`（只是导出，不改它一行）
- 装配器：`@diy-agent/workbench/loader` 的 `loadPages`（纯装配、不含 electron；为此给 workbench
  加了 `"./loader"` 子路径 —— `main` 入口要 electron，Node 侧起不来）
- chat-page 认的只有 `ctx.invoke`：这里把 `page.*` 两个方法接到它原来的 `send` / `snapshot` …上，
  页面代码零改动。

## 已知边界（本轮明确不做）

- **不做 HTTPS**：假设在安全网络（tailscale / 反代）里；token 明文走 ws，公网必须上 TLS。
- **不做多用户**：一个实例一个操作者（副方）。
- **不做「允许一次」的单次 token**：approve 只有有效期（`ttlHours`），没有 use-count。
- **同机时主方 = 副方操作者**：回环来源既能当主方也能当副方，本刀不区分（跨机时天然分开）。
- **不做 c 形式**（远程控本地）的 UI 入口：机制已齐，缺的只是入口。
- **不做 token 轮换 / 续签**：过期就重新配对（铁律②的直接后果）。

## /ping

```json
{
    "id": "diy-7f3a2c91",
    "displayName": "c-mac",
    "app": "diy-web",
    "variant": "lab",
    "address": "alice@c-mac/diy-web.lab",
    "version": "0.1.0",
    "pid": 12345,
    "startedAt": "2026-10-31T…",
    "uptimeMs": 123456,
    "auth": "required"
}
```

`address` 按 ##484 的 displayAddress 格式拼（`user@host/app.variant`）；##484 合入后换成它的
`formatAddress()`（含多实例带端口）。`/ping` 无鉴权（它只答「我是谁、我活着」），所以缺省只绑
`127.0.0.1` —— 跨机要显式 `--host`。

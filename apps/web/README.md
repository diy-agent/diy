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

`pkgs.ts/core/rpc/src/transport/http/` 那套绑定是 **node:http2** 的：
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

| 文件          | 干什么                                                                                      |
| ------------- | ------------------------------------------------------------------------------------------- |
| `api.ts`      | 声明式 RPC 定义（`RpcSchema` + zod）：`web.auth.*` / `web.page.*`                           |
| `auth.ts`     | 授权内核（纯状态机）+ 落盘 store（`$DIY_HOME/web/auth.json`，0600）                         |
| `handlers.ts` | 把方法挂到某个 binding：每连接一份授权状态；副方管理面仅回环                                |
| `pages.ts`    | 页面宿主：`loadPages` 装 `@diy-agent/chat-page/main` + `@diy-agent/bot` 的 `createBotChat`      |
| `server.ts`   | HTTP（/ping + 静态）+ WebSocket upgrade；可选 h2c RPC 端口                                  |
| `registry.ts` | 实例注册表自报：启动/退出写删 `~/.diy-instances/<pid>.json`（##495，与 diy-app 同一份格式） |
| `webauthn.ts` | Passkey 内核（##496）：注册 / 登录 / 会话 + `$DIY_HOME/web/users.json` 落盘                 |
| `gateway.ts`  | 浏览器侧：WebSocket → `ChannelClientBinding` → `createTypedClient` → `WorkbenchGateway`     |
| `renderer.ts` | 浏览器入口：登录页 / 等待确认 / 工作台（`registerPage(chatPageView)` + `mountWorkbench`）   |
| `main.mjs`    | 启动器：esbuild 现编 → import 真入口（判据 1 的那条命令）                                   |

## Passkey 登录（##496，与 `web.auth.*` 并存）

只做**单 owner**：`users` 恒为一条，没有多用户 UI、没有角色（注册过一次就永久关闭）。
Touch ID 注册一个 Passkey，之后用它登录。`web.auth.*`（token 授权）一行没改，两条路同时可用
—— 页面登录页上那个「使用旧式 token 授权」就是老路。

用户名（`userName` / `userDisplayName`）**不写死 'owner'**：它原样出现在系统钥匙串 / iPhone
通行密钥列表里，所以缺省取 `os.userInfo().username`（`webauthn.ts` 的 `defaultUsername()`），
页面把它填进输入框供用户改；`/webauthn/me` 在「还没有主用户」时把这个建议值一并发给页面。

```
① GET  /webauthn/me                 → { hasUser, user, rpID }
② POST /webauthn/register/options   → 注册参数（仅当 users 为空）
③ POST /webauthn/register/verify    → 验签 + 建主用户 + 存公钥（**不发会话**）
④ POST /webauthn/login/options      → 登录参数（发现式：allowCredentials 留空）
⑤ POST /webauthn/login/verify       → 验签 + 更新 counter + **Set-Cookie**（7 天）
⑥ POST /webauthn/logout             → 清 cookie
```

同一份内核也挂在 RPC 面（`web.webauthn.*`，给 Node 客户端 / 测试用）；HTTP 路由只是为了
**HttpOnly cookie** —— `Set-Cookie` 只能由 HTTP 响应下发，WebSocket 升级响应带不了。

三条硬约束（改这三条等于改设计）：

1. **RP ID / origin 从请求的 Host 头现推**（`contextFromRequest`），不硬编码：prod 是
   `c-mac.gute-fish.ts.net`，lab 是 `localhost` —— 两边凭证天然隔离，不会串。`DIY_WEBAUTHN_RP_ID` /
   `DIY_WEBAUTHN_ORIGIN` 只是反代纠偏的显式覆盖口。
2. **challenge 不落盘**：内存 Map + 5 分钟 TTL + 一次性消费（进程重启丢失 = 重新点一次）。
3. **counter 必须更新**（`authenticationInfo.newCounter` 写回 store）：这是防克隆检测的判据。

会话在内存里（重启 → 重新登录），凭证落 `$DIY_HOME/web/users.json`（0600，**只有公钥**，私钥在
系统钥匙串）。页面进入工作台靠的就是这枚 cookie：WebSocket 升级请求会带上它，`requireClient`
认它 —— 所以 Passkey 登录后**不需要**再拿 token。

验签一律交给 `@simplewebauthn/server`（测试用真 ECDSA 造的虚拟 authenticator，见
`tests/virtual-authenticator.ts`）；不自己实现 FIDO2。

## 部署前缀（`--base-path`，##496）

反代把 `https://host/diy/*` **原样**转进来（tailscale serve 不剥前缀）时，用 `--base-path /diy`
（或 `DIY_WEB_BASE_PATH=/diy`）启动：服务端剥掉前缀再路由，页面侧从 `location.pathname` 推同一个
前缀（`/diy/` ⇒ WS 走 `/diy/rpc`、接口走 `/diy/webauthn/*`）。不传 = 挂在根上；两者都设成了
**严格**模式（前缀外一律 404，别家的路径不被本服务吃掉）。

## 装配复用（页面一行不改）

- 页面：`@diy-agent/chat-page`（renderer 用它的 `renderer-diui` 入口，与 apps/chat 一致）
- bot 对话宿主：`@diy-agent/bot` 的 `createBotChat({ home })`（##505 起不再从 apps/chat 取）
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

`address` 由 `@diy-agent/remote` 的 `tryFormatAddress` 拼（##484 的规则，`user@host/app.variant`）：
**同格多实例**（本机还有 `app + variant` 相同的实例）时带端口（`…/diy-web.lab:8124`），只有一个时不带。
冲突判据走 local 发现器（注册表 + `/ping` 探活），故启动后 /ping 会按注册表名单变化重算地址。

`/ping` 无鉴权（它只答「我是谁、我活着」），所以缺省只绑 `127.0.0.1` —— 跨机要显式 `--host`。

## 实例注册表（##495）

启动时写 `~/.diy-instances/<pid>.json`（`port` / `pingPort` / `diyHome` / `variant` / `env` / `argv` /
`cwd` / `startedAt` / `updatedAt` / `parents`，外加 `app` 与 `address`），退出（`close()` 或进程 `exit`）删除。
这样 local 发现器（远程导航页、别的实例）才看得见 web 实例。
异常退出留下的条目由读侧的 `/ping` 探活过滤；测试用 `DIY_INSTANCE_REGISTRY` 指到临时目录。

# @diy-agent/remote — 远程实例内核（##479 第一刀）

> 全仓契约见仓库根 `AGENTS.md`。本文件只写**包内定位**与**看不见的判据**。
> 需求真源是测试：`tests/*.test.ts`。

## 这一层是什么

「一台机器上的 diy 实例，怎么被另一台机器找到、怎么确认它还活着」。本轮只有两件事：
**实例身份**（永不变的 id + 可改的 displayName）和 **`GET /ping`**。RPC 转发 / fs 代理 / 对话都不在这里。

## 分层（别混）

| 入口                                            | 内容                                                                             | 允许依赖                                         |
| ----------------------------------------------- | -------------------------------------------------------------------------------- | ------------------------------------------------ |
| `@diy-agent/remote`（`src/index.ts`）           | 契约与**纯函数**：身份判据 / 合并去重 / 排版 / manual 归一 / tailscale JSON 解析 | 零 `node:*`、零 electron（renderer 也能 import） |
| `@diy-agent/remote/node`（`src/node/index.ts`） | IO 实现：身份落盘、`/ping` 服务端与客户端、四个发现器、发现链                    | `node:*` + `bonjour-service`                     |

## 三条硬约束

1. **id ≠ hostname**：id 首次启动生成、存 `$DIY_HOME/instance-id`，之后**永不覆盖**；displayName 缺省取
   hostname，用户可改（存 `$DIY_HOME/instance-name`）。hostname 会变，id 一漂移远端就认不出这台机器
   （判据 5，`tests/identity.test.ts` 钉住）。
2. **发现 ≠ 连接**：发现器只**列出**候选，合并去重后交给用户选；本包没有任何「连上就干活」的入口（判据 4）。
3. **`/ping` 无鉴权**（本轮明确不做）：缺省只绑 `127.0.0.1`，跨机要显式 `DIY_PING_HOST=<内网/tailscale 地址>`。
   **绝不要绑公网**（`src/node/ping-server.ts` 文件头 + `bindHint` 会在非回环地址上打一行警告）。

## 四路发现器

| kind        | 数据源                                                                      | 失败时                           |
| ----------- | --------------------------------------------------------------------------- | -------------------------------- |
| `local`     | 实例注册表 `~/.diy-instances/<pid>.json` 的 `pingPort`（新字段）→ 逐个 ping | 条目无效就跳过                   |
| `mdns`      | `_diy._tcp` 的 TXT（id / displayName / variant），实现 = `bonjour-service`  | 空列表（多播被拦是常态）         |
| `tailscale` | `tailscale status --json` 的 online peer（DNSName 优先，再试 IP）           | **没装即静默跳过**（不算 error） |
| `manual`    | 用户输入（补 scheme / 缺省端口 9400）                                       | 解析不了的那条跳过               |

合并规则在 `src/merge.ts`：有 id 按 id 合并，否则按归一 endpoint；同一 id 多个 endpoint 取
`SOURCE_RANK` 靠前的来源（manual > local > tailscale > mdns）。

## 坑

- **`/ping` 是 HTTP/1.1，不是 RPC 端口**：RPC 用 h2c + 身份校验，`/ping` 要能被 curl / 任何机器直接打。
  两者端口分开（RPC 由 `app.port` 记录，ping 由 `DIY_PING_PORT` 缺省 9400 + 被占顺延）。
- **探测禁用连接复用**（`agent: false`）：同端口上可能已经换了一个实例，复用旧套接字会读成 ECONNRESET，
  把「重启后仍活着」误报成连不上。
- **发现器失败不连坐**：`discoverAll` 用 `allSettled`，一路炸了只进 `errors`。
- **`meta.reachable`**：manual / 无 TXT 的 mDNS 候选会补一次 ping；打不通仍保留该行（用户手输的地址
  可能是还没起来的实例），只标 `reachable=false`。

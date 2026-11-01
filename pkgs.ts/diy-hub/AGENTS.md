# @diy-agent/hub — 配对与信任内核（##500）

> 全仓契约见仓库根 `AGENTS.md`。协议真源 `docs/plans/2026-11-01-hub-pairing.md`（**四轮讨论定稿，不要改协议**）。
> 需求真源是测试：`tests/*.test.ts`（39 条，判据逐条对应）。

## 这一层是什么

「我信谁、怎么连」：Hub 建邀请 → 卫星拿地址（**人比对真实 URL**）→ 输码 → Owner 审批 → 发 Token → WSS 长连。

和 `@diy-agent/remote` 的分工：

| 包 | 管什么 |
|---|---|
| `@diy-agent/remote` | 我怎么被找到（Node 身份、地址、mDNS / tailscale 发现、`/ping`） |
| `@diy-agent/hub` | 我信谁、怎么连（邀请、密钥、审批、Token、连接循环） |

## 三条设计决策（改动前先读）

1. **地址即身份**：不做指纹核对。人比对 `c-mac.gute-fish.ts.net`，不比对 32 位十六进制。
   邀请 URL 必须是真实主机形式 `https://host/hub/pair?inv=...`，**不许**包成 `diy://pair?endpoint=...`（判据 6）。
2. **码管「谁被允许进来」，不管「连的是不是真主控」**：假 hub 收下任何码都没用，它拿不到真 Hub 的 `HMAC(serverKey, code)`；
   假 hub 骗人的问题是靠 URL 比对解决的。
3. **mDNS 不做配对路径**：`.local` 是自签证书，同网段可伪造同名。只用于展示「有哪些 hub」，配对一律要求 tailscale 地址（判据 8/9）。

## 分层

| 文件 | 职责 |
|---|---|
| `types.ts` | 契约（三个状态机 / `domainId` 到处预留） |
| `code.ts` / `key.ts` | 6 位 Base32；Ed25519（只用 `node:crypto`）、Token 哈希 |
| `secret.ts` / `keychain.ts` | 钥匙串接口 + macOS `security` 实现（不可用就明确报错，绝不落普通文件） |
| `store.ts` / `store-fs.ts` | `update` 原子读改写（判据 4 靠它）；`peers.json` / `hub.json` / `link.json` |
| `invitation.ts` / `pairing.ts` | 建邀请 / 验码（HMAC + 全局计数）/ 审批 / 撤销 |
| `server.ts` | `/hub/info`、`/hub/pair`（长轮询拿 Token）、WSS Bearer 接入 |
| `client.ts` | 卫星两步配对（`preparePairing` 只显示地址 → `completePairing` 才交码）+ 重连 |
| `links.ts` | 邀请 URL / 地址归一 / 地址策略（tailscale / mDNS 拒配） |
| `tls.ts` | 没有可信证书就拒绝启动（不静默降级成 http） |

## 四条硬约束

1. **先显示地址，再交码**：`completePairing` 只接受 `preparePairing` 的产物 —— 结构上跳不过去（判据 7）。
2. **码只存 HMAC**：`peers.json` 里字段名 `hmac`，明文码与 `code` 字样都不出现（判据 13）。
3. **失败计数挂邀请、不挂 nodeId**：换 nodeId 重试不重置（判据 3）；验码 + 置 consumed 在同一个 `update` 里（判据 4）。
4. **Token / Hub 私钥只在钥匙串**：`hub.json` 只有 `publicKey`，`link.json` 没有 token（判据 11/12）。

## 坑

- `HubStore.update` 的 fn **不要抛错**（失败计数要落盘）：返回结果联合，外层再抛。
- 批准必须走 `server.approve`（它负责唤醒长轮询）；直接调 `approveRequest(store)` 会让卫星一直等。
- 单测用明文 HTTP 必须显式 `allowInsecureHttp: true` / `allowInsecure: true`；默认拒绝（生产必须 TLS）。
- 撤销后 token 校验看 `membership.status`，不是「查得到 hash 就放行」。

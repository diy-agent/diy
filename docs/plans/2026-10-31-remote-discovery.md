# remote 第一刀：实例身份 + endpoint 发现 + ping（##479）

> 用户裁决（2026-10-30）：先不考虑 bot / 对话，先把 **endpoint 发现、鉴权、传输** 解决掉，
> 实现「第一种 remote 代理方式」= VSCode remote ssh 型（用另一台机器像本机一样，数据都在远程）。
> 本轮只落 **发现 + ping**；鉴权、RPC 转发、fs 代理都不做。

## 一、身份：id 与 displayName 分开

```ts
interface InstanceIdentity {
  id: string;          // "diy-7f3a2c91"：首次启动生成，存 $DIY_HOME/instance-id，永不变
  displayName: string; // 缺省 hostname；用户可改（存 $DIY_HOME/instance-name）
}
```

**绝不拿 hostname 当 id**（用户原话：hostname 可以改，改了就很麻烦）。改机器名只影响 displayName；
`resolveIdentity()` 是纯函数，`tests/identity.test.ts` 用「同一个数据根 + 新 hostname」钉住 id 不变。

## 二、`GET /ping`（本轮唯一对外契约，**无鉴权**）

```json
{
  "id": "diy-7f3a2c91",
  "displayName": "c-mac 的 lab",
  "variant": "lab",
  "version": "0.1.0",
  "pid": 12345,
  "startedAt": "2026-10-30T…",
  "uptimeMs": 123456
}
```

- 服务端：`pkgs.ts/diy-remote/src/node/ping-server.ts`，HTTP/1.1、150 行以内，只答 `GET/HEAD /ping`，
  不提供任何读写数据的能力。
- 端口：`DIY_PING_PORT`（缺省 9400），被占则**缺省端口**顺延最多 10 个；显式给的端口不换。
- 绑定：`DIY_PING_HOST`（缺省 `127.0.0.1`）。
- ⚠️ **当前无鉴权，别暴露公网**：缺省只绑回环；跨机（tailnet / 局域网）要显式设内网地址，
  代码在非回环绑定时会打一行警告（`bindHint`）。

## 三、四路发现器（全部独立、可选）

| kind | 做什么 | 失败语义 |
|---|---|---|
| `local` | 读实例注册表 `~/.diy-instances/*.json` 的 `pingPort`，逐个 ping | 无效条目跳过 |
| `mdns` | 浏览 `_diy._tcp`（TXT：id / displayName / variant），实例自己也广播 | 空结果 |
| `tailscale` | `tailscale status --json` → online peer，DNSName 优先再试 IP | **没装静默跳过** |
| `manual` | 用户输入 URL / `host:port`（补 scheme 与 9400 端口） | 解析失败的那条丢弃 |

**发现 ≠ 自动连接**（判据 4）：`discoverAll()` 合并去重后返回候选，CLI / UI 只负责**列出来让用户选**：

```
diy remote discover                 # 人读列表（缺省 local + mdns + tailscale）
diy remote discover --manual 10.0.0.9,srv.tailnet:9400
diy remote list                     # 结构化 JSON（UI / 程序）
diy remote ping http://10.0.0.9:9400
diy remote self                     # 本实例 id / 名字 / ping 端点
diy remote rename "服务器 prod"      # 只改 displayName，id 不变
```

## 四、合并去重的判据

- 有 id 就按 id 合并（id 是身份，IP / hostname / 端口都可能变）。
- 没 id 的按归一 endpoint 合并（补 scheme、去尾斜杠、host 小写、保留端口）。
- 同一 id 多个 endpoint：取来源优先级最高者（`manual > local > tailscale > mdns`），其余来源记进 `sources`。
- 输出排序稳定（来源优先级 → 显示名 → endpoint），便于按序号选。

## 五、判据（本轮验收）

1. 实例启动生成 `$DIY_HOME/instance-id`，重启不变 —— `tests/identity.test.ts` + `tests/services/remote.test.ts`
2. `GET /ping` 返回上述字段 —— `tests/ping.test.ts`（真起 loopback 端口）
3. 四个发现器都能单独跑 —— `tests/{local,mdns,tailscale,manual,discover}.test.ts`
4. 发现结果合并去重后列出，不自动连接 —— `tests/merge.test.ts` + `formatDiscoveryList`
5. hostname 改了 id 不变 —— `tests/identity.test.ts`
6. tailscale 没装 ⇒ 静默跳过 —— `tests/discover.test.ts`
7. `./sha.sh check` 0 error

## 六、下一刀

- 鉴权（token / 配对），再把 `/ping` 之外的能力开放出去
- RPC 转发（远程实例当本地用）、fs 代理
- UI：发现列表 → 选择 → 连接的页面（本轮只到 CLI）

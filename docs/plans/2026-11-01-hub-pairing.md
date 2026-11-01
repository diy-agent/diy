# Hub 配对协议 v1（备忘）

> 2026-11-01 收敛。四轮讨论后的实现基线。
> 一句话：**地址就是身份 —— 人比对真实 URL，码只管「谁被允许进来」。**

## 一、三个身份分开

| 身份 | 表示什么 | 认证方式 | 存哪 |
|---|---|---|---|
| **Owner** | 谁拥有这台机器 | Passkey（Touch ID） | `~/.diy/users.json` |
| **Node** | 哪个 diy 安装实例 | Node ID（`diy-xxxxxxxx`） | `~/.diy/instance-id` |
| **Hub** | 哪个 Node 是当前主控 | **真实 URL + TLS 证书** | `~/.diy/hub/hub.json` |

**别混**：「这台机器加入了网络」≠「这台机器上的用户有管理权限」。

## 二、地址即身份（核心决策）

```
✅ 用真实主机地址：https://c-mac.gute-fish.ts.net/hub/pair?inv=inv_abc123
❌ 不用包装形式：  diy://pair?v=1&endpoint=https%3A%2F%2Fc-mac...
```

**理由**：

| | 指纹 `A1:B2:C3:D4:E5:F6:07:18:29:3A` | 地址 `c-mac.gute-fish.ts.net` |
|---|---|---|
| 人能比对吗 | 不能（32 位十六进制） | 能（「就是我这台 mac」） |
| 平时见过吗 | 从没见过 | 天天在用 |
| 伪造难度 | 一样 | 一样（都需要 tailscale 账号或证书私钥） |

**不比对的东西等于没检查。** 32 位指纹只会让人盲目点「一致」，起不到任何防护作用。

## 三、两个方向的威胁

| 方向 | 场景 | 靠什么挡 |
|---|---|---|
| 假卫星进来 | 攻击者起一个假卫星连主控 | **6 位码**（3 次额度 + 5 分钟）+ Owner 审批 |
| 卫星连错主控 | 用户点错链接连到假 hub | **URL 比对**（人眼看地址） |

**两者不能互相替代**：

- 码只管「谁被允许进来」—— 假 hub 收下码也没用，它没有真主控的 `HMAC(serverKey, code)` 能对上
- URL 只管「连的是不是那台机器」—— 人一眼看出 `evil-host.ts.net` ≠ `c-mac.gute-fish.ts.net`

**关键的反例**（这也是不能只用码的原因）：

```
卫星点错链接 → 假 hub 接受一切码 → 假 hub 发假 Token
卫星不知道，以后都发给假 hub
```

假 hub 不需要知道真码。**所以必须有「主控是真的」的判据，而唯一人能做到的判据是比对地址。**

## 四、信任假设（必须写进文档）

> **tailnet 控制面和它签发的证书可信。**
> 攻击者要冒充 `c-mac.gute-fish.ts.net`，需要拿到 tailscale 账号控制权，或拿到该主机的证书私钥。
> 这两者一旦发生，本协议无效 —— 那是更高层的安全问题（同 tailscale 本身的失效）。

**推论**：

- v1 **只接受 tailscale 地址**配对（证书由 Let's Encrypt 签发，系统信任链验证）
- **mDNS 不做配对路径** —— mDNS 的 `c-mac.local:3000` 是自签证书，同网段可以从真机名下伪造同名
- mDNS 只用于「发现局域网有哪些 diy hub」的展示；真要配对，提示「请使用 tailscale 地址」

## 五、三层回环（v1 只做一层）

```
Node ID        一台安装实例          → 已有（##479）
Domain ID      一个信任网络          → v1 固定 "default"，字段预留
Membership ID  一个 Node 在一个 Domain 的成员关系 → v1 每 node 一条
```

**为什么现在留字段**：将来 C-VN7 同时是 A 域卫星 + B 域 Hub 时，`(domainId, nodeId)` 才是唯一键。现在不写 `domainId`，将来加第二个域要迁移数据。

## 六、配对流程（五步）

```
① Hub 建邀请
   diy hub invite
   → 屏幕显示三样：
       6 位 Base32 码        7K9M-Q2        5 分钟内有效
       本机地址              https://c-mac.gute-fish.ts.net/hub
       二维码（内容 = 上面这个地址 + inv 参数，不含码）
   → 落盘 HMAC-SHA256(serverKey, code)，不存明文

② 卫星获取地址
   扫码      → https://c-mac.gute-fish.ts.net/hub/pair?inv=inv_abc123
   粘贴链接  → 同上
   mDNS 发现 → 只显示有哪些 hub；配对时提示改用 tailscale 地址
   → 屏幕显示：「要连接到 c-mac.gute-fish.ts.net」
   → 人跟主控屏幕上显示的地址比对
   → 不一致 → 中止

③ 输码 + 提交
   人输入主控屏幕上的 6 位码
   生成本地 Ed25519 密钥对（私钥进钥匙串）
   POST https://c-mac.../hub/pair { inviteId, domainId, code, nodeId, displayName, publicKey }
   → Hub 验码 → 创建 Pending Request
   → 卫星显示「已提交，等待 c-mac 批准」

④ Owner 批准（人参与，不能省）
   Hub UI 弹：c-vn7 请求加入
   → 人点同意（码对了不等于该放进来，这一步是人的判断）

⑤ 签发 Token
   Hub 生成 32 字节随机 Token，存 SHA-256
   卫星拿到 → 进系统钥匙串
   link.json 只存 { domainId, hubNodeId, hubPublicKey, hubEndpoint }
   → 卫星主动建立 WSS + Authorization: Bearer <token>
```

**人的操作只有两件**：看一眼地址对不对、输一次码。

## 七、三个状态机（分开，不合并）

```
Invitation     Created → Consumed / Expired / Exhausted / Revoked
PairingRequest Pending → Approved / Rejected / Expired
Membership     Active  → Revoked
```

三者在同一个 `peers.json` 里分三个数组，不混成一条。

## 八、安全边界

| 威胁 | 防法 |
|---|---|
| 假卫星进来 | 6 位码（3 次/邀请 + 5 分钟）+ Owner 审批 |
| 卫星连错主控 | **URL 比对**（人眼看地址） |
| 码泄漏（链接被转发） | 二维码/链接**不含 code**，码只在屏幕 |
| 暴力猜码 | 3 次失败/邀请（**按邀请全局**，不按 Node）+ 5 分钟过期 |
| 并发抢码 | 原子消费，一个邀请只接受一个申请 |
| 卫星冒充 | Node Token（Bearer） |
| 撤销后重连 | `revoke` → 断现有连接 + 拒新连接（403） |
| mDNS 伪造 | **不做 mDNS 配对路径** |

**两条硬约束**：
1. `code` 落盘用 HMAC（不存明文、不用无盐 SHA-256）
2. Token 和 Hub 私钥**都不在普通 JSON 文件**（系统钥匙串）

## 九、v1 不做的

| 不做 | 理由 |
|---|---|
| 指纹核对 | 人不会比对 32 位十六进制；URL 已覆盖同一威胁 |
| SAS 双向确认 | 同上 |
| sid 短确认码 | URL 比对已足够，多加一步没必要 |
| 双向签名握手 | Token 够用 |
| 自签证书 TLS Pinning | 易错且错得静默 → mDNS 配对路径直接不做 |
| 多 Domain | `domainId` 固定 `"default"`，**字段必须预留在所有数据结构里** |
| 每域独立密钥 | 一把 node key |
| Membership 公钥签名 | 只做 Token |

## 十、CLI（先于 UI）

```bash
diy hub init                    # 生成 Hub 密钥对（私钥进钥匙串）+ hub.json
diy hub invite                  # 建邀请，输出 6 位码 + 地址 + 二维码
diy hub pending                 # 待批准列表
diy hub approve <requestId>
diy hub revoke <nodeId>
diy hub status                  # 已配对列表 + 在线/离线
```

卫星侧：

```bash
diy hub join https://c-mac.gute-fish.ts.net/hub/pair?inv=inv_abc123
  → 显示「要连接到 c-mac.gute-fish.ts.net」，人确认
  → 提示输入 6 位码
  → 提交 → 显示「等待 c-mac 批准」
```

## 十一、判据

### 邀请
1. 6 位 Base32，5 分钟有效
2. 二维码/链接**不含 code**（`grep -c code` = 0）
3. 失败次数**按邀请全局**（换 nodeId 重试不重置）
4. 并发消费同一邀请，只有一个成功
5. 邀请绑定 `domainId` + `hubNodeId`

### 身份
6. **邀请 URL 是真实主机地址**（`https://c-mac.../hub/pair?inv=...`），不是 `diy://` 包装
7. 卫星在输码前**显示要连接的地址**，供人比对
8. mDNS 发现的条目**不能直接配对**，点了提示改用 tailscale 地址
9. 无 tailscale 证书时明确报错，不静默降级

### 审批
10. 未批准前卫星拿不到 Token

### 存储
11. `grep -c token link.json` = 0
12. Hub 私钥不在 `hub.json`（只有 `publicKey`）
13. `grep -c code invites.json` = 0（存 HMAC）

### 通信
14. 卫星主动 WSS，不监听入站
15. 心跳 30s，断线指数退避（1s → 60s 封顶）

### 撤销
16. `revoke` 后现有连接断开
17. 重连被拒（403）

### 离线自治
18. Hub 关掉 → 卫星 `diy task list` / `diy chat` 一切正常
19. hub 重启 → 卫星自动重连（不用重新配对）

## 十二、UI（CLI 跑通后）

五屏（demo 见 `/tmp/hub-demo/index.html`）：

1. **主控建邀请** —— 码 + 真实地址 + 二维码，三样同时出现
2. **卫星获取** —— 扫码/粘贴/发现 → 显示「要连接到 c-mac...」
3. **卫星输码** —— 输码 + 「等待批准」
4. **主控批准** —— 弹窗「c-vn7 请求加入」
5. **已配对管理** —— 在线离线 / 移除（撤销）

## 十三、遗留（v2 再说）

- 多 Domain
- 每域独立密钥
- mDNS 配对路径（需先解决自签证书信任）
- Token 轮换
- Hub 离线恢复（hub 数据丢了怎么重建）
- 指令级权限（ACL）

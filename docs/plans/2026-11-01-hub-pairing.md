# Hub 配对协议 v1（备忘）

> 2026-11-01 收敛。三轮讨论（SAS 强化版 → Node Token 简化版 → Pairing Invitation 统一版）后的实现基线。
> 一句话：**三种传递方式（二维码 / 6 位码 / 链接）走同一套协议，先验主控身份再交秘密。**

## 一、三个身份分开

| 身份 | 表示什么 | 认证方式 | 存哪 |
|---|---|---|---|
| **Owner** | 谁拥有这台机器 | Passkey（Touch ID） | `~/.diy/users.json` |
| **Node** | 哪个 diy 安装实例 | Node ID（`diy-xxxxxxxx`） | `~/.diy/instance-id` |
| **Hub** | 哪个 Node 是当前主控 | TLS + Hub 公钥 pinning | `~/.diy/hub/hub.json` |

**别混**：「这台机器加入了网络」≠「这台机器上的用户有管理权限」。

## 二、三层回环（v1 只做一层）

```
Node ID        一台安装实例          → 已有（##479）
Domain ID      一个信任网络          → v1 固定 "default"，字段预留
Membership ID  一个 Node 在一个 Domain 的成员关系 → v1 每 node 一条
```

**为什么现在留字段**：将来 C-VN7 同时是 A 域卫星 + B 域 Hub 时，`(domainId, nodeId)` 才是唯一键。现在不写 `domainId`，将来加第二个域要迁移数据。

## 三、配对流程（七步）

```
① Hub 建邀请
   diy hub invite
   → 6 位 Base32 码（如 7K9M-Q2）
   → 5 分钟有效
   → 落盘 HMAC-SHA256(serverKey, code)，不存明文
   → 显示：码 + Hub 指纹 A1:B2:C3:D4 + 二维码（不含 code）

② Satellite 获取连接信息（三种传递方式，同一结果）
   甲 扫码       → { endpoint, domainId, inviteId, hubNodeId }
   乙 mDNS 发现  → { endpoint, nodeId, domainId }
   丙 手输端点   → { endpoint }

③ 验证 Hub 身份（关键：在交任何秘密之前）
   GET /hub/info
   → { domainId, hubNodeId, hubPublicKey, hubFingerprint }
   → 人跟主控屏幕上的指纹比对
   → 不一致 → 中止

④ 提交配对申请
   人输入主控屏幕上的 6 位码
   生成本地 Ed25519 密钥对（私钥进钥匙串）
   POST /hub/pair { inviteId, domainId, code, nodeId, displayName, publicKey }
   → Hub 验码 → 创建 Pending Request

⑤ Owner 审批（人参与，不能省）
   Hub UI 弹：c-vn7 请求连接
   显示 Satellite 的公钥指纹
   → 人核对该指纹 == 卫星屏幕上显示的自己的指纹
   → 同意

⑥ 签发 Node Token
   Hub 生成 32 字节随机 Token，存 SHA-256
   卫星拿到 → 进系统钥匙串
   link.json 只存 { domainId, hubNodeId, hubPublicKey, hubEndpoint }

⑦ 日常连接
   卫星主动 WSS + Authorization: Bearer <token>
   Hub 验 tokenHash + Membership.status === active
```

## 四、三个状态机（分开，不合并）

```
Invitation     Created → Consumed / Expired / Exhausted / Revoked
PairingRequest Pending → Approved / Rejected / Expired
Membership     Active  → Revoked
```

三者在同一个 `peers.json` 里分三个数组，不混成一条。

## 五、安全边界

| 威胁 | 防法 |
|---|---|
| 假 Hub（骗卫星交码） | ③ 先验指纹，一致才交码 |
| 码泄漏（二维码被转发） | 二维码/链接**不含 code**，码只在屏幕 |
| 暴力猜码 | 3 次失败/邀请（**按邀请全局**，不按 Node）+ 5 分钟过期 |
| 并发抢码 | 原子消费，一个邀请只接受一个申请 |
| 中间人 | TLS + Hub 公钥 pinning |
| 卫星冒充 | Node Token（Bearer） |
| 撤销后重连 | `revoke` → 断现有连接 + 拒新连接（403） |
| mDNS 伪造 | TXT **不含 fingerprint**，mDNS 只做发现不做身份 |

**四条硬约束**：
1. 核对指纹前不向对方发送任何秘密
2. Token 和 Hub 私钥**都不在普通 JSON 文件**（系统钥匙串）
3. `code` 落盘用 HMAC（不存明文、不用无盐 SHA-256）
4. 邀请过期/失败次数用**服务端**时钟和计数，不信客户端

## 六、v1 不做的

| 不做 | 理由 | 判据（不支持时报什么） |
|---|---|---|
| SAS 双向确认 | 指纹核对已覆盖 | — |
| 双向签名握手 | Token 够用 | — |
| 自签证书 TLS Pinning | 实现易错且错得静默 | 无 tailscale 证书时报错「需要受信任的 HTTPS」 |
| 多 Domain | 字段预留，先单域 | `domainId` 固定 `"default"` |
| 每域独立密钥 | 一把 node key | — |
| Membership 公钥签名 | 只做 Token | — |

## 七、CLI（先于 UI）

```bash
diy hub init                    # 生成 Hub 密钥对（私钥进钥匙串）+ hub.json
diy hub invite                  # 建邀请，输出 6 位码 + 指纹 + 二维码
diy hub info <url>              # 查远端 Hub 身份（不涉及任何秘密）
diy hub pair <url> --code 7K9M-Q2
diy hub pending                 # 待批准列表
diy hub approve <requestId>
diy hub revoke <nodeId>
diy hub status                  # 已配对列表 + 在线/离线
```

## 八、判据

### 邀请
1. 6 位 Base32，5 分钟有效
2. 二维码/链接不含 code（`grep -c code` = 0）
3. 失败次数按邀请全局（换个 nodeId 重试不重置计数）
4. 并发消费同一邀请，只有一个成功
5. 邀请绑定 domainId + hubNodeId

### 身份
6. 核对指纹前不提交任何秘密（`/hub/pair` 之前没有 code 外传）
7. mDNS TXT 不含 fingerprint
8. 无 tailscale 证书时明确报错，不静默降级

### 审批
9. 未批准前 Satellite 拿不到 Token
10. Hub 展示 Satellite 的公钥指纹供人核对

### 存储
11. `grep -c token link.json` = 0
12. `grep -c tokenHash` 只在 hub 侧
13. Hub 私钥不在 `hub.json`（判据：文件里只有 `publicKey`）
14. `grep -c code invites.json` = 0（存 HMAC）

### 通信
15. Satellite 主动 WSS，不监听入站端口
16. 心跳 30s，断线指数退避重连（1s → 60s 封顶）

### 撤销
17. `revoke` 后现有连接断开
18. 重连被拒（403）

### 离线自治
19. Hub 关掉 → 卫星 `diy task list` / `diy chat` 一切正常

## 九、UI（CLI 跑通后）

四个场景（demo 见任务 ##501 附件）：

1. **主控：弹窗批准** —— 收到请求时右上角弹卡片
2. **主控：设置页列表** —— 待批准 + 已配对（同一份数据两个视图）
3. **卫星：获取邀请** —— 扫码 / 粘贴链接 / mDNS 选择 → 统一进入配对页
4. **主控：已配对管理** —— 在线离线、移除（= 撤销）

**UI 只有一条路径**：

```
[扫码 / 粘贴链接 / 选发现设备]
    → [核对指纹]
    → [输入 6 位码]
    → [等待批准]
```

## 十、遗留（v2 再说）

- 多 Domain
- 每域独立密钥
- 自签证书路径
- Membership 公钥签名
- Token 轮换
- Hub 离线恢复（hub 数据丢了怎么重建）
- 指令级权限（ACL）

# @diy-agent/entity-chat

实体即对话的 UI 包：**项目 / 任务 / bot 都是对话对象**（Room / Bot / BotSession）。

- 项目 = 本机目录；项目与任务本体可直接对话
- primary bot 名字 = 容器名（`diy` 项目的 bot 就叫 `diy`）
- bot 可借用（归属不变）或新建（归当前容器）
- 模型目录照 diy 的 provider 结构：`account@provider/model`

## 组成

| 目录                               | 作用                                                                           |
| ---------------------------------- | ------------------------------------------------------------------------------ |
| `src/store.tsx`                    | 壳层：房间列表 / 选择 / 重试连接（挂 `ConversationStore`）                     |
| `src/address.ts`                   | 「现在在看哪儿」：纯函数，`/room/task/t-001` ↔ `{page,id}`                     |
| `src/nav.ts` + `src/nav/`          | 侧栏插槽：壳只铺注册表，内建三块（项目/历史/未归属）也是注册项                 |
| `src/surfaces/registry.tsx`        | 表面注册表：壳层只认这个数组，不写 `if (tab === …)`                            |
| `src/surfaces/astryx`              | Astryx 表面（默认，`ChatVirtualizer` 虚拟化）                                  |
| `src/surfaces/shadcn`              | 裸 Tailwind 表面（无 chat 库；窗口化 + `content-visibility`）                  |
| `src/surfaces/shared.ts`           | 两面共用的纯映射：工具行 target / parts 分组 / 可复制正文                      |
| `src/surfaces/mention-complete.ts` | @ 补全的纯文本逻辑（判定 + 替换 + 过滤，可单测）                               |
| `src/components`                   | 两面共用：`Markdown` / 代码高亮 / `BotAvatar` / `AskCard` / `RunningIndicator` |

分组语义只有一份（`@diy-agent/chat-core` 的 `buildTimeline`），状态只有一份
（`ConversationStore`）。surface 之间**不互相 import**，壳层按注册表切换。

**两面能力已对齐**（2026-11-23）：同一份 `shared.ts` 映射、同一批业务件，各面都有
@ 补全 / 消息复制 / 回到底部 / 空态 / 贴底跟随。第三面 assistant-ui 已删 —— 它更完整的是
「一对一 chat」形态（分支 / 编辑重发 / 语音 / 建议），那些在我们的房间模型里没有对应事实，
为不消费的能力付 2431 行 registry 件 + 162 行投影 + 10 个传递依赖；判据见
`docs/plans/2026-11-24-surface-parity.md`。

传输：`@diy-agent/chat-transport-rpc` 的 `RpcChatClient`（命令 + 事件都走一条 WebSocket `/rpc`，
断线退避重连）。**命令用 unary，事件是 `room` server-stream**（见该包的 `src/hub.ts`）；
HTTP 只剩探活 `/api/info` 与静态文件（REST 与 SSE 已于 2026-11-22 删除）。

入口：`EntityChatApp`（页面组件）+ `styles.css`（主题令牌）。

```tsx
import { EntityChatApp } from '@diy-agent/entity-chat';
import '@diy-agent/entity-chat/styles.css';
```

对外还有两类能力（其余内部在实验期不承诺稳定）：

```tsx
// 1. 导航：视图 / 插件只需要「去某个位置」
import { formatAddress, navigate, roomAddressOf } from '@diy-agent/entity-chat';
<a href={formatAddress(roomAddressOf(room))} onClick={...}>…</a>;
navigate(roomAddressOf(room)); // 代码级跳转（replace: true 时不堆历史）

// 2. 侧栏插槽：贡献一个导航分区
import { registerNavSource } from '@diy-agent/entity-chat';
registerNavSource({ id: 'my:stocks', order: 40, render: (ctx) => <StocksBlock open={ctx.open} /> });
```

地址形状：`/room/<kind>/<local>`（room id `task:t-001` 的冒号换成路径分隔符）。
刷新直达、可复制、可分享 —— 服务端的 SPA 回退本来就在（dev 的 `appType:'spa'`、
prod 的 `static.ts`）。两个硬约束：首段不能是 `api`（被 JSON 接口接管）、不能与真实
静态文件同名（`/perf.html` 会被直接发出）。

## 语义约定

- 没有 @ → primary 回复；`@名字` → 命中者；`@all` → 全员；bot 之间只能单人 @
- 运行中可插话：发送按钮不会被停止键替换（停止在 `RoomStatusBar`）
- 失败的归属是"那个 bot 的回复"（头像 + 名字 + 错误框），不是"用户消息未送达"
- 长会话：Astryx 用官方 `ChatVirtualizer`，另外两面窗口化 + 滑到顶自动补窗口

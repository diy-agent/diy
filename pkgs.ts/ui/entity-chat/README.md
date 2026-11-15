# @diy-agent/entity-chat

实体即对话的 UI 包：**项目 / 任务 / bot 都是对话对象**（Room / Bot / BotSession）。

- 项目 = 本机目录；项目与任务本体可直接对话
- primary bot 名字 = 容器名（`diy` 项目的 bot 就叫 `diy`）
- bot 可借用（归属不变）或新建（归当前容器）
- 模型目录照 diy 的 provider 结构：`account@provider/model`

## 组成

| 目录 | 作用 |
|---|---|
| `src/store.tsx` | 壳层：房间列表 / 选择 / 重试连接（挂 `ConversationStore`） |
| `src/projection.ts` | 时间线 → assistant-ui 的 `ThreadMessageLike` |
| `src/surfaces/astryx` | Astryx 表面（默认，`ChatVirtualizer` 虚拟化） |
| `src/surfaces/shadcn` | 裸 Tailwind 表面（无 chat 库） |
| `src/assistant-ui` | assistant-ui 官方模板（复制进来维护） |
| `src/components` | 三面共用：`Markdown` / 代码高亮 / `BotAvatar` / `AskCard` / `RunningIndicator` |

分组语义只有一份（`@diy-agent/chat-core` 的 `buildTimeline`），状态只有一份
（`ConversationStore`）。surface 之间**不互相 import**，壳层按注册表切换。

传输：`@diy-agent/chat-transport-http` 的 `HttpChatClient`（HTTP + SSE，断线退避重连），
不是 mock，也不是 RPC。

入口：`EntityChatApp`（页面组件）+ `styles.css`（主题令牌）。

```tsx
import { EntityChatApp } from '@diy-agent/entity-chat';
import '@diy-agent/entity-chat/styles.css';
```

## 语义约定

- 没有 @ → primary 回复；`@名字` → 命中者；`@all` → 全员；bot 之间只能单人 @
- 运行中可插话：发送按钮不会被停止键替换（停止在 `SpeakingBar`）
- 失败的归属是"那个 bot 的回复"（头像 + 名字 + 错误框），不是"用户消息未送达"
- 长会话：Astryx 用官方 `ChatVirtualizer`，另外两面窗口化 + 滑到顶自动补窗口

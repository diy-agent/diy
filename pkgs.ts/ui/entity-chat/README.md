# @diy-agent/entity-chat

实体即对话的 UI 包（实验）：**项目 / 任务 / bot 都是对话对象**。

- 项目 = 本机目录；项目与任务本体可直接对话
- owner bot 名字 = 实体名（`diy` 项目的 bot 就叫 `diy`）
- bot 是实体专属：可从现有 bot 里选（借用，归属不变）或新建（归当前实体）
- bot 也能独立对话（Bots 列表点进去）
- 模型目录照 diy 的 provider 结构：`account@provider/model`；默认 `chen56@opencode-go/deepseek-v4.1-flash`

入口：`EntityChatApp`（页面组件）+ `styles.css`（主题令牌）。

```tsx
import { EntityChatApp } from '@diy-agent/entity-chat';
import '@diy-agent/entity-chat/styles.css';
```

现状：**纯 UI + mock**，还没有接 RPC / 真模型。

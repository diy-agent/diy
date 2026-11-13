# UI 代码组织 + 双 Surface 对比方案（assistant-ui vs Astryx）

> 2026-11-13 · 回答两件事：UI 变大后怎么组织不失控；如何用 `~/git-ref/astryx` 做第二个聊天面板，
> 两个 tab 共用同一份数据与交互，只比"怎么画"。

---

## 0. 先看 Astryx 是什么（已核实）

`~/git-ref/astryx` 是 Meta 开源的设计系统（React 19 + StyleX，npm 已发 `@astryxdesign/core@0.7.15`）。
**它自带一套 Chat 组件族**：

```
ChatLayout / ChatMessageList / ChatMessage / ChatMessageBubble / ChatMessageMetadata
ChatComposer / ChatComposerInput / ChatSendButton / ChatDictationButton
ChatToolCalls / ChatSystemMessage / useChatStreamScroll / useChatKeyboard
```

也就是说：**Astryx 是"带聊天原语的设计系统"，assistant-ui 是"带 runtime 的聊天框架"**。
两者正好是两种架构取向，适合做对照。

安装（无需构建插件）：

```bash
npm i @astryxdesign/core @astryxdesign/theme-neutral @stylexjs/stylex
# 样式
import '@astryxdesign/core/astryx.css';
import '@astryxdesign/theme-neutral/theme.css';
```

---

## 1. 目标分层：四层，单向依赖

```
apps/diy2                   组装 + server（BFF）
   │
pkgs.ts/ui/chat-shell       侧栏 / 实体 / 模型 / tab 容器
   │
pkgs.ts/ui/chat-surface-*   两个表面（assistant-ui / Astryx）
   │
pkgs.ts/ui/chat-core        ConversationModel / reducer / client / mock / fixtures
   │
pkgs.ts/agent/protocol      纯类型：Item / Event / Command / Receipt / Entity / Bot
```

**依赖规则（硬）**

1. `protocol` 只放类型 + 纯函数，**禁止 import React / node / 任何 kit**；
2. `chat-core` 禁止 import React / assistant-ui / astryx（可以有极薄的 hooks 子路径，但 model 必须无框架）；
3. 每个 `surface` 只依赖 `chat-core` + 自己的 kit，**surface 之间禁止互相 import**；
4. `chat-shell` 只依赖 `chat-core` 与 surface 的**注册表**（数组），不写 `if (tab === 'astryx')`；
5. `apps/diy2` 只做组装，不写业务组件。

---

## 2. chat-core 的形状（这是"不失控"的地基）

```ts
// 无框架
interface ConversationModel {
  get(): ConversationState;              // items / deliveries / capabilities / seq
  subscribe(fn: () => void): () => void;
  intents: {
    send(text: string): void;
    steer(text: string): void;
    cancel(): void;
    approve(toolCallId: string, ok: boolean): void;
    setModel(target: string, modelKey: string): void;
  };
}

// 纯函数：事件 → 状态
function reduce(state: ConversationState, event: Event): ConversationState;

// 客户端：mock 与 http 同契约
interface ChatClient {
  snapshot(afterSeq?: number): Promise<Snapshot>;
  subscribe(afterSeq: number, onEvent: (e: Event) => void): () => void;
  post(entityId: string, command: Command): Promise<Receipt>;
}
```

表面接口：

```ts
interface ChatSurface {
  id: 'assistant-ui' | 'astryx';
  name: string;
  Component: FC<{ model: ConversationModel; ui: UiState }>;
}
```

`uiState`（展开/密度/滚动位置）与领域状态分开；surface 不持有业务状态。

---

## 3. 单包内部怎么放（长了也不乱）

```
chat-surface-astryx/src/
├── surface.tsx          实现 ChatSurface（挂载、滚动、键盘）
├── renderers/
│   ├── registry.ts      Item.kind → 组件（不是 if 链）
│   ├── chat.tsx
│   ├── notice.tsx
│   ├── tool.tsx
│   └── error.tsx
├── composer/
│   ├── composer.tsx     输入 + 发送/停止
│   └── mentions.tsx     @ 补全（可选）
├── features/
│   ├── steer/           {model.ts, view.tsx, test.tsx}
│   ├── approval/
│   └── delivery/
└── styles.css
```

**规则**

- 一个 feature 一个目录，固定三件套（有逻辑/有视图/有测试）；
- 新增 Item kind **只加 renderer 注册项**，不改 surface 主文件；
- 文件 ≤ 250 行、单 surface 包 ≤ 3k 行；超了就写拆分计划（不是继续加）；
- 共享行为（排序、折叠、投递合并、@ 解析）必须下沉 `chat-core`，不允许两个 surface 各写一份。

---

## 4. 防失控的五个机制（可执行，不靠自觉）

| 机制 | 做法 | 触发 |
|---|---|---|
| **边界检查** | `scripts/check-ui-boundaries.mjs` 扫 import，按 allowlist 报违规 | 提交前 / CI |
| **契约版本 + fixture** | `protocol/version.ts` + `fixtures/events.json`；改契约必须同时改 fixture | 改 protocol 时 |
| **Parity 测试** | 同一事件 fixture 分别喂 A/B surface，断言语义树（文本/角色/工具卡数量/投递 chip），不截图 | 每次 surface 改动 |
| **Capability 驱动** | `capabilities.has('steer')` 决定按钮，不写 `surfaceId === …` | UI 功能开发 |
| **功能准入模板** | 契约(如需) → core reducer + mock → A → B → parity test | 新功能 |

---

## 5. 双 tab 对比方案

```
chat-shell
├── Sidebar（实体 / bots / 模型）
└── Tabs
    ├── Tab A：assistant-ui surface（官方模板 + runtime）
    └── Tab B：Astryx surface（Chat* 组件 + 我们的 model，不引 assistant-ui）
        ↑ 两个 tab 共用同一个 ConversationModel 实例与同一个 SSE 连接
```

**共用**：实体选择、模型、事件流、Item、排序、投递、@ 解析、命令。
**各自实现**：消息渲染、工具卡、composer、滚动/键盘、主题。

### L0 功能对齐清单（第一版必须一致）

- [ ] 流式文本
- [ ] 工具调用卡（含运行中/失败）
- [ ] 多 agent 作者行（名字/颜色/角色）
- [ ] 投递 chip（已收到/失败）
- [ ] notice 行
- [ ] 停止按钮
- [ ] 空态/错误态
- [ ] 消息顺序（turn/order）

> @ 补全、审批、steer 队列放到 L2，两个 surface 同步做（届时比较"加功能的成本"）。

### 对比指标（记录到文档）

| 指标 | 说明 |
|---|---|
| 代码量 | 每个 surface 的文件数 / 行数（不含复制模板） |
| 首次跑通时间 | 从安装到能对话 |
| 滚动/键盘/无障碍 | 默认行为 vs 需要自己写 |
| 工具卡定制成本 | 改一个卡片的行数 |
| LLM 写码正确率 | 让 agent 给两个 surface 各加一个"新工具卡"，一次通过率 |
| 运行时归属 | 消息状态在谁手里（这是架构差异的核心） |

---

## 6. 三天计划（与后端计划并行，不互相阻塞）

| 天 | 内容 | 验收 |
|---|---|---|
| D1 | 抽 `chat-core`（model/reducer/client/mock/fixtures）+ `chat-shell` 的 tab 容器；Tab A 接上 | A 行为与现在完全一致；core 零 React import |
| D2 | `chat-surface-astryx` 完成 L0（装 core/theme/stylex + CSS；用 ChatLayout/List/Message/Composer） | 两 tab 同实体、同事件流，功能对齐清单全过 |
| D3 | parity 测试 + 边界脚本 + 对比记录 | 同一 fixture 两 surface 语义树一致；边界检查 0 违规 |

后端那条线（事件日志 + steer/cancel）只改 `chat-core` 的 client/reducer，不动 surface。

---

## 7. 风险与止损

| 风险 | 止损 |
|---|---|
| 过早抽象，core 变成第二个大包 | 只抽"已经有两个 surface 用到"的东西；一次迁一个能力 |
| Astryx beta / StyleX 构建问题 | 先只在 Tab B 验证；坏了不影响 A |
| 双 surface 维护翻倍 | 用 parity 测试逼齐；共享逻辑强制下沉 core；surface 禁止互相 import |
| 对比结论被"功能不同步"污染 | L0 清单 + 同一 fixture 是硬门槛，功能不齐不比较 |

---

## 8. 一句话

**UI 失控的根因不是文件多，而是"共享逻辑没有归属 + 表面之间没有边界"。**
四层（protocol / core / surface / shell）+ 两个机制（边界检查、parity 测试）就能让 UI 继续长大而不互相污染；
双 tab 只比"画"，数据与交互同源，比较结论才有效。

---

## 9. 实施进度（2026-11-13 晚）

已落地，且与本文档的依赖规则一致：

```
pkgs.ts/agent/protocol            纯类型：Item / AgentEvent / Command / StreamEvent / Entity / Bot / Delivery
pkgs.ts/ui/chat-core              （types.ts 只做再导出）
    types.ts        Item / Bot / Delivery / Command / StreamEvent
    reduce.ts       StreamEvent → ConversationState（纯函数）
    timeline.ts     ★ Item[] → TimelineEntry[]：唯一的分组逻辑（parity 锚点）
    mention.ts      ★ @ 查询/过滤/补全/键盘移动（surface 无关）
    store.ts        ConversationStore（get/subscribe/send/cancel/reload）
    client.ts       ChatClient 接口（不认识 HTTP）
    mock.ts         MockChatClient（同契约）
pkgs.ts/ui/chat-transport-http    HttpChatClient（唯一认识 HTTP/SSE 的包）
pkgs.ts/ui/entity-chat
    mentions.tsx    useMentionCandidates(targetId)：实体参与者 → 候选
    projection.ts   TimelineEntry[] → ThreadMessageLike（assistant-ui 出口）
    surfaces/astryx TimelineEntry[] → Astryx Chat 组件
```

**parity 的机制从"测试比对两棵树"改成"结构上只有一个树"**：

1. 两个 surface 都只读 `buildTimeline` 的输出，消息边界/作者/工具归属不可能分叉；
2. `@` 规则同样只有一份（`chat-core/mention`），assistant-ui 用 context 注候选、
   Astryx 用自己的 `ChatComposerInput triggers` 菜单，交互行为一致；
3. `pkgs.ts/ui/chat-core/tests/` 用固定 fixture 锁语义（多 agent 同轮交错、
   工具+文本同条、notice/error 独立、失败投递、streaming），在根 vitest projects 里
   以 `--project @diy-agent/chat-core` 运行。

**换 diy-rpc 的影响面**：新增 `chat-transport-rpc` 实现 `ChatClient`，
改 `entity-chat/src/store.tsx` 里 `new HttpChatClient(...)` 一行；core 与两个表面零改动。

### 表面差异决策（逐项定"跟谁"）

| 能力 | 决策 | 理由 |
|---|---|---|
| 消息分组 / 作者 / 工具归属 | **跟 chat-core**（唯一实现） | 分叉必出 bug；已由 timeline 测试锁住 |
| `@` 候选与补全规则 | **跟 chat-core** | 同上；UI 实现各用各的（popover vs triggers） |
| 会话错误（加载/传输失败） | **跟统一样式**（`components/ErrorBar`） | 之前两边都不显示，失败时界面"什么都没发生" |
| 空态 | 各用各的 | assistant-ui 有欢迎建议，Astryx 只有一行提示；属于产品风格差异 |
| 长消息折叠 / 滚动按钮 | 各用各的 | 框架自带能力不同，不影响语义 |

`ConversationModel` 的方法改为箭头属性（`reload/send/cancel`）：surface 可以把
`conversation.reload` 直接当 `onRetry` 传，不会因为解绑 `this` 静默失败
（这个 bug 之前让"重试"按钮点了没反应）。

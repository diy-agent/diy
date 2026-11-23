# 对话表面收敛到两面：能力对齐 + 删掉 assistant-ui（2026-11-24）

> 结论先行：**保留 Astryx 与 shadcn 两面并把能力对齐，删除 assistant-ui 面**。
> 删除的依据不是行数，而是「它的高级能力在本仓的模型里没有对应事实」——
> 渲染出来点不动的东西，留着只会让人以为我们有分支对话 / 编辑重发。

## 0. 三个面到底是什么关系

常见的误解是「三个平等的选项」。实际是两层：

- **Astryx 面**：设计系统 `@astryxdesign/core` 的 Chat 组件族（`ChatMessage` / `ChatComposer` /
  `ChatVirtualizer`）+ 我们自己的 `chat-core` 时间线。
- **shadcn 面**：**一个 shadcn 组件都没用**（这点在 2026-11-23 的评估里被单独纠正过）——
  它是裸 Tailwind 画的同一条时间线，零组件库依赖。
- **assistant-ui 面**：一个完整的一对一 chat 框架（runtime + 2861 行 registry 件 + 162 行投影）。

前两个是「怎么画同一条时间线」的两种做法；第三个是「换一套世界观」。

## 1. 为什么删第三面（实测）

| | assistant-ui 面 | Astryx 面 | shadcn 面 |
|---|---|---|---|
| 代码量 | **3184 行**（ChatPanel 161 + registry 件 2861 + projection 162） | Surface 384 + mapping 123 | Surface 383 → 543 |
| 数据来源 | **二次投影** `TimelineEntry` → `ThreadMessageLike` | 直吃 `TimelineEntry` | 直吃 `TimelineEntry` |
| 传递依赖 | **10 个**（`@assistant-ui/{core,store,tap}`、`assistant-cloud`、`assistant-stream`、`radix-ui`、`react-textarea-autosize`、`safe-content-frame`、`zod`、`zustand`） | Astryx 三包 + StyleX | **0** |

它的「高级能力」有一半没有数据接线（`rg 'onEdit|onReload|branch|suggestions|adapters'`
在 `ChatPanel`/`projection` 里零命中）：

| 能力 | 渲染了 | 能用吗 |
|---|---|---|
| `BranchPickerPrimitive`（消息分支） | 是 | ✗ 投影里没有分支/版本概念 |
| `EditComposer`（编辑重发） | 是 | ✗ 只实现 `onNew`/`onCancel`，`setMessages: () => undefined` |
| `ThreadPrimitive.Suggestions` | 是 | ✗ runtime 未提供 suggestions |
| `ComposerPrimitive.Dictate` | 是 | △ 浏览器 Web Speech，未接我们的模型 |
| `AttachmentDropzone` + 附件件（180 行） | 是 | ✗ `store` / `projection` 里 attachment 零命中 |
| `ToolFallback` 的审批流程（1121 行里约 800 行） | 是 | ✗ `approval` 字段永远 undefined |
| `Parts` / `GroupedParts` / `Copy` / `ScrollToBottom` | 是 | ✓ **真的在用** |

另有四处与房间语义打架的补丁（每处都是框架默认假设 ≠ 我们的模型）：`isRunning: false`
（它默认会禁用输入并把发送换成停止，而插话是正常操作）、`MessageNotSentError` 兜回清空的
输入框、`document.querySelector('[data-slot="aui_thread-viewport"]')` 手动取视口挂滚动、
ask 卡片塞成 `data-ask` part 再由自定义渲染器拆回来。

**结论**：它更完整的是「一对一 chat」的通用形态，我们做的是「多成员房间 + 任务 + ask 卡片」。
真在用的四项能力（分段、工具组、复制、回到底部）加起来是一百多行，不值得为它维护一套 runtime。

## 2. 对齐做了什么

原则：**能共用的抽成共用件，不能共用的写清理由**。

| 能力 | 对齐前 | 对齐后 |
|---|---|---|
| 工具行 target（bash 取首段命令 / 文件取 basename / 60 字截断） | 两面各一份，shadcn 那份是简化版（直接 JSON 截断）→ **同一条数据两个界面显示不同** | `surfaces/shared.ts` 单一真源，`runsOf` / `toolTargetOf` / `plainTextOf` 都在这里，同一组测试守 |
| parts 分组（连续工具归组、error/ask 各自成块） | shadcn 面内联手写了一遍 | 同上，两面都 `runsOf` |
| `@` 提及补全 | 只有 Astryx 面有（用 Astryx 的 Typeahead）；shadcn 面 placeholder 写着「@ 一个 bot」却做不到 | shadcn 面接 `chat-core` 的 `mentionQuery` / `filterMentionCandidates` / `completeMention` / `moveActive`（**那套逻辑本来就在，是给已删那一面写的**），自己做浮层 + 键盘 + Esc 抑制 |
| 消息级复制 | 只有 assistant-ui 面有（`ActionBarPrimitive.Copy`），随它一起消失 | `components/CopyButton.tsx` 两面共用：shadcn 悬停浮现、astryx 气泡末尾低对比常驻 |
| 链接策略（桌面端开真窗口） | 只有 Astryx 面传 `openLinkInNewWindow`；shadcn 面点相对路径会在当前页导航，把对话顶掉 | `Markdown` 新增可选 `onLinkClick`，两面同一策略 |
| 空态提示 | 只有 shadcn 面有 | astryx 面补同一句「还没有消息。发一句，或 @ 一个 bot。」 |
| 输入框重渲染 | astryx 面有 `MessageList` memo，shadcn 面没有（长会话里打字会带着整棵 Markdown 树重算） | shadcn 面补 memo |
| 回到底部 | 两面都没有（assistant-ui 面的 `ScrollToBottom` 随它消失） | 两面都有，实现不同：shadcn 面手写滚动 + `stickRef`；astryx 面改用 `ChatVirtualizer` 的 **attach 模式**（见 §4） |
| 代码块复制 | 共用 `Markdown` 里已有 | 不变 |

## 3. 清理清单

删除（19 文件 / 3184 行）：

- `src/assistant-ui/`（17 文件 2861 行）、`src/components/ChatPanel.tsx`（161）、`src/projection.ts`（162）
- `src/surfaces/registry.tsx` 只剩两项；`App.tsx` 缺省仍是 `astryx`

依赖（`package.json` 去掉 9 个）：`@assistant-ui/react`、`@assistant-ui/react-markdown`、
`@base-ui/react`、`class-variance-authority`、`clsx`、`tailwind-merge`、`tw-animate-css`、
`tw-shimmer`、`zustand` —— 后七个在删目录之外**零引用**，是随 registry 件进来的。

`styles.css`：去掉 `tw-animate-css` / `tw-shimmer` 两个 import、`data-open`/`data-closed`
自定义变体、`collapsible-down/up` keyframes（都只有已删组件在用）。语义色变量层原样保留。

`mentions.tsx`：去掉 `MentionBotsProvider` / `useMentionBots`（只有 assistant-ui 的模板用
context 取候选，删掉后成死件）。`useMentionCandidates` 两面都在用。

## 4. 刻意保留的差异（不是缺口）

- **虚拟化机制不同**：astryx = `ChatVirtualizer`；shadcn = `useWindowed`（只渲染最近 N 条 +
  滑到顶部补一窗）+ `content-visibility`。两者都满足「长会话 DOM 有界」。
- **astryx 面改用了 `ChatVirtualizer` 的 attach 模式**：own-container 模式下它不暴露滚动元素，
  我们既监听不到「用户上翻了」，也给不出「回到底部」的入口；attach 模式把滚动容器交给我们，
  代价是 follow-at-end 也归我们（官方文档明确要求这个容器「不自己跑 follow」，
  否则两个写入者抢同一个位置）。实测：新消息到达后 `scrollHeight` 从 368 长到 534，
  gap 始终 0 —— 跟随生效。副作用是 ask 跳转用的 `anchorToKey` 在 attach 模式下走的是
  同一套 handle，**尚未在真实 ask 流程里实测**（估且记在这里，第一次遇到 ask 时核对）。
- **`@` 的判定由各自的输入框负责**：astryx 面走 Astryx 的触发器菜单（规则在库里），
  shadcn 面走 `chat-core` 的正则（只认「文本末尾的 @」）。候选与补全结果一致，
  差异只在「光标在中间时会不会触发」——若要统一，改 `chat-core/mention.ts` 一处即可。
- **不做**：编辑重发 / 分支 / 语音 / 附件 / 工具审批。不是来不及，是**模型里没有这些事实**
  （没有消息版本、没有 attachment 字段、没有 approval 协议）。先把事实做出来再谈 UI。

## 5. 验证

- `./sha.sh check`：全绿（tsc + oxlint + 护栏）
- `@diy-agent/entity-chat` 单测 14 文件 / 139 条通过；`@diy-agent/chat-core` 6 文件 / 47 条通过
- lab 实机（worktree 内的 `run/diy2/lab`，Chrome 驱动）：

| 验的什么 | 结果 |
|---|---|
| 表面切换只剩两项 | 按钮 = `["Astryx","shadcn"]` |
| shadcn 面 `@` 补全 | 打 `@` 弹浮层，候选 `diy(owner)` / `小满`；输入「小」过滤到 1 项；Enter 补成 `@小满 `；浮层关闭 |
| `@` 的边界 | 光标在中间插 `@x` 不弹（chat-core 规则只看末尾，符合预期） |
| 复制（shadcn 面） | 剪贴板实际拿到「你好，我是 diy，…」；按钮 1.5s 内显示「已复制」 |
| 复制（astryx 面） | 剪贴板同样拿到全文 |
| 回到底部（shadcn 面） | 底部无按钮 → 滚到顶出现 → 点后 `scrollTop` 0→137、按钮消失 |
| 回到底部（astryx 面） | 同上（`scrollTop` 0→145）；attach 模式下 follow 另测：内容 368→534，gap 恒 0 |
| 空态 | 两面都显示「还没有消息。发一句，或 @ 一个 bot。」 |
| console | 两面零错误零告警 |

## 6. 以后要不要再引第三面

判据写在这里，避免下次从头吵：

1. 需要**消息分支 / 编辑重发**（产品决定要这个交互）→ 先给模型加消息版本，再评估是自研还是引框架。
2. 需要**附件 / 图片**→ 先在协议里加字段，UI 面才有东西可渲染。
3. 需要**工具审批**→ 先定义 approval 协议；那 1121 行 `ToolFallback` 才有意义。

在满足任一条之前，引第三方 chat 框架只会重演这一次：**为不消费的能力付 runtime 与依赖**。

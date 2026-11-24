# 长任务的「执行状态」：到期判定 · 进展时钟 · 归因（## D 档）

> 2026-11-24。起因：一个 turn 可以**永远挂着** —— 协议里每个"在跑 / 在等"的状态位都存在，
> 但**没有一个有到期**，而 `RunningIndicator` 把"还不知道要多久"显示成了**一直在推进**的秒数。
> 本文定：判据放在哪、哪些 await 该杀哪些不该、UI 露出到什么程度（选 D：渐进揭示 + pending 注册表诊断面）。

## 1. 现状（逐条核过代码）

| 事实 | 位置 | 说明 |
|---|---|---|
| 「谁在跑」是显式状态 | `protocol/src/types.ts` `{kind:'running', botIds}` | 房间广播，不由 UI 猜 |
| `speaking` 由 `busy` 增删 | `entity-runtime/src/room.ts:793` | `busy:true` 加、`busy:false` 删 |
| 只在**变化**时广播 | `room.ts:592`（`lastRunningKey`） | 卡死后 key 不变 ⇒ 再也不发事件 |
| `RunningIndicator` **已经在显示秒数** | `entity-chat/src/components/RunningIndicator.tsx` | `since={entry.at}` = 条目**创建**时刻 |
| 注释把秒数当进展 | 同上 file 头部 | 「秒数一直在涨 = 还在推进」—— 假信号 |
| 结局判据唯一、已很完整 | `entity-runtime/src/end-reason.ts`（239 行） | 8 种 type + note + `adviceOf` |
| `Tooltip kind` 已有 running/ok/error | `chat-core/timeline.ts` `partOf` | 工具行能看到"在跑" |
| 结局广播是 ephemeral | `protocol` `turn.end` | 注释明确：不进快照，靠 notice 持久 |

**结论：不缺状态位，缺三个数值 + 一个判定。** 而且 **`busy` 没有任何到期** —— `busy:false` 永不到来，
`speaking` 永真，转圈能转一整夜。

## 2. 三个缺口

1. **没有到期**：所有 await 都是"永真"。`endReasonOf` 只在**流结束之后**才被调用；"流不结束"根本不进入它的视野。
2. **没有进展时钟**：唯一的 `elapsed` 是"从条目创建到现在"，**单调递增、与任务死活无关**。它答的是"用户等了多久"，被当成"任务跑了多久"在显示。
3. **没有归因**：`speaking:['bot']` 说的是"它在跑"，答不出"卡在哪个 await 上"（模型流？某个工具？还是它问完问题了在等用户？）。用户只能 `ps` + `lsof` + `sqlite3`。

## 3. 设计：判据集中在 `entity-runtime/src/progress.ts`（新文件）

延续 `end-reason.ts` 的做法 —— **判据与文案分离、判据文件保持纯净**（不 import db/room，可在浏览器里重放），
`progress.ts` 只做一件事：**拿着"当前所有 pending"和"最后一刻进展时刻"，决定"是否该收"**。

### 3.1 核心值

```ts
// 服务端为每个 running turn 维护一份（房间级，不落库）
interface TurnProgress {
    turnId: string;
    botId: string;
    /** 本轮第一字节到达（或开跑）时刻：答"首包慢不慢" */
    startedAt: number;
    /** 最后一刻有进展的时刻：**唯一的 stall 判据** */
    lastProgressAt: number;
    /** 此刻挂着哪些 await（注册表；同时驱动 UI 归因与诊断面） */
    pending: Pending[];
}

interface Pending {
    /** `model-stream` / `tool:<name>` / `ask:<id>` / `compact` —— 机器读 */
    what: string;
    enteredAt: number;
    /** 这个 await 有没有"活的证据"（工具输出在长 / 流在吐字） */
    heartbeat: { at: number; from: 'stream' | 'tool-output' } | null;
}
```

### 3.2 谁给 `lastProgressAt` 续期

**任何 `AgentEvent` 都算进展**：`run.started` / `text.delta` / `reasoning.delta` / `tool.started` / `tool.completed` / `run.finished`。

⚠️ **但只靠 AgentEvent 会误杀长工具**：`bash` 跑 12 分钟期间**一个 AgentEvent 都没有**（模型在等
`tool.completed`），idle 会一路涨到 12 分钟。所以工具执行器必须报**二级心跳**：
background job 的输出增长（tail 变了）就是心跳，写回 `pending.heartbeat`。

### 3.3 判定表：**不是所有 await 都按同一阈值杀**

| await | 阈值 | 到点做什么 | 为什么 |
|---|---|---|---|
| `model-stream`（首字节未到） | 60s | **abort 本轮** → `stalled` | 连上了不吐字 = 明确故障 |
| `model-stream`（流中静默） | 120s | **abort 本轮** → `stalled` | 同上 |
| `tool:<name>`（无心跳） | 300s | **只提示，不杀** | 工具可能合法长跑；杀了等于毁掉工作 |
| `tool:<name>`（有心跳） | — | 不杀，UI 显示"有进展 · 最近 3s" | 这就是场景②，绝不能误杀 |
| `ask:<id>` | — | 不杀 | 已由 ask 寿命规则管（`ask.ts`） |
| `compact` | 300s | 只提示 | 压缩长会话可以慢 |
| turn 总计（墙钟） | 1800s | 只提示 + 允许一键停 | 防"无限多步但每步都在动" |

**到点能杀、杀得掉的前提是先能 `abort`。** 当前 abort 路径已存在（停止按钮 → `conversation.stop`），
`progress.ts` 复用它，并在 abort 后**照常走 `endReasonOf`**，只多一个"为什么 abort"的注入口。

### 3.4 结局词汇：`TurnEndReason.type` 加 `stalled`

不要塞进 `unknown`：`unknown` 的语义是"**我们不知道**为什么停"（`end-reason.ts` 两条铁律之一），
而 stall 我们**非常知道** —— 知道在等谁、等了多久。混进 `unknown` 会让"未知按错误处理"这条铁律变味。

```ts
// protocol/src/types.ts TurnEndReason.type 追加
| 'stalled'
// 字段
awaiting?: string;   // 卡在哪个 await
idleMs?: number;     // 多久没进展
```

配套三处（都在 `end-reason.ts` 里加一个 case，模式与 `max-tokens` 完全一致）：
- `endItemsOf`：一条 `notice`，`kind:'stalled'`
- `adviceOf`：`"model-stream"` → 「重试；总在这一步断就查网关超时」；`tool` → 「工具在跑，别急」
- `publishable`：`false`（没说完的话不进公共日志，与 `max-tokens` 同）

### 3.5 判定序：`stalled` 必须排在 `aborted` 与 `!finished` 之前 ⚠️

现在的顺序是 `failed > aborted > !finished > finishReason`（`endReasonOf`）。
stall 到点是**我们主动 abort**，直接塞进去会被判错，两条路都错：

- 走 `aborted === true` → `interrupted`（「你按的停，不需要动作」）—— 语义完全反了
- 走 `!finished` → `unknown/no-finish`（「查网关」）—— 丢掉了我们**明明知道**在等谁、等了多久

所以 `EndFacts` 加两个字段，判定序变成：

```ts
abortedBy?: 'human' | 'deadline';
stall?: { awaiting: string; idleMs: number };

// 实际落地顺序（2026-11-24 实现时修正，见下）：
//   deadline > aborted(human) > failed > budget > !finished > finishReason
```

⚠️ **实现时改了两处顺序**（计划原来写 `failed > aborted(human) > stalled > …`）：

1. **`deadline` 排在最前**（连 `failed` 都在它后面）：abort 之后 SDK 抛 `AbortError` / 工具报被中断
   都很常见，那是**我们杀的后果**。把它说成 `error` 就把「失联 120s」这个真事实丢了。
2. **`aborted(human)` 排在 `failed` 之前**：与本节约束 3「人按停仍然最优先」一致（原伪代码与这句话自相矛盾）。
   人按的停是事实，不是故障；`interrupted` 不该被次生异常降级成 `error`。

另：`stall` 事实要在 **abort 那一刻**取（`watch.stall()`），不能在 `finally` 里现取 —— abort 之后
run 还会吐 `run.failed`，`watch.apply` 会清空 pending，那时再问就只剩 `undefined`。

三条硬约束：
1. `stalled` 在 `!finished` **之前** —— 否则永远到不了（stall 时流本来就没结束）
2. `budget`（步数 / 墙钟用尽后的主动收）也在 `!finished` 之前 —— 否则被判成 `no-finish`，同一件事出现两种说法
3. 人按停仍然最优先 —— `interrupted` 是事实，不是故障；`abortedBy` 让这两者分开而不是靠猜

## 4. 协议：`progress` 走 ephemeral，**不进快照、不进 items**

```ts
// protocol StreamEvent 追加（与 turn.end 同类：事实广播，不进快照）
| {
      kind: 'progress';
      botId: string;
      turnId: string;
      /** 此刻挂着什么（人读短语在 UI 拼，这里给机器码） */
      awaiting: string;
      /** 距最后一次进展多少毫秒（服务端算，客户端从这点起自走） */
      idleMs: number;
      /** 这个 await 有没有活的证据 */
      alive: boolean;
  }
```

**节流**：室内只在 `(awaiting 变化 | alive 翻转 | 跨越 60/120/300s 阈值)` 时发一条，
最多每 5s 一条。客户端拿 `idleMs` 做初值 + `setInterval` 自增，不需要服务端每秒广播、也不需要时钟校准。

**绝不写进 `items`**：时间线是给人和别的 bot 看的上下文，心跳污染它会让模型以为发生了什么事。

## 5. UI 落点（选 D 档）

### 5.1 `RunningIndicator` 改语义（最小、收益最大）

现在是 `执行中 1847s`（从条目创建算起，永远在涨）。改成两段式：

```
<Spinner> 等待模型响应 · 已 1m03s      （60s 前：<Spinner> 执行中 12s，与现在无差别）
<Spinner> bash 运行中 · 有进展 3s 前   （有心跳：绿色，永不报警）
```

改动点：
- prop 从 `since: number` 变成 `{ idleMs, awaiting, alive }`（`since` 保留给"整轮已用时"的可选第二行）
- 文案映射独立成 `awaitingText(awaiting)`，与 `end-footer.ts` 同风格
- **秒数从"等了多久"变成"多久没动"**，且只在 idle 档显示给用户看 —— 这是本方案唯一必须改的既有组件

### 5.2 跨阈值才变颜色（渐进揭示）

| 时刻 | 样子 |
|---|---|
| < 60s | 与现在**完全一致**（正常思考不该变成跳动的界面） |
| ≥ 60s | 一行小字灰：`等待模型首个字节 · 1m03s`，右侧 `▾` |
| ≥ 120s | `RunningIndicator` 替换为 `notice(bad)`：`这一轮失联了：120 秒没有进展` + 重试链接 |

**"失联"必须是持久条目**（`notice`/`error` 落库）：`running` 与 `turn.end` 都明确不进快照，
只靠它们的话刷新后"卡过"这件事就消失了。

### 5.3 `PendingTable`（D 档诊断面，不进聊天流）

```tsx
// entity-chat/src/components/PendingTable.tsx（新）
// 数据源 = 同一份 progress 事件，不额外拉
<table>
  <tr><th>what</th><th>since</th><th>heartbeat</th><th>deadline</th></tr>
  <tr><td>tool:bash</td><td>3s</td><td class="ok">3s 前</td><td>300s</td></tr>
</table>
```

放两处：工作台（`workbench`）侧栏常驻；聊天面只在 `ContextPanel` 的调试区折叠显示。
**默认不渲染** —— 这是"能一眼答出卡在哪"的工具，不是日常信息。

### 5.4 `SpeakingBar` 顺带

`正在说话…` 在 `tool` 阶段是错的（它没在说话，在跑工具）。改成从 `awaiting` 拿短语：
`正在调用 bash…` / `正在等模型…`。同一个数据源，零额外成本。

## 6. 测试（这一块是"判据能不能立住"的关键）

`progress.ts` 保持纯净 ⇒ 能用**假 clock + 脚本化事件流**直接测，不需要真等 120 秒：

1. **挂死**：模型 `run.started` 后不吐字节 → 假 clock +60s 不杀、+120s 杀、`endReason.type === 'stalled'`、`awaiting==='model-stream'`、notice 落一条
1b. **判定序**：stall 导致的 abort 断言 `type==='stalled'` 而**不是** `interrupted` / `unknown`；人按停断言 `interrupted`
2. **不误杀长工具**（对应 demo 场景②）：`tool.started` 后每 30s 一次 job 输出心跳 → 假 clock +12min **不杀**，`alive===true`
3. **工具无心跳**：300s → **只提示不杀**（断言 `abort` 未被调用）
4. **正常说完不被干扰**：`text.delta` 持续 → 永不触发
5. **步数耗尽不是 stall**：`max-steps` 的 notice 只有一条，不叠加 stalled
6. UI：`RunningIndicator` 三档快照（< 60s 与现在逐像素一致）

## 7. 分刀（每刀独立可验证、可回滚）

| 刀 | 内容 | 验收 | 量 |
|---|---|---|---|
| **1** ✅ | `progress.ts` + 判据表 + 单测（假 clock） | 上面 5 条测试绿；**不接 UI、不接协议** | ~3h |
| **2** ✅ | `running` 接上 progress（服务端 abort 路径 + `stalled` 类型 + `endItemsOf`/`adviceOf`/`publishable`） | 卡死 120s 后时间线出现 notice（用假模型手测） | ~3h |
| **3** | `progress` 事件 + `RunningIndicator` 三档 + `SpeakingBar` 文案 | demo 的三场景人工对照 | ~4h |
| **4** | `PendingTable`（工作台 + ContextPanel 调试区） | 卡住时能读出 `what/since/heartbeat` | ~3h |

1、2 刀是"内核能自愈"，3、4 是"人看得见"。**1+2 不做，3+4 就是把假信号画得更漂亮。**

### 刀 1+2 实况（2026-11-24）

`progress.ts` 296 行 + `tests/progress.test.ts` 13 绿；`session.ts` 里看门狗只做「定时问一次 → 到点 abort」，
`progressPolicy` / `progressTickMs` 可注入（测试把阈值降到几十毫秒）。`TurnEndReason` 已加 `stalled`
+ `awaiting` / `idleMs`。entity-runtime 全套 260 测试绿（`watch-cache` 是 macOS 文件监听在并发下的既有 flaky，本次全绿、单跑必绿）；
全量 `./sha.sh check` 绿。

**顺带查实的一条事实**（原计划 3.3 末尾那句「abort 路径已存在，复用即可」的成立条件）：
`pkgs.ts/agent/tools/src/shell/tool.ts:245` 把 `execOpts?.abortSignal` 传给 `runBash`，
`run.ts:497` 监听 `abort` 直接杀子进程 ⇒ **看门狗的 abort 能真打断 bash**；模型流由 SDK 的
`abortSignal`（`agent.ts:145`）负责。残余风险只剩「某个 provider / 工具不响应 signal」——
那属于另一个判据（外层超时），不在本轮。

**下游谁要跟、谁不用跟**（`TurnEndReason` 是公共接口，加 union 成员必须逐个过一遍）：

| 消费方 | 处理 | 判据 |
|---|---|---|
| `pkgs.ts/ui/chat-core`（`end-footer.ts`） | ✅ 加 case + 测试 | diy2 的正路 |
| `pkgs.ts/ui/entity-chat`（`EndFooterLine`） | 不用改 | 只调 `chat-core::endFooterOf`，`types.ts` 从 protocol re-export 同一份类型 |
| `apps/diy-app`（`shared/turn-end.ts` / `error-triage.ts` / `session-state.ts`） | **不改** | 用自己的 `TurnEndReason`（`main/services/local-blocks.ts`，「六个值」），local-agent 链上没有看门狗 ⇒ 永远产不出 `stalled`。硬塞进去是拿一致性换假覆盖 |

⚠️ `apps/diy-app` 那三个 switch 都**没有 default** —— 若哪天真把 `stalled` 塞进它的值域，`tsc`
在 `noImplicitReturns` 下会报「缺少返回」，运行时则静默返回 `undefined`（轮尾一片空白）。留着这张表
就是为了下次不让它被顺手「统一」掉。

## 8. 有意不做

- **不为每个 item 加 `updatedAt`**：心跳属于"这一轮"，不属于"这句话"；写了会诱导人去渲染"这条消息 3 秒前更新过"
- **不做自动重试**：stall 后自动重发会烧 token 且掩盖真故障，只给建议
- **不做全局"任务面板"**：pending 注册表是诊断口，不是导航；任务本体在 `task` 域，两者别混
- **不给 job 加超时杀**：工具层超时是另一件事（用户自己 `job kill`），本轮只做"看得见"

## 9. 风险

- **假阳性**：慢模型在 90s 才回第一个字节是常事。首包阈值做成**每 bot 可配**，默认 60s，且只提示不杀到 120s 才杀。
- **心跳成本**：bash 输出心跳从 job 的 tail 拿（已有的读路径），不新增 IPC 轮询。
- **多面一致**：`RunningIndicator` 两面共用，改它等于两面同时改 —— 这反而是好事（`SpeakingBar` 只在 shadcn 面有，astryx 面要对齐）。

## 附：demo

四档对照见 `/tmp/deadline-ui-demo/index.html`（时间轴拖到 0–30min；场景② 是 B 档误杀的反例）。
定稿后把"选 D 档的三张状态图"抽出来进 `docs/plans/` 旁边。

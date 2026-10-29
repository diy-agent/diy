# @diy/room

diy **协作空间内核**：成员表 + `@` 投递 + 忙闲。

依赖 `@diy/agent-session`（只依赖 `SessionPeer` 这个最小形状），**不认识任务**：

- 房间 id 由宿主给，本包不拿它去查任何东西
- 投递 = 把发言送进某个成员的会话（「会话在哪」是成员自己的事）
- 忙闲粒度 = 成员：两个 agent 可以同时说话，同一成员的消息串行

```ts
import { createRoom } from '@diy/room';

const room = createRoom({ id: 'room-1' });
room.addMember({ id: 'human:me', name: '我', kind: 'human' });
room.addMember({ id: 'agent:a', name: '甲', kind: 'agent', session: sessionA });
room.addMember({ id: 'agent:b', name: '乙', kind: 'agent', session: sessionB });

for await (const event of room.post({ from: 'human:me', text: '@甲 @乙 开工' })) {
    // 先出 message，再陆续出各个 agent 的 response
}
room.deliveryOf(event.id, 'agent:a'); // queued / delivering / delivered / skipped / failed
```

## 主线日志（publicLog）：一级数据

Room 主线 **只收两种消息**（##456「数据分层修订」）：

| kind               | 来源                           |
| ------------------ | ------------------------------ |
| `human`            | 人说的话                       |
| `agent-conclusion` | agent 一轮结束时的自然语言答复 |

agent 的过程（`agent-trace` / `tool-call` / `tool-result`）**永不进主线**，只在会话日志里。

**`text` 是正文副本，不是引用**：会话日志会被压缩 / 裁剪 / 丢弃，主线要在这之后还能读到原话。
`sessionId` / `messageId` 只是溯源线索。

```ts
room.publicLog; // [{ at, from, kind: 'human', text }, { at, from, kind: 'agent-conclusion', text, sessionId }]
```

## 收件人解析

1. 显式 `to`（成员 id 或 `@all`）
2. 正文里的 `@name` / `@all`
3. `focus`（隐式收件人）
4. 都没有 ⇒ **只落记录不投递**（`recipients = []`，UI 标「未投递」）

点名了不存在的人 ⇒ `room/unknown-recipient`；人的成员不会被投递（`skipped`）。

## 边界

- **属于本包**：成员表、收件人解析、投递状态机、事件流聚合、忙闲、主线日志（正文副本）
- **不属于本包**：单会话怎么跑与过程日志（`@diy/agent-session`）、任务状态（task 依赖 room，反向不行）、文件系统（`RoomStore` 适配器）

判据（意图测试 R7 静态扫 `src/**`）：任务 URI / 任务标识 / `@diy/task` / 文件系统模块 / `electron` / 应用数据根 命中即红。

需求真源：[`tests/intent.room.test.ts`](./tests/intent.room.test.ts)（R1–R7）。

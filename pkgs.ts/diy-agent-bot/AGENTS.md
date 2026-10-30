# @diy-agent/bot — bot 实体（身份 + 会话归属）

> 全仓契约见**仓库根 `AGENTS.md`**。本包**不认识 room / task / session 内核**：
> 身份只是 `BotConfig`，会话归属只是 session 目录里的一个 `bot.json`。

## 一句话

一个 bot = **一个身份（`BotConfig`）+ 一堆属于它的会话**。会话是主体，bot 只是标签：
删 bot 不删会话，会话可以没有 bot。

## 落盘形态（方案 B）

```
<home>/bots/<botId>/bot.json            BotConfig（id / name / persona / model / createdAt / updatedAt）
<sessionsDir>/<sessionId>/bot.json      { "botId": "<botId>" }   ← 归属
```

为什么归属记在 session 目录而不是 `bot.json` 里存 `sessionIds`：
**session 是主体**，bot 是它的一条属性；反过来存会让删 bot 连带丢数据、多 bot 共享会话也难做。
`sessionsDir` 由宿主指定（apps/chat 是 `<home>/sessions/chat`；缺省 `<home>/sessions`）。

## 硬约束（判据）

1. **源码里 `grep -c room` = 0**（`tests/bot.test.ts` 静态扫）；也不 import `@diy-agent/session` / `electron` / `@diy-agent/task`。
2. 删 bot 只删 `bots/<id>/`，会话目录一个不动。
3. `sessionsOf(botId)` 只返回归属该 bot 的会话。
4. 记忆接口**先留空**（##469 body 明确：这一刀不做记忆）。

## 取法

- `diy facts brief rule` — 全局硬约束
- 需求真源：`tests/bot.test.ts` + ##469 body

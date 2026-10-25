# @diy/persistence

> 命名 owner：**diy 主线（pkgs.ts）维护者**（当前 = 用户 ccc）。改包名 / 改导出面先问 owner。

本地 agent 的**会话持久化边界**（##432 刀 1）。它存在的唯一理由：把「会话在盘上长什么样」
从 `diy-app` 里切出来，让 core 只依赖**窄接口**。

## 为什么要有这个包

旧状态（##432 body 的病根 2）：`local-agent.ts` 既**写** `ops.jsonl`，又**读**它做重放，
还知道「`turns.jsonl` 的 `ref` 是 ops 的行号/字节偏移」。于是 ops 的格式被钉死在 core 里，
而 ops 是重放的唯一真源 —— 不敢动格式，进化被卡住。

切法（本包承担的全部存储知识）：

- **写 ops**：`createOpsAppender({ home, taskUri })` → `append(op)` 返回该行的字节锚点
  `{ offset, len, seq }`；`lastRef()` 给轮末记账用。
- **写/读 turns**：`appendTurnRecord`（轮次结论账，v1）/ `appendCompactionEntry`（**压缩边界**，v2）
  / `readTurnEntries` / `readBoundary`。turns 的 `ref` 由 appender 产出 —— core 拿不到行号。
- **降级链**：`checkOpsRef` / `synthesizeTurnOps` —— ops 明细读不出时，把 turns 折成只读文本历史
  （##424 已验收的行为，本包迁移时逐字保留）。
- **路径**：`keyOf` / `sessionIdOf` / 会话文件解析（`<home>/local/<uri 路径…>/<key>/<kind>.jsonl`，
  读侧双认旧平铺落位）。
- **按轮 seek**：`seekWindowStart` / `seekTurnStartAtOrBefore` / `isTurnStartAt` / 游标编解码。

## 边界（别扩）

- **不认识 `diyHome()`**：`home` 一律由调用方注入（包可在测试/CLI/其它宿主里跑）。
- **不 import core**：`diy-app` 单向依赖本包，反向没有。
- **不解释业务**：这里只有「文件 → 行/字节锚点」的知识；「哪些历史该发给模型」是 core 的事
  （`shared/context/history-limit.ts`）。

## `turns.jsonl` 的两种行

```
轮次记录  { v:1, turnId, at, state, user, texts:[{seq,text}], ref:{ ops:{offset,len,seq} } }
压缩边界  { v:2, kind:"compaction", at, limitTokens, dropped, headLine, cut:{ llmLine, turnId }, ref? }
```

- 轮次记录是**降级重建材料**（不是会话真源）：`texts` 收该轮全部 assistant 正文，工具正文归 ops。
- 压缩边界是**一次压缩事件**的落盘（##432 刀 2）：`cut.llmLine` 之前（除保头）被丢弃；
  之后每步只读它、**不重算**。`headLine` = 保头最后一条（前 600 token 永远保留）。

## 用法

```ts
import { createOpsAppender, appendTurnRecord, readBoundary } from "@diy/persistence";

const appender = createOpsAppender(home, taskUri);
const ref = appender.append(op);            // null = 写失败（不阻断流，但调用方不许广播）
if (ref) {
    appendTurnRecord(home, taskUri, { turnId, at, state: "ok", user, texts: [], refFirstOp: ref });
}
const boundary = readBoundary(home, taskUri); // 最近一条压缩边界（null = 从未压缩）
```

# @diy/talk

diy **对话容器内核**：事件 / 锚点 / 反应原语 + role 翻译铁律 + 装配器。
零依赖、纯 TypeScript、Node / 浏览器 / Electron 通用 —— 不认识文件系统，**不取时间**（`at` 由调用方传入）。

一句话概括它解决的问题：多 agent 围绕同一件事互相审查时，「谁针对谁的什么说了什么」必须是**结构化数据**，
不能靠文档章节标题与肉眼对齐的轮次编号（##166 §7 的实证：靠文字寻址必然覆盖、必然编号幻觉）。

设计与决策见 [`SPEC.md`](./SPEC.md)；意图测试见 [`tests/intent.talk.test.ts`](./tests/intent.talk.test.ts)（R1–R7）与 [`tests/intent.assemble.test.ts`](./tests/intent.assemble.test.ts)（A1–A6）。

## 快速开始

```ts
import { assemblyRole, assertThreadRefs, createReaction, docRangeAnchor } from '@diy/talk';

// 有人对文档第 32 行留了批注 —— 锚点钉住「哪一版」的哪一段
const target = docRangeAnchor('rev-7', 31 * 40, '此处有问题');

const r1 = createReaction({
    id: 'r1', author: 'b', turnId: 't1', target,
    content: '这一行漏了并发写保护', at: '2026-10-13T00:00:00.000Z',
});
// 回复是**结构化寻址**：引 id，不写「R1」这种文字
const r2 = createReaction({
    id: 'r2', author: 'c', turnId: 't1', target, replyTo: 'r1',
    content: '同意，且需要补一条锁顺序说明', at: '2026-10-13T00:00:05.000Z',
});

assertThreadRefs([r1, r2]);                             // 悬空 replyTo / 重号 / 异锚点在这里报错

assemblyRole({ kind: 'speech', author: 'b', self: 'a' }); // => 'user'（绝不能是 'assistant'）
```

## 装配（一次 LLM 请求的 `messages[]`）

```ts
import { assemble } from '@diy/talk';

// 多源：发言线 / 私有过程 / 资料演进；策略选投影；window 由宿主注入（内核不自作主张）
assemble({
    sources: [
        { type: 'reactions', data: { reactions: [r1, r2] } },        // 发言线
        { type: 'trace', data: { events: [ownToolRun] } },           // 自己的过程（他人过程永不进入）
        { type: 'material', data: { events: [revision] } },          // 文档修订
    ],
    strategy: 'text-only',   // 'full' | 'text-only' | 'changes-only'
    selfId: 'a',
    window: (messages) => messages.slice(-20),   // 可选：宿主给裁剪 / 摘要函数
});
// => Message[]（{ role: 'user' | 'assistant', content }；他人发言绝不为 assistant）
```

三条内置策略（模式 = 一份装配策略，##166 结论 4）：`full`（模式 1 全量档案，**他方过程除外**）·
`text-only`（模式 2 去 tool/thinking、保 `replyTo` 寻址）· `changes-only`（模式 3 文档修订 + 批注线）。

> **process 私有 + window 边界**（review1 意见 1/2）：他人的 tool/thinking **永不进入本次装配**（连 `full` 也不，
> 依据 ##166 结论 6 + §3.5「仅自己可见」）；该不变量由 `role.ts` 的 `assemblyRole` 最终把关。
> `window` 是宿主注入的**可信代码**，其输出不再复核 —— 上文「他人发言绝不为 assistant」的保证**仅覆盖装配器
> 自身产出（window 之前）**。

## 四个原语

| 导出 | 是什么 |
|---|---|
| `Anchor` | 指向哪：`message` / `doc-range`（钉 revision）/ `task-field` / `node`（工作流泳道） |
| `Event` | 容器无关的记录：`{ id, author, anchor, content, causes, at }` |
| `Reaction` | 对话侧的发言：`{ id, author, turnId, target, replyTo, content, at }`，`replyTo` 是 id 引用 |
| `assemblyRole` / `assertRoleAssignments` | role 翻译与铁律核对（他人发言绝不能装配成 `assistant`） |

序列化：`eventToJson/FromJson` · `reactionToJson/FromJson` · `threadToJson/FromJson`（读侧同样做完整校验，不静默丢弃）。
`*ToJson` 缺省缩进多行；传 `{ compact: true }` 得紧凑单行（供 jsonl）。读侧可选 `{ allowUnknown: true }` 做前向兼容。

## 硬约束

- **零依赖**：不 import `node:fs` / `electron` / `@diy/app`（意图测试 R7 静态把关）。
- **不取时间**：`at` 由调用方传入（须 ISO-8601）⇒ 可重放、可测试。
- **只做数据与纯函数**：不做存储（不碰 fs）；装配（`assemble`）是纯函数，不碰具体 LLM SDK（见 SPEC §4/§7）。
- 非法输入一律抛 `TalkError`（带 `code` + 点路径 `path`），**绝不静默丢弃**。

## 开发

```bash
cd pkgs.ts/diy-talk
./sha.sh test          # 意图测试（R1–R7 + A1–A6）
./sha.sh check         # 本包类型 + lint
# 全仓检查（含产物 / 可执行位护栏）：在仓库根跑 ./sha.sh check
```

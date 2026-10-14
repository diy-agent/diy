# @diy/talk

diy **对话容器内核**：事件 / 锚点 / 反应原语 + role 翻译铁律。
零依赖、纯 TypeScript、Node / 浏览器 / Electron 通用 —— 不认识文件系统，**不取时间**（`at` 由调用方传入）。

一句话概括它解决的问题：多 agent 围绕同一件事互相审查时，「谁针对谁的什么说了什么」必须是**结构化数据**，
不能靠文档章节标题与肉眼对齐的轮次编号（##166 §7 的实证：靠文字寻址必然覆盖、必然编号幻觉）。

设计与决策见 [`SPEC.md`](./SPEC.md)；意图测试见 [`tests/intent.talk.test.ts`](./tests/intent.talk.test.ts)（R1–R7）。

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
- **只做数据与纯函数**：不做存储、不做装配（见 SPEC §4）。
- 非法输入一律抛 `TalkError`（带 `code` + 点路径 `path`），**绝不静默丢弃**。

## 开发

```bash
cd pkgs.ts/diy-talk
./sha.sh test          # 意图测试（40 例）
./sha.sh check         # 本包类型 + lint
# 全仓检查（含产物 / 可执行位护栏）：在仓库根跑 ./sha.sh check
```

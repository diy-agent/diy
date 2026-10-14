# @diy/flow

diy **工作流内核**：工作流定义 DSL + 泳道容器（单指针 / 打回）+ 轨迹折线投影。
纯内核（仅依赖 `@diy/talk` 的事件原语）：不认识文件系统，**不取时间**（事件的 `at` 由调用方传入）。

一句话概括它解决的问题：一条工作流 = 泳道图上的一条折线 —— 状态自上而下在泳道间变迁，打回时
从 from 画线回 to，最终形成完整行为路径（如 `A→B→C→B→D`）。**泳道 ≡ 节点（1:1）**，打回**不新建节点**
（只是轨迹再次穿过同一条泳道）。依据 ##311 §一 与 ##166 §14.2/§14.4。

## 快速开始

```ts
import { createEvent, nodeAnchor } from '@diy/talk';
import { defineWorkflow, project } from '@diy/flow';

const wf = defineWorkflow({
    id: 'dev',
    name: '开发工作流',
    entry: 'implement',   // 双向环两个节点都有入边，入口须显式指定
    nodes: [
        { id: 'implement', name: '开发', actor: 'agent', guard: ['prompt:dev_done'], hint: '开发完成 xx 任务，完成后提交给 Review 步骤' },
        { id: 'review', name: 'Review', actor: 'agent', guard: ['prompt:review_done'], hint: 'P0/P1 打回，全部有落点则放行' },
    ],
    // 打回边：from review 画回 implement；**不新建节点**
    edges: [
        { from: 'implement', to: 'review', kind: 'next' },
        { from: 'review', to: 'implement', kind: 'bounce' },
    ],
});

// 一条转移 = 一条 Event（anchor = node 指目标节点）
const at = '2026-10-13T00:00:00.000Z';
const ev = (id: string, to: string) =>
    createEvent({ id, author: 'review-agent', anchor: nodeAnchor(to), content: `→ ${to}`, at });

const proj = project([ev('e1', 'implement'), ev('e2', 'review'), ev('e3', 'implement')], wf);
proj.path.map((v) => `${v.node}#${v.seq}`); // ['implement#1', 'review#1', 'implement#2']
proj.visits.implement; // 2  ← 打回后第 2 次驻留，节点数仍是 2
```

## 三个导出

| 导出 | 是什么 |
|---|---|
| `defineWorkflow(def)` | 定义工作流：`nodes[]`（泳道） + `edges[]`（转移）；`edges[].from/to` 只能取节点 id（编译期护栏） |
| `createContainer(def).apply(event)` | 单指针容器：`apply` 返回新容器（不可变），位置唯一推进；打回 = 走 `bounce` 边 |
| `project(events, def)` | 折线投影（纯函数）：`{ currentNode, path: Visit[], visits }` |

`Event` 复用 `@diy/talk` 原语：`{ id, author, anchor, content, causes, at }`，其中 `anchor = { type: 'node', data: { nodeId } }`。

## 硬约束

- **泳道 ≡ 节点，1:1**；**打回不新建节点**（只让目标节点再驻留一次）。
- **零 IDE 依赖**：不 import `node:fs` / `electron` / `@diy/app`（意图测试 R7 静态把关）。
- **不取时间**：事件的 `at` 由调用方传入（须 ISO-8601）⇒ 可重放、可测试。
- 非法定义 / 非法转移一律抛 `FlowError`（带 `code` + 点路径 `path`），**绝不静默丢弃**。
- **本任务不做 guard 求值**（归 ##315）、**不做参数校验**（归 ##316）。

## 开发

```bash
cd pkgs.ts/diy-flow
./sha.sh test          # 意图测试（25 例）
./sha.sh check         # 本包类型 + lint
# 全仓检查（含产物 / 可执行位护栏）：在仓库根跑 ./sha.sh check
```

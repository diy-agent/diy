# 任务内部拆解：unit DAG（对齐结论 + 阶段一设计，2026-11-24）

> 结论先行：**task 不再分树，而是在 task 内部长出一张 unit 的 DAG**。
> unit 是 task 私有的轻实体（不进 `tasks` 表、不占 #号、侧栏看不见），由 agent 在聊天里
> 随时增删改连；`ready` 集合（前置全 done）是「现在该做什么」的唯一答案。
> 阶段一只做 **数据 + agent 工具 + 只读视图**，批次 / worktree / flow 全留阶段二。

## 1. 已定（用户裁，2026-11-24）

| # | 问题 | 结论 |
|---|---|---|
| 1 | 节点是什么 | **unit**：task 内的轻实体，不占 #号、不进侧栏、不算 task |
| 2 | 节点 vs worktree 执行单元 | **两层**：unit 是思考粒度（原子步），batch 是执行粒度（一个 worktree / 一条分支 / 一个 PR） |
| 3 | 谁改、留不留历史 | **agent 写**（人只读，要改就通过聊天让 agent 改）+ 每次变更留事件 |
| 4 | 取消语义 | **真删掉**（当前图里不留尸体） |
| 5 | 和 flow 的分工 | **第一刀不接 flow**（阶段二再让 flow 描述一个 batch 的生命周期） |
| 6 | 第一刀范围 | **数据 + 工具 + 图视图**；批次与自动执行留阶段二 |
| 7 | 怎么进上下文 | **全量注入**（先简单走，溢出线见 §6） |

## 2. 领域模型

```
unit     = { id, title, body, status }   id 形如 u1（task 内递增，跨 task 不唯一）
dep      = (from → to)                   语义：from 先做完，to 才能做（= from blocks to）
status   = open | doing | done           只有三个；没有 cancelled（删就是删）
```

**派生量（不入库，每次算）**：

| 集合 | 判据 | 用途 |
|---|---|---|
| `ready` | `open` 且所有前置 `done` | 「现在能干什么」的唯一答案 |
| `blocked` | `open` 且存在未 `done` 的前置 | 解释「为什么还不能干」 |
| `doing` | `doing` | 正在做的（允许多个，不强制单指针） |
| `done` | `done` | 历史 |
| `layers` | 拓扑分层（同层无依赖关系） | 视图按层排，天然是 DAG 的骨架 |

三条不变量：

1. **无环**：建边前 DFS 挡环（照 `db.ts::blocksReaches` 的写法，只是换成 unit 边）。
   因此 `layers` 永远算得出来。
2. **`done` 只需自身状态，不看后继**：允许「先做完、后继后来才长出来」。
3. **删前置 = 解除阻塞**：`u1 → u3`，删掉 `u1` 时这条边一起删，`u3` 可能立刻变 ready。
   这是「真删掉」的自然语义，不是 bug。

## 3. 「真删」和「留痕」怎么并存（两个决定唯一的张力点）

选 4（真删）与选 3（留痕）放在一起看是矛盾的，解法是**分两份数据**：

- **当前图**（`task_units` + `unit_deps`）：删就真删，视图与 `ready` 集合里不留尸体。
- **事件流**（`events` 表，`event = 'task.unit.*'`，`subject = taskId` —— 与 `task.journal` 同一套
  `<type>.<verb>` 命名）：每次变更追加一条，
  包括 `unit.dropped` 带 **title 与 reason**。于是「这步为什么被取消」永远答得出，
  而图本身是干净的。

```ts
task.unit.added    { id, title, deps }
task.unit.updated  { id, fields }        // title / body / status 改了哪个
task.unit.linked   { from, to }
task.unit.unlinked { from, to }
task.unit.dropped  { id, title, reason } // 删了也能查到它曾经是什么、为什么没的
```

**为什么不用 journal**：`journal` 有五种语义 kind（decision / pitfall / review / progress / learn），
且最近 24 条**会进 system 上下文**。unit 变更频率远高于决策，塞进去会把真决策（以及踩坑记录）
从上下文里挤出去 —— 这正是 journal 存在的意义被破坏。所以 unit 走 `events`（本就是领域事件流），
`journal` 只在人真的要记一笔「为什么这么拆」时才用。

## 4. 数据（`pkgs.ts/agent/entity-runtime/src/db.ts`）

```sql
CREATE TABLE IF NOT EXISTS task_units (
    task_id    TEXT NOT NULL,
    id         TEXT NOT NULL,              -- u1, u2, …（task 内递增，不回收）
    title      TEXT NOT NULL,
    body       TEXT NOT NULL DEFAULT '',
    status     TEXT NOT NULL DEFAULT 'open',
    seq        INTEGER NOT NULL,            -- 创建序，只用于稳定排序，不重排
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    PRIMARY KEY (task_id, id)
);
CREATE TABLE IF NOT EXISTS unit_deps (
    task_id TEXT NOT NULL,
    from_id TEXT NOT NULL,   -- 先做
    to_id   TEXT NOT NULL,   -- 后做
    PRIMARY KEY (task_id, from_id, to_id)
);
```

- id 分配走已有 `counters`（`scope = 'unit:<taskId>'`），与 task 的 #号同一套思路：**不回收**。
- `removeUnit` / `linkUnits` 在事务里做（删 unit 同时删它的两条边）。
- doc 注释里写死一条约束：**unit id 只在 task 内唯一**，所有 Store / 工具 / 路由入口都必须带 `taskId`。

Store 新增（形状见实现）：

```ts
listUnits(taskId): UnitRecord[]
unitOf(taskId, unitId): UnitRecord | undefined
saveUnit(input): UnitRecord                  // upsert；新 unit 由 store 分配 u<n>
removeUnit(taskId, unitId): boolean          // 连边一起删；返回是否真删了
unitDepsOf(taskId): UnitDep[]                // 一次取全图（board 用）
linkUnits(taskId, from, to): void            // 校验存在 / 不自连 / 挡环
unlinkUnits(taskId, from, to): boolean
```

领域纯函数放新文件 `pkgs.ts/agent/entity-runtime/src/units.ts`：
`unitBoard(units, deps): { ready, doing, blocked, done, layers }` —— 无 IO、可单测。

## 5. agent 工具（`pkgs.ts/agent/entity-runtime/src/tools/units.ts`）

装配点 = `buildRoomTools`（已有 `onJournal` 的位置旁边加 `units?`），宿主（RoomActor）把
`store` + `spec.id` 打成一个 host 传进去 —— **和 journal 同一条接线**。

| 工具 | 入参 | 说明 |
|---|---|---|
| `unit_list` | `{}` | 全量 board（与人看的完全相同；工具版用于精确取 id） |
| `unit_add` | `{ items: [{ key?, title, body?, deps?: string[] }] }` | 一次长一批；`deps` 写已有 id 或**同批前面**某项的 `key`（后面的项还没有 id）。返回 `[{ id, title }]` |
| `unit_update` | `{ id, title?, body?, status? }` | 改文案 / 推状态（`doing` / `done` / 回 `open`） |
| `unit_link` | `{ from, to }` | from 先做 → to 后做；成环会被拒 |
| `unit_unlink` | `{ from, to }` | |
| `unit_drop` | `{ id, reason }` | 真删 + `unit.dropped` 留痕 |
| `unit_get` | `{ id }` | 单条全文（body 可能长，列表里只给首行） |
| `unit_history` | `{ limit? }` | `task.unit.*` 事件（新→旧）：删掉的 unit 曾经是什么、为什么被取消 |

工具返回**只给确认 + 变化**（`+u4`、`ready: u3 u4`），不回整张图 —— 因为下一次模型步
system 上下文里已经有全量 DAG（§6）。省 token，且只有一处真源。

## 6. 上下文注入（`system-context.ts`）

新增 `unitsProvider(get)`，与 `journal` / `docs` 同级（都是 system 段）：

```yaml
units:
  ready: u3 写 store 层 / u4 加工具
  doing: u2 领域函数
  blocked: u5 ← u2
  done: u1 读现状
```

- **全量**（决定 7）。溢出线写进注释：**超过 ~40 个 unit 或注入超过 ~1.5 KB 时必须改成摘要**
  （只给 ready + 计数 + `unit_list` 按需查）—— 全量是阶段一的省事，不是终态。
- system 段变动 = prompt cache 失效。这和 `journal` / `docs` 面临的是同一个既有问题，
  不新增机制；但**不要**把 unit 变更同时塞进 journal，否则等于同一份变化注入两遍（§3）。

## 7. 视图（`apps/diy2/src/workbench/pages.tsx` + entity-chat）

- 在任务页 **`detail` 区**加一个 view `units`（标题「分解」）：同区已有 `detail`，
  于是自然变成 tab（`⋯` 切形态），骨架一行都不用动。
- 画法：**按 `layers` 的分层列表**（不是自由布局的图）：
  ```
  ── 层 1 ──
  ✓ u1 读现状
  ── 层 2 ──     ← 高亮 = ready
  ● u3 写 store 层      ← u1
  ○ u4 加工具           ← u1
  ── 层 3 ──
  · u5 单测            ← u2 u3
  ```
  行内给：状态符号、`uN`、title、前置（`← u1`）、doing 高亮。只读（决定 3）。
- 数据来源：RPC `units.list { id }`（与 `links.list` / `journal.list` 同一条路，走 `chat-transport-rpc`），
  服务端直接返回 `unitBoard(...)` 的视图快照；前端 5 秒轮询（与任务面板查 journal 同思路，不新开事件类型）。
- 真正的图形连线（SVG）留到有 batch 之后再说 —— 那时节点才有「worktree / PR」这些重信息，
  现在画线纯装饰。

## 8. 阶段一的分步（每步可验证）

1. `db.ts`：两表 + Store 接口 + 实现（含挡环、事务删）+ db 测试
2. `units.ts`：`unitBoard` 纯函数 + 单测（ready / blocked / layers / 删前置解锁）
3. `tools/units.ts`：七个工具 + `tools/index.ts` 装配 + 工具测试（含环被拒、drop 留痕）
4. `room.ts` + `system-context.ts`：注入 + 上下文测试
5. `apps/diy2/server`：`/units` 路由 + rpc 方法
6. `pages.tsx` + 新组件：只读分层视图
7. `./sha.sh check` + 相关包 vitest
8. 文档收尾（`find/find` 或 `app/` 知识库补一条：unit 在哪、怎么用）

## 9. 阶段二占位（本次不做，只留接口位）

- **batch**：`batch_units(batch_id, ...)` —— 一组 unit 打包到一个 worktree。
  打包判据（待定）：无相互依赖 + 不同文件面 → 可并行；一个 batch = 一条分支 + 一个 PR。
- **flow**：`pkgs.ts/flow` 描述**一个 batch** 的生命周期（开发 → 自检 → 审核 → PR → 合并），
  单 position 的线性泳道正好是它的形状；DAG 推进不进 flow。
- **自动执行**：agent 自己捡 `ready` 里的 unit 开工，batch 完成后插话汇报。

## 10. 明确不做

- 不做 tree / `parent` 字段（已拆掉，不回来）
- 不做人直接编辑（UI 只读；要改就说话）
- 不做 `cancelled` 状态（删就是删，痕迹在 `events`）
- 不接 flow（阶段二）
- 不把 unit 变成 task（不占 #号、不进侧栏）

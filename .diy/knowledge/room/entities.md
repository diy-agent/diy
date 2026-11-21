---
desc: diy2 的存储分层：entities 身份 / tasks·projects 真源 / 插件数据归插件；编号与 id 规则
updated: 2026-11-21
---

## 结构

`openStore` 里三层，别混：

- **`entities`**（id / type / created_at）：身份。一切可被引用的东西一行，**不存业务字段**。
- **`tasks` / `projects`**：真源。标题、编号、正文、状态、`workspace` 都是真列。
- **记录表**（`entity_items` / `room_entries` / `session_state` / `journal_entries` …）：属于实体、无独立身份、不参与引用。

插件实体只有 `entities` 一行，payload 在 `~/.diy/plugins/<plugin_id>/` —— 宿主不碰。

## id 与编号

- 新实体 `newEntityId()`（UUIDv7）；**旧 id 不重写**（`proj:diy`、`task-mwj3x9` 原样留着）。
- `counters.next` 独立于任务行 ⇒ 删任务不回收号；改项目 / 改目录也不换号。
- 类型：core 闭合 `project|task|bot`；插件 `<npm 包名>/<局部名>`（`@acme/github/issue`、`x/issue`）。
  判据见 `src/id.ts` 的 `splitPluginType`（含 `@` 或 `/` ⇒ 插件）。

## Room 兼容层

服务端与 entity-chat 仍吃 `Room`，store 做单向映射（`title↔name`、`summary↔data.desc`、
`workspace↔data.dir`、`project_id↔data.projectId`、`status/closed_at↔data.status/closedAt`）。
`data` 里其它键**不读也不写**。`saveRoom` 只接受 project / task。UI 迁移完成后删掉这层。

## 迁移

老库 `rooms` 逐行搬进域表（幂等、编号沿用），全部成功后才改名成 `rooms_v0` 留档。
状态归一：`todo/doing → open`、`done → closed`。

设计全文 `docs/plans/2026-11-21-identity.md`。

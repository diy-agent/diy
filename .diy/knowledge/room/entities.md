---
desc: diy2 的存储分层：entities 身份 / tasks·projects 真源 / 插件数据归插件；编号与 id 规则
updated: 2026-11-21
---

## 结构

`openStore` 里三层，别混：

- **`entities`**（id / type / created_at）：身份。一切可被引用的东西一行，**不存业务字段**。
- **`tasks` / `projects`**：真源。标题、编号、正文、状态、`workspace` 都是真列。
- **`entity_links` / `events`**：关系与事件流（见下）。两者都靠 `entities` 外键级联删除。
- **记录表**（`entity_items` / `room_entries` / `session_state` / `asks` …）：属于实体、无独立身份、不参与引用。

插件实体只有 `entities` 一行，payload 在 `~/.diy/plugins/<plugin_id>/` —— 宿主不碰。
**插件注册表不是 DB 表**：启动时加载 manifest（`package.json` 的 `diy` 段）得到内存模型
（`@diy-agent/workbench-plugin` 的 `createPluginRegistry`），装了什么来自加载结果；
将来记安装来源用 `<数据根>/plugins.json`，仍不是表。清单身份 = 包名，实体类型全名 `<包名>/<局部名>`。

## 关系（替代父子）

`entity_links(from_id, to_id, kind)`，`linksOf(id)` 同时给 `out` 与 `in`（不写反向）。

- core kind：`related` / `blocks` / `duplicate`；插件自定义必须 `<plugin_id>/<kind>`。
- `blocks` 建边前查环（A→B→…→A 会让两边永远等对方）；`related` 不查。
- 自连、任一端实体不存在 → 拒绝。

## 提问（ask）

`asks(ask_id, entity_id, at, request, state, answer, reason, settled_at)`。

- **待答状态必须落库**：ask 不阻塞，run 早已结束；只在内存里的话进程一重启卡片就消失，
  而模型那边以为问过了。房间装配时 `AskGate.restore()` 从这张表恢复 pending + 最近 50 条已收尾。
- 恢复的 pending **不重装超时定时器**（老提问不会因为重启被悄悄作废）。
- 删房间连带清（`deleteRoom`）。

## 事件流

`events(seq, at, event, subject, actor, data)`，`event = <type>.<verb>`（插件事件自带命名空间）。
任务日志（journal）是它的投影：`event = task.journal`，`data = {kind, text}`；
`appendJournal` 写入、`journalOf` 读回。老 `journal_entries` 迁移后改名 `journal_entries_v0`。

## id 与编号

- 新实体 `newEntityId()`（UUIDv7）；**旧 id 不重写**（`proj:diy`、`task-mwj3x9` 原样留着）。
- `counters.next` 独立于任务行 ⇒ 删任务不回收号；改项目 / 改目录也不换号。
- 类型：core 闭合 `project|task|bot`；插件 `<npm 包名>/<局部名>`（`@acme/github/issue`、`x/issue`）。
  判据见 `src/id.ts` 的 `splitPluginType`（含 `@` 或 `/` ⇒ 插件）。

## 任务目录

`<数据根>/tasks/2026-11-21/<id>/` —— 日期取**创建日**（本地时区），之后永不移动：

- `task.md`：frontmatter + 正文。**DB 才是真源**，手改会在下次保存时被覆盖。
- `journal.jsonl`：append-only，一行 `{seq,at,kind,text}`。
- `artifacts/`：截图 / 日志等产物。
- 删任务 → 整个目录挪进 `tasks/_trash/<日期>-<id>`，**不删产物**。
- 路径由 `(createdAt, id)` 推出（不存列）；id 里的 `:` 换成 `-`（Windows 非法）。
- `tasks.updated_at` 只在内容真变时盖章（启动全量重存不算）。

## Room 兼容层

服务端与 entity-chat 仍吃 `Room`，store 做单向映射（`title↔data.title`、`name↔data.name`、
`summary↔data.desc`、`workspace↔data.dir`、`project_id↔data.projectId`、`status/closed_at↔data.status/closedAt`）。
`Room` 本身**没有 `name`**（2026-11-22 裁）：房间是虚拟概念，显示名来自容器 ——
任务是 `data.title`、项目是 `data.name`，其它容器退主成员 bot 名。
另有两个**只读投影**：`data.number`（任务号）与 `data.taskDir`（产物目录）—— 回写时忽略。
`data` 里其它键**不读也不写**。`saveRoom` 只接受 project / task。UI 迁移完成后删掉这层。

## 迁移

老库 `rooms` 逐行搬进域表（幂等、编号沿用），全部成功后才改名成 `rooms_v0` 留档。
状态归一：`todo/doing → open`、`done → closed`。

设计全文 `docs/plans/2026-11-21-identity.md`。

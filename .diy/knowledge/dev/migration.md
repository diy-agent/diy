---
desc: 数据迁移（@diy-agent/migration）：版本表语义 / 加表规矩 / 旧库验证
updated: 2026-11-28
---

## system

迁移真源 = `@diy-agent/migration`（`pkgs.ts/core/migration`）：`schema_migrations` 版本表是「库版本」唯一真源。`applyMigrations`（src/run.ts）对**已记账**迁移 `continue` 跳过 `up()`；`probeMigration`（apps/diy2/server/migrate-mode.ts）也只按版本表判 pending（不靠 `done()` 体检）。⇒ **版本表说「N/N 迁完」≠ 库里表真齐。**

（见 pkgs.ts/core/migration/src/run.ts:1）

## create-schema-once

当前 schema 的整套 `CREATE TABLE IF NOT EXISTS` 只在 `createSchema()`（entity-runtime/src/db.ts），而它**只作为 `003-create-tables.up()` 跑一次**。`create-tables` 一旦记账，之后往 `createSchema` 加表/列**不会重跑** —— 老库永远缺新表。

（见 pkgs.ts/agent/entity-runtime/src/db.ts:721）

## add-resource

给 store 加表 / 列 = **新建独立迁移** `NNN-*.ts`（`pkgs.ts/core/migration/src/` + 注册进 `index-list.ts`）：

- 幂等：`CREATE TABLE IF NOT EXISTS ...` / `ADD COLUMN` 前查列；
- `done(rt)` 必须覆盖新资源（如 `rt.hasTable('x')`），否则老库基线认定「已完成」而不建；
- 改/加任何迁移文件后**重跑** `node scripts/gen-migration-checksums.mjs`（`check-migration-checksums` 护栏会拦不一致）；
- **禁止**只改 `createSchema`；**禁止**改已 applied 的旧迁移（不重放，只产生 checksum drift 告警）。

## checksum-scope

`checksums.generated.ts` 是**迁移文件**的指纹，不是库内容。`check-migration-checksums` 只拦「改了迁移文件没重生成」；对「往 `db.ts` 的 `createSchema` 加表」**完全无感** —— 别指望它兜底这类 bug。

## verify-old-db

`:memory:` / 新建库测试必然全绿（`003` 会完整跑 `createSchema`），会骗你。验证旧库行为：复制真实库到临时目录（**不是**直接对生产库 `openStore`）跑 `openStore(copy)`，或对真库 `readOnly` 探 `sqlite_master`；判据 = 迁移后新表在 + 读写不报 `no such table`。

## incident-turn-facts

2026-11-28：老库 `~/.diy2/diy2.db`（`schema_migrations` 19 条含 `create-tables`、无 `turn_facts`）启动即 `no such table: turn_facts`。根因 = `6c1944b8 feat(chat): 落盘每轮的结算事实` 把 `CREATE TABLE turn_facts` 加进 `createSchema` 却未配独立迁移。修 = 新增 `020-turn-facts` 迁移（幂等建表 + `done=hasTable`），真实库副本验证 `[migrate] 本次跑了 1 条：turn-facts`。PR #632。

# 业界 app / 数据迁移：规范、库与可复用 skill 调研（2026-11-27）

> 调研问题：我们这种「桌面 app 内置 SQLite、启动时同步迁移、带一个迁移页」的场景，
> 业界有什么规范 / 库 / 最佳实践 / 现成 skill 可以直接借。
> 出处均为本轮实拉的页面或仓库（带链接），星数为 2026-11-27 快照。

## 一、规范与原则（带出处）

### 1. Parallel Change / expand-contract（三段式）
出处：martinfowler.com/bliki/ParallelChange.html（Danilo Sato, 2014）。
把一个不兼容变更拆成 **expand → migrate → contract** 三阶段：先加新的（旧的照常工作）→ 迁数据/切读写 → 再删旧的。
这是「零停机改 schema」的总纲；服务端多实例部署下是硬要求。

**对我们（单机 SQLite + 迁移前备份）**：不必三段都做 —— 一次事务里改完 + 备份回滚即可；
但**顺序语义**要遵守：先加列/表 → 数据回填 → 再删旧列（我们 016 `drop-legacy-room-model` 这类删除型迁移放最后是对的）。

### 2. 迁移五条核心原则
出处：affaan-m/ecc `database-migrations` skill（skills.sh 14,256 installs，正文已拉取核对）：

1. **一切变更都是迁移** —— 生产库不手敲 SQL；
2. **生产迁移 forward-only** —— 回滚靠再写一条向前迁移，不写 down；
3. **schema 变更与数据回填分开** —— 不在一条迁移里混 DDL+DML；
4. **按生产规模的数据测试** —— 100 行能过 ≠ 1000 万行不锁死（我们 fold-bots 2.5 分钟坑正是这条的反例）；
5. **已部署的迁移不可变** —— 跑过的文件不许再改，改就新起一条。

配套「迁移前安全清单」：有 up/down 或标明不可逆、锁时长评估、新列可空或带默认、索引并发建、
**用生产数据副本测过**、回滚方案成文。

反模式表（同 skill）：手工 SQL 无审计、**改已部署的迁移**、给有数据的表加 NOT NULL 无默认、
大表内联索引、schema+data 混一条、**先删列后删代码**（应反过来）。

### 3. 迁移要能在「真实旧数据」上演练
- **Android Room**（developer.android.com/training/data-storage/room/migrating-db-versions，实拉 200）：
  导出每版 schema 到 `schemas/`，`MigrationTestHelper` 在 instrumentation 测试里**从旧 schema 文件起库跑迁移再断言**。
- **Prisma Migrate**：`migrate dev` 用 shadow database（影子库）**从头重放全部迁移**生成/校验，部署用 `migrate deploy` 只记账不重算。
- **Flyway**（flywaydb.org，实拉）：版本化迁移 + `schema_history` 表带 **checksum**（防迁移文件事后被改）+ baseline（给已有库补记账，不重放）。

**对应我们**：真库副本演练（journal seq 414/515）方向完全正确，缺的是把它固化成测试 ——
业界形态 = 「拿一份冻结的旧库 fixture → 跑迁移 → 断言行数/引用完整性」，我们已有雏形
（`migration.test.ts` 7 用例 + 384c7193 的回归测试），**fixture 库还没进仓库**。

### 4. 版本记账的三种粒度
| 形态 | 谁在用 | 特点 |
|---|---|---|
| 整数 `PRAGMA user_version` | SQLite 官方 pragma（pragma.html 实拉） | 最便宜，只能存一个数，无标题/无明细 |
| 版本表（id + 时间 + checksum） | Flyway `schema_history`、我们 `schema_migrations` | 可看「每条干了什么」，支持 baseline 标记 |
| ORM 生成器 | drizzle-kit / Prisma / Alembic | 文件名时间戳承载顺序，量大时省手写 |

**opencode 自己**（本机 opencode.db 实查）：`__drizzle_migrations`（drizzle-kit：hash + created_at）
**加**一张 `migration(id, time_completed)` —— 双表：一张管 schema 演进，一张管「跑过哪些动作」。
我们的 `schema_migrations(id, title, applied_at, baseline)` + `converge` 类别与之同构，**不落后**；
缺的是 Flyway 式 **checksum**（迁移文件被改了发现不了）。

### 5. 零停机 / 在线变更（服务端专用，列出以明确「我们不需要」）
- expand-contract 双写、**并发索引**（Postgres `CREATE INDEX CONCURRENTLY`）、**分批回填**（batched backfill）、
  读写分离窗口 —— 均见 affaan-m/ecc skill 的 PostgreSQL Patterns / Zero-Downtime 章节。
- gh-ost / pt-osc（MySQL 大表改表）。
**适用边界**：多实例服务端 / 大表在线改。桌面 app 单写者 + SQLite 事务 + 迁移前备份，
对应做法是「整段在一个事务里、失败整体回滚」——我们已满足（执行与记账同事务）。

### 6. app 数据迁移（桌面/移动）的通行套路
综合 Room / Core Data / Firefox 等实践，可归纳为：
1. 启动时**只读**探测版本（我们 `probeMigration` ✅）；
2. 迁移前**备份文件**（我们 `bak-before-migrate-1517` ✅，但非自动）；
3. 迁移在**独立进程/线程**跑、可报进度（我们子进程 + SSE ✅）；
4. 迁移与 UI 之间有**闸门**（未迁完不装配真 app —— 我们启动闸门 ✅）；
5. 失败要有**可见错误 + 落盘日志**（我们 ❌ —— 这次 opencode 修复的正是这条链的前半）；
6. 迁移后**自动校验**（行数/孤儿/外键）（我们目前手工查 ❌）。

## 二、可用的库 / 工具（带适用场景）

### Node / TS（我们的主栈）
| 库 | 星数 | 场景 | 对我们的判断 |
|---|---|---|---|
| **umzug**（sequelize/umzug） | 2.2k | 框架无关迁移 runner：文件名排序、事件钩子、storage 抽象、TS 友好 | **最值得借鉴/替换手写执行器的候选**：它就是「schema_migrations + 执行器」的通用实现，支持 `log`/`beforeEach` 等钩子（我们的 progress/reporter 可映射）；但它的 storage 不带 baseline/converge 语义，需包一层 |
| knex | 20k | query builder + 迁移（`knex.migrate`） | 重：引入整个 builder；迁移文件 `up/down` 形状与我们同 |
| drizzle-orm + drizzle-kit | 36k | TS ORM，`drizzle-kit generate/migrate` | opencode 用的就是它；我们不是 drizzle 栈，不适用，但**双表记账**（schema +动作）可抄 |
| Prisma Migrate | — | shadow DB 重放 + `migrate deploy` | 需 Prisma 栈，不适用；**影子库重放**思想可抄成「fixture 库测试」 |
| better-sqlite3 / node:sqlite | — | 我们已用 node:sqlite 同步 API | 同步 = 必须子进程（已做），无变更 |

### 跨语言 / CLI
| 工具 | 星数 | 特点 |
|---|---|---|
| golang-migrate/migrate | 19k | 纯 SQL/Go 文件、CLI+库、**forward-only 默认**、多数据库（含 sqlite） |
| pressly/goose | 11.7k | SQL+Go 函数、嵌入式可用（`goose.Up`），最接近「app 启动时跑迁移」的 Go 形态 |
| amacneil/dbmate | 7.5k | 轻量、框架无关、up/down + `--dry-run` |
| Flyway（Redgate） | 商业+社区 | 版本表+checksum+baseline，企业事实标准；JVM/CLI |
| Atlas（ariga） | 商业 | schema-as-code、迁移 lint（`atlas migrate lint` 查危险变更）—— **lint 思路**值得借：CI 里对迁移文件做静态检查 |
| Liquibase | 商业+社区 | changeset + rollback + **changeset 校验和**（同 Flyway） |

**结论**：桌面 app + node:sqlite 场景下**没有一个「拿来即用」的标准库覆盖我们的全部语义**
（baseline / converge / store 语义回调 / 迁移页计划渲染）—— 自研 `@diy-agent/migration` 是合理的；
但两处可直接吸收：
1. **umzug 的执行器成熟度**（事件化、可测试、storage 可换）—— 若执行器继续长大，优先评估包一层 umzug 而不是继续手写；
2. **Flyway 的 checksum**（对 16 个迁移文件各存 hash，文件被改 → 启动即报）与 **Atlas 的 migrate lint**（CI 静态查「给有数据的表加 NOT NULL」这类反模式）。

## 三、现成 skill（社区已沉淀，可直接装或改写）

skills.sh 实拉（按 installs 排序，关键词 database/schema/data migration / expand contract）：

| skill | installs | 内容 | 与我们的匹配度 |
|---|---|---|---|
| `addyosmani/agent-skills/deprecation-and-migration` | 76,049 | 退役与迁移总纲：strangler / adapter / feature flag / **expand-contract**、Hyrum's Law、验证与红灯清单 | ★★★ 偏系统退役，expand-contract 章节可直接抄 |
| `affaan-m/ecc/database-migrations` | 14,256 | **最对口**：安全清单、反模式表、expand-contract 时间线、按工具（Prisma/Drizzle/Kysely/Django/golang-migrate）分 workflow | ★★★★ 正文已拉全，我们的「五原则」即出自此 |
| `wshobson/agents/database-migration` | 18,519 | skills.sh 收录；仓库为 plugin 结构，本轮未定位到单文件路径（tree 拉取截断） | 待核 |
| `osmontero/opencode-skills/evolving-apis-and-schemas` | 119 | 「schema 变更是分布式系统问题」：向后兼容判定、breaking 检查、迁移+代码同序部署 | ★★★ 视角（读数据的不只新代码）对我们的「引用重写漏点」（seq 515）正中要害 |
| `kbravh/skills/prisma-expand-contract` 等 | 1–25 | expand-contract 专项 | ★ 收敛过窄 |
| `philtzjp/skills/data-migration` / `aj-geddes/.../data-migration-scripts` | 542 / 432 | 数据迁移脚本 | ★★ 偏 ETL |

**本地 skills 现状**：`~/git/cops/skills`、`~/git/diy/dev/skills` 下**无任何迁移主题 skill**（fd/rg 已查）；
本仓 skills 列表（上下文 skills 节）也没有 —— 这块是空白。

## 四、给我们的建议清单（按性价比排序）

1. **把迁移错误落盘**（复盘缺口 #2）：SSE 只是展示通道，worker 的 stderr/JSON 行同时写
   `~/.diy2/log/migrate-<时间>.log` —— 这次「卡住也没日志」的直接解，也符合「核心逻辑不依赖日志」的反面
   （这里是 UI 观测，不是核心真源）。
2. **发布产物 e2e 进 check**（复盘缺口 #1）：opencode 这次手跑的「构建产物 + Chrome 点开始迁移」
   应固化成 `./sha.sh` 下的一个测试目标（spawn ENOENT / SSE 竞态都属此类，源码态测不出）。
3. **迁移后自动校验**（复盘缺口 #3）：执行器跑完所有 up 后固定跑一组断言（`schema_migrations` 计数、
   会话孤儿 = 0、行数对比 plan.rows），失败标红在迁移页 —— 即 Room `MigrationTestHelper` 的运行时版。
4. **加 checksum**（对齐 Flyway）：`schema_migrations` 加 `hash` 列，启动时比对迁移文件当前 hash，
   不一致即拒绝启动并提示「迁移文件被改过」—— 成本一条列 + 一次 hash。
5. **迁移前备份自动化**：现在靠人工 `cp`；做成 `start` 前自动 `cp diy2.db diy2.db.bak-<时间戳>`（保留 N 份）。
6. **沉淀一个 skill**（填补本地空白）：`db-migration` —— 装以上五原则 + 本仓特有约束
   （同步迁移必须子进程、引用重写要扫 session/deliveries/items.author/asks.owner 全部引用点、
   映射改大表先落 TEMP 表、产物态与源码态双入口）。内容骨架直接改写 `affaan-m/ecc/database-migrations`。
7. **不引入**：CDC / 蓝绿 / 金丝雀 / gh-ost 类 —— 多实例服务端专用，与单机 SQLite 场景不符；
   umzug/knex/Prisma 迁移栈 —— 现有自研包语义（baseline/converge/计划渲染）更贴，先不动。

## 五、结论一句话

业界规范里**我们真正欠的不是「迁移引擎」而是「迁移的可观测与验收」**（落盘日志、产物态 e2e、自动校验、
checksum、自动备份）—— 引擎部分（版本表、基线、事务、子进程、迁移页）已与 Flyway/opencode 同构；
skill 有现成可抄（affaan-m/ecc 为首），本地为空白，值得沉淀一个本仓版。

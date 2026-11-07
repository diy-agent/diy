---
desc: 事实库硬约束：env 轴 / claim 与 id / 相交匹配 / 单一实现 / 生成物式真源 / 任务级库边界
updated: 2026-10-26
---

## claim

边指向 **claim**（`subject#aspect`），`supersedes` 指向 **fact id**；claim 可派生、fact id 不可派生（审计锚点 —— `supersedes.to` 指着它，改了就是断边）

（见 cf38b8ab:pkgs.ts/diy-facts/AGENTS.md:21）

## env-axis

`scope.env` 对齐 **`DIY_ENV`**（production / development / test），**不是** `DIY_VARIANT`（prod / test / lab）：`lab` 只是 development 的一种实例形态，混用两套轴会在 lab 与 development 之间打架

（见 cf38b8ab:pkgs.ts/diy-facts/AGENTS.md:20）

## evidence-drift-undecidable

「源改了我没跟」**机械不可判**：实测把判据写成「钉版本的那行文本还在不在现在的源里」→ 470 条里 **269 条 warning**（全是 AGENTS.md 内容外迁进 kb 后行文消失，属预期），换成「rev..HEAD 改过几次」→ **272 条**（合并频繁的仓里恒真）。噪声等于没有 ⇒ 该判据**不得**进 `facts-index`。要真判只有两条路：① 写入时把锚行文本存成 digest，比对 digest（schema 加字段）；② 人工/agent 例行「复核」仪式（W1 `facts/stale` 已提供时间触发器）。取舍未定，勿擅自实现

## evidence-pin-placement

`evidence.at` 的钉版本形态用错了边：全库 353 条带 at 的事实里 **269 条钉在已瘦身的 AGENTS.md 上**（那行已从源消失，锚只剩「历史上它写在这」的归档意义）、**41 条**那行仍在源里、**84 条是未钉版本直指当前文件**。**真正的危险区是未钉的那 84 条** —— 其中 **45 条指 `~/AGENTS.md:<行>`**，而 `~/AGENTS.md` 正是下一步要瘦身的对象：瘦完这 45 条会**静默指错行**（行号仍在范围内，G4 查不出来）。判据：钉版本只对「已搬家」的归档事实合适；**对活着的规则（每轮要照做的），必须保证 at 随源同步更新**，否则宁可删 at 也要在写侧重算

## exit-code

按名取实体查不到 ⇒ **退出码非零**（同 `grep` 无匹配 / `cat` 缺文件）；搜索或列举空结果 ⇒ **0**（`find` 无命中是正常结果）。落点：`diy facts get` 的 `resolved` **全空** ⇒ 1（多 claim 部分命中照常 0）；返回体不变（`resolved: []` + `notes` 照给，人要先看见原因再拿退出码）。实现在 CLI 输出层 `CliConfig.exitCodeOf`（直连与 `/cli` 端点同一判据，`diy.sh` 的 http 模式经 `x-diy-exit` 透传）。

## expose

`expose` **必须显式写**，不能吃缺省：任务级库的缺省档是 `full`（`DEFAULT_EXPOSE_BY_KIND.task`，只有 project / global 才是 `index`）—— 不写就把任务库整份值塞进**每轮**信封；外面还叠一层兼容窗口：三库**谁都没写** `expose.yaml` 时一律回落 full（旧行为：全进正文 + 按预算裁）。实证（##408）：任务级库没声明 expose ⇒ 本任务结论按 full 常驻，`full` 字节和超过 4 KB 预算 ⇒ 触发 `facts/expose-budget`（正文 `omitted: 12`），把项目库唯一声明的 full 主题 `where` 整块挤出正文 ⇒ 模型那一轮看不到信息地图（`where#*` 就是「什么信息去哪查」的入口）。判据：**任务级库一律 `expose: index`**（信封里只留 `runtime.kb` 一行索引），要值时 `diy facts brief <主题> --in task:<uri>` / `diy facts get <claim> --in task:<uri>`；项目库按主题逐个定档，`full` 只给「每轮都要知道」的，新增主题吃不准就 `index`。⚠️ 被 index 或被裁掉的主题**不计入 `omitted`**（`omitted: 0` ≠ 装得下），所以别拿 `omitted` 当预算够的证据。改档位走 `diy facts submit` 的 `expose` 载荷，别手改 `expose.yaml`。与 `facts.rule#expose-cross-lib` 末尾「task=full」的提案相反，**以本条为准**。

（见 f6f1a264:pkgs.ts/diy-facts/src/expose.ts:35）

## expose-cross-lib

expose 表的适用域必须**按库**判，不能按合并后的一张表：实测仓库 `knowledge/expose.yaml` 只声明了**一个** subject（当时是 `rule.agent: full`，现为 `where: full`），任务库（diy.facts 4 条 658 B，未声明 expose）的正文随即从 `runtime.facts` 消失（omitted 0，正文只剩 6 条）。**任务库缺 expose 应回落旧行为（全进正文），或按 ns 给缺省档：task=full / project·global=index** —— 任务自己的结论最该常驻，被上层库的配置静默吞掉是最坏的一种「省」。

## generated

真源是**生成物式**：条目排序 / 字段顺序 / 头注（`note` 或文件开头注释块）全由 `renderDoc` 决定 ⇒ 手工改格式会被下一次 submit 冲掉；改内容只能走 `diy facts submit`

（见 cf38b8ab:pkgs.ts/diy-facts/AGENTS.md:25）

## intersect

匹配是**相交**不是包含：`env: ['development','test']` 在 `{env:'test'}` 下命中（数组语义是析取，不是合取）

（见 cf38b8ab:pkgs.ts/diy-facts/AGENTS.md:22）

## lazy-create

**库没有「新建」动作**：不存在 = 空库（读），第一次写入时由写盘原语（`atomic-write.ts` 的 `mkdirSync(dirname, {recursive:true})`）自己建目录（写）。读入口一律不建库、也不因为没库报错。

判据只有两条：
- **读不产生任何持久副作用** —— 磁盘快照前后一致（`loadRepo` 读路径不再 `mkdir`：原 `allowMissing` 分支已从选项类型里删除）
- **写不需要任何前置动作** —— 空库 `submit` 直接落盘，无例外

判据按**路径来源**分护栏：
- `--in task:<uri>` / `global` ⇒ 路径是推导的，不可能打错 ⇒ 懒建，无条件
- `--dir <path>` ⇒ 手敲的 ⇒ 照样懒建，但报告带 `created: { dir }`（不阻止，也不静默）

反例（已修，`b6353abe`）：`loadRepo` 在 `allowMissing` 时 `mkdirSync` ⇒ `submit --dry-run` 会建库，把「库建没建」这个状态改了，而 `--dry-run` 自称「磁盘一个字都不动」。同族另两处已删：`status` / `projectFacts` 门口那句「库还没建…先跑 submit」。

`agent/facts-repo-missing` **没有整体退役**，只收窄到两条环境错误（判的是「你指错地方了」，不是「库还没建」）：向上找不到 `knowledge/subjects.yaml`（处置：`--dir` 指仓根或 `DIY_FACTS_DIR`）、任务库缺继承词表（同处置）。这两条都答得出「读它的人能做什么」，故留。

## live

冲突 / 冗余只在 `review=accepted && lifecycle=active` 之间判；`superseded` 留档不算问题

（见 cf38b8ab:pkgs.ts/diy-facts/AGENTS.md:23）

## no-throw

读取侧一律返回 `Result`（`facts/scope-no-match` / `facts/scope-conflict` 是可预期结果）；只有构造非法输入才 throw 带 code 的错误

（见 cf38b8ab:pkgs.ts/diy-facts/AGENTS.md:29）

## single-impl

**判据只写一份**：CLI 与 check 脚本都调 `@diy-agent/facts/node`，任一侧自己再实现一遍校验 = 分叉，正是本任务要治的病

（见 cf38b8ab:pkgs.ts/diy-facts/AGENTS.md:24）

## subject-split

subject 级 expose 的前提是**单主题体量 ≤ 预算/4**：实测 `rule` 30 条 9279 B > 4 KB 预算 2.3 倍，`full` 对它是不可选项。切分判据 = **读它的场景一致**（谁要读它），不是字段分类；不要一次拆成 4 个（rule.dev/doc/task 会把 `rule` 拆空并触发 subject-unused）。**切之前先查 chain**：拆出来的主题若内容已在 `AGENTS.md` 链里，标 full 就是双写漂移 —— `rule.agent` 那 6 条实测 4 条与 `~/AGENTS.md` 逐字重复（已于 ##9 删除）、3 条迁进更该负责的主题，主题整体 drop。

## tasklib-inherit

任务级库**继承**仓库词表，且**写回只写本地的**：`loadRepo` 把「全量词表」与「本地声明的词表」分成两份（`subjects` / `localSubjects`），写回用后者 —— 混用会让第一次 `submit` 就把继承的整份词表复制成本地快照。⚠️ **继承只持续到本地文件诞生**：任务库首次写入就建出本地 `subjects.yaml`，继承当场断掉、此后**不再合并**仓库词表 ⇒ 任务库词表不是「仓库 ∪ 本地」的持续快照，别按那个前提设计

（见 cf38b8ab:pkgs.ts/diy-facts/AGENTS.md:28）

## tasklib-root

任务级库的 `root`（证据 / `scope.paths` 的解析根）**是仓库根**，不是任务目录：任务写的事实讲的是代码仓的事（`apps/diy-app/src/x.ts:10`），按任务目录解析会让每条证据都悬空

（见 cf38b8ab:pkgs.ts/diy-facts/AGENTS.md:27）

## workspace-dep

@diy-agent/app 新增 workspace 依赖**必须**同步 `apps/diy-app/vite.pkg-deps.ts::WORKSPACE_TS_DEPS`，否则 main 产物留裸 `import "@diy-agent/x"`、运行时加载 `.ts` 源码直接炸（本任务实测踩中一次）

（见 cf38b8ab:pkgs.ts/diy-facts/AGENTS.md:26）

---
desc: @diy-agent/app 包内硬约束（测试纪律 / 原子写 / 提示词 / 联动契约）
updated: 2026-10-26
---

## agents-chain

AGENTS.md 链**上界到 `$HOME` 为止**（不进 `/`、`/Users`）；不在 `$HOME` 下时只取工作目录一层

（见 ba99d638:pkgs.ts/diy-app/AGENTS.md:74）

## agents-injected

**本文件会被 `chainOf` 注入 system 提示词**（受 64KB 预算 `SYSTEM_BUDGET_CAP_BYTES` 约束）：长文写 README / 独立文档，这里只留指针

（见 ba99d638:pkgs.ts/diy-app/AGENTS.md:79）

## budget

系统提示词预算 `clamp(模型上下文 × 4B × 5%, 16KB, 64KB)`；超限**拒发不截断**，且早退也必须闭合轮次（stop + noteTurnEnd + 审计）

（见 ba99d638:pkgs.ts/diy-app/AGENTS.md:75）

## file-write

**整文件覆盖写一律走** `src/main/core/atomic-write.ts::writeFileAtomic`（同目录 tmp → `rename`；失败 ⇒ 原文件**逐字不变** + tmp 清理 + 错误**原样上抛**）。禁直接 `writeFileSync(目标, …)` 覆盖已有内容的文件，也禁再添第二份私有 tmp+rename 副本 —— 前者在低磁盘下**先把目标清空**（2026-10-18 实测把 253KB 任务正文写成 0 字节，##382），后者必然分叉成「有的写点原子、有的不原子」。剩余写点收敛见 ##383

（见 ba99d638:pkgs.ts/diy-app/AGENTS.md:85）

## form-toggle

**表单里的三态控件**：二态开/关用 daisyUI **toggle**、多选一用 **radio**（两者形态必须一眼可分，别都塞 checkbox）；**按钮位**（工具条 / view bar / 图标切换）用 **swap**（隐藏 checkbox + 图标双态，省地方）—— 三者各司其职，别互串

（见 ba99d638:pkgs.ts/diy-app/AGENTS.md:86）

## golden

改内置模版（`src/main/prompts/defaults.ts`）**必须同步** `tests/fixtures/system.golden.txt`（当前内置模版的逐字节快照）。⚠️ `./sha.sh check` **不含 vitest**，不会替你抓到这类失效 —— 改完模版跑 `npx vitest run tests/core/template-dsl-golden.test.ts`

（见 ba99d638:pkgs.ts/diy-app/AGENTS.md:76）

## job-spawn-listen

**`spawn()` 之后不许夹 `await` 再挂监听**：`spawn`/`error` 是下一个 tick 的一次性事件，`spawn()` → `await open/close` → `awaitOpened(child)` 的写法会让事件先发、监听后挂 ⇒ 永远等不到、`spawn()` 挂死（实测：一个只有 `sleep 5` 的用例卡满 60s）。正解：spawn 返回后**同步**挂监听（`awaitOpened(child)` 就地产出 Promise），其余 await 排队在后面。

（见 7c8b0e950398:pkgs.ts/diy-app/AGENTS.md:122）

## job-vocab

**job / run 词汇表（##408 刀 26 定案）**：`job` = 后台活儿的**总称**（域名：`diy job` / `job.*` / `log/job/`），**不是实体**；`run` = 唯一实体（`RunInfo` / `runId`，一次具体执行）；`origin` = 溯源（谁起的，判别联合），**不是分类轴**；`trigger` = origin 的一个 type，v2 做调度也只多一条带 `origin.type==="trigger"` 的 run，**不引入新实体**。**禁词**：`Supervisor` / `Worker` / `Child` / `Tree`（不引入 supervision —— OTP 的前提是 VM 不死，我们主进程一死全死）/ `service`（常驻容器成员 <2 不立词）/ `kind` 用作 run 分类（v1 `JobKind` 残留）。规矩：**定义层不叫 job** —— v2 若有定时定义，另起域名（如 `diy sched`），`diy job` 继续只指后台 run；`job` 下**不许挂实体集合接口**（`job.ls` / `job.get <id>` 这类），否则 v2 一到就撞。

（见 ed3aab82:pkgs.ts/diy-app/src/main/services/run-registry.ts:1）

## log-vs-config

**落盘日志**（会话目录 `local/<uri 路径>/<key>/*.jsonl`；旧平铺 `<key>.*.jsonl` 读侧兜底）读侧宽松（初版紧凑/扩展松散/缺必填即**异常数据**，见 `log-schema.ts`）；**配置真源**（`context.yaml` / `auto-compact.yaml`）读侧出声回落默认、写侧归一 + 原子写，且**不进 localStorage**（有损 + 两进程各持一份）

（见 ba99d638:pkgs.ts/diy-app/AGENTS.md:84）

## no-silent-catch

不要静默吞异常（如切模型曾一律 `catch {}` → 用户以为切了其实没切）

（见 ba99d638:pkgs.ts/diy-app/AGENTS.md:83）

## noemit

**类型检查绝不 emit**（各包 `noEmit: true`，唯一入口 `./sha.sh check`）。一旦产物落在源码旁，`resolve.extensions` 里 `.js/.jsx` 排在 `.ts/.tsx` 之前 → dev/构建/单测全部静默加载旧产物

（见 ba99d638:pkgs.ts/diy-app/AGENTS.md:65）

## renderer-io

renderer **永不直接写文件**，一律经 RPC（如 `diy.task.drafts.*`）

（见 ba99d638:pkgs.ts/diy-app/AGENTS.md:73）

## schema-source

需自说明的结构（策略 / 投递注记 / 日志行）一律以 **zod 定义为唯一真源**：字段说明由 `src/shared/schema-doc.ts` 从 `.describe()` 派生，**禁止手写字段表**（手写 = 第二真源，改字段忘改注释就撒谎）；日志读侧校验走 `src/shared/context/log-schema.ts`（初版紧凑 / 扩展松散 / 缺必填即**异常数据**，不计入统计）

（见 ba99d638:pkgs.ts/diy-app/AGENTS.md:107）

## stdio

子进程 stdio 判据是**读端是否一定被排空**：常驻/分离式 spawn 一律 `inherit`/`ignore`；测试侧 `pipe` 必须挂 `data` 监听持续排空。⚠️ **不得**为解析 `DevTools listening on` 而 pipe stderr —— CDP 地址一律读 `DevToolsActivePort` 文件

（见 ba99d638:pkgs.ts/diy-app/AGENTS.md:66）

## steer-queue

**会话生成中再发消息不拒绝、改排队**（##306）：入 `SteerQueue`（缺省 **`next-step`** = 下一个模型步边界前整批投，横条可切回 `next-turn`），只回一条排队回执（`kind=error` + `meta.source=queue`，error 块不进 LLM 投影）；条数上限 `maxSteerQueue`（默认 1000，`local/limits.json`（**全局、不随会话分层**）/ `DIY_LOCAL_MAX_STEER_QUEUE`，超限在 `SteerQueue.add` **抛错**不静默丢）。**UI 两个入口**：输入框发送（`LocalChatPage` 的 `submit` 在 `live` 时本地早退 → 该路径目前只由 CLI / RPC 可达）与横条**留言**（`submitSteer`，同一队列、同一缺省时机 `shared/steer-mode.ts` 的 `DEFAULT_STEER_MODE`）

（见 ba99d638:pkgs.ts/diy-app/AGENTS.md:77）

## task-body

任务 body 的**软上限 4 KB**（`diy task show <uri>` 渲染字节）：超限不算错，但**下次编辑必须顺手瘦身**。超限处置按三层判据分流，别原样留着 ——

1. 「**三个月后还成立吗？**」成立 ⇒ 稳定结论 → `diy facts submit`（**任务级库优先**：`--in task:<uri>`，本任务自己的结论就该常驻本任务信封）；
2. 「**只对当时有意义吗？**」⇒ 历史流水 / 决策理由 / 事故复盘 → `diy journal add <uri> --kind progress|decision|pitfall|review|learn --title "一行"`（append-only，`--refs` 带 commit / PR）；
3. 「**接下来要做什么？**」⇒ 留 body。

瘦身后 body 只剩 3~5 段：定位 / 现在是什么 / 待办 / 明确不做 / 指路命令（取值的那条命令），**不留流水账**。实测背景（##408 派发时核对）：376 个任务 body 合计 4.51 MB，`>20 KB` 的 51 个，最大 ##166 单条 349 KB（2026-10-26 复核）—— 任务被唤醒时 body 整段进上下文，等于每条都常驻。

## test-bail

**撞红即停（`bail:1` 刻意保留），但回报必须说清范围**：根与各包 `vitest.config.ts` 全为 `bail:1` —— 早停省墙钟，代价是「后面的没跑」。交付口径写「跑到第一个失败文件为止：N files / M passed / 其余未跑」，**不许**把早停报成「全量通过」（判据 = 末行 `Test Files N failed (总数)`；拿不准就单跑那个失败文件）。历史：`##379` review2 里 `bail:1` 让 162 个文件只跑了 38 例。⚠️ 此前「交付口径改 `--bail=0`」的建议**已作废**（用户 2026-10-20 定：红就停，别再跑）

（见 ba99d638:pkgs.ts/diy-app/AGENTS.md:72）

## test-fixture

**提速靠跨文件共享 fixture，不靠合并测试文件**：文件边界跟**语义**走（一文件 = 一个被考察对象 / 一组不变量），**禁止**为省启动开销把不相干的测试并进一个文件。开销从 fixture 侧省：**只读且与测试无关**的准备数据（golden / 模型快照 / 造好的任务库与会话文件）放 `tests/fixtures/`，多文件直接读同一份；**被测试写**的状态一律隔离（`app.rule#test-home` 的 per-file `mkdtemp`），**不许**为了复用改成共享 —— 串味后失败点会漂到别的文件。现根/各包 `vitest.config.ts` 均无 `globalSetup`；需要一次性准备时按需引入，但**只准写 tmpdir、不写仓库**

（见 ba99d638:pkgs.ts/diy-app/AGENTS.md:70）

## test-home

隔离 HOME **用后即删**（`tests/temp-home.ts`）：两套前缀都要管 —— `diy-app-test-*`（electron-test，`stop()` 当场删）与 `diy-desktop-test-*`（`setup.ts` 每测试文件一个，`afterAll` 删；**`process.on("exit")` 在 vitest worker 里不触发** —— 被 tinypool SIGTERM 掐）。删除双校验：必须在 `os.tmpdir()` 下 + 带本套件前缀（`TEST_HOME_PREFIXES`），缺一不可；另有 `sweepStaleTestHomes`（>24h）兜强杀残留。历史代价：曾 4 天积 1583 个 / 2.9GB

（见 ba99d638:pkgs.ts/diy-app/AGENTS.md:67）

## test-isolate

**`unit` 跑 `--no-isolate`（每个 worker 共享一份模块图）⇒ 测试之间共享模块级状态，三条硬约束**（##402）：① **禁 `vi.mock`**（改全局模块表，先加载的实现会把它静默顶掉 ⇒ 「单跑绿、一起跑红」且无报错；机械护栏 `scripts/check-no-vi-mock.sh`，替代写法 = 依赖注入 / 手写假对象 / `server.deps.inline` alias）；② **模块顶层的可变状态必须在 `beforeEach` 复位**（真踩过：`sessionStore` 水位 / `usageLedgerStore` 缓存 / `rpc` 的 `setDiyService` 假实现残留 —— 症状是 `--sequence.shuffle` 换序即红）；③ **模块图顺序是语义的一部分**（`@diy-agent/rpc` 用原型补丁给 zod 装 `cliArg`，schema 创建时定死原型链 ⇒ 谁先建 schema 谁就看不见补丁；`tests/setup.ts` 已先引 rpc 钉死这条，别删）。验收判据：`test-unit` 与 `test-unit --sequence.shuffle` 两遍都全绿

（见 ba99d638:pkgs.ts/diy-app/AGENTS.md:71）

## test-perf

**别为提速虚拟化 fs / 进程，先量再动**（本机实测 2026-10-20）：fs 写 2KB **236µs** · 原子写 356µs · 读 34µs · 真 `spawn` 一个进程 **5.2ms**；而 `tests/core` 单文件墙钟 **≈1.9s**，其中 fs 最密的 `task.test.ts` 2.0s 里 sys 仅 0.43s、真写几十次 ≈ 几毫秒（**<1%**）。**反证**：`TMPDIR` 指到 512MB RAM disk（介质归零）跑同一文件 `1.94/2.01s → 2.58/2.16s`，**没变快** ⇒ 瓶颈不在介质也不在 syscall 次数，虚拟 fs（`memfs` / `unionfs` / `mock-fs`）的收益上界就是那几毫秒，代价是全仓 mock 复杂度。**进程**没有虚拟化库（进程不是纯数据结构），等价手段是注入（已有 `CollectDeps` / `HostPluginDeps.runCommand` / `SteerQueuePort`）。❌ 更要命的是**语义**：`##379` R1（copy 半截 + `existsSync` 认领）、`##382`（ENOSPC 毁 253KB）恰是真盘语义上的事故，memfs 里根本不存在 ⇒ 那类护栏永久失去。**判据（三条全过才虚拟化）**：耗 ≥10ms/次 · 测试里出现 ≥100 次 · 不需要验证其真实语义

（见 ba99d638:pkgs.ts/diy-app/AGENTS.md:69）

## test-render

intent 用 `--no-file-parallelism` + `fileParallelism:false`：**单实例串行**（起→测→收），实测 app 并发恒为 1；别改成并发（多实例抢 CPU 会让墙钟判据假红）

（见 ba99d638:pkgs.ts/diy-app/AGENTS.md:68）

## turn-lifecycle

**轮次生命周期独立于消费端连接**（##305）：`agent.local.chat` 虽是 `serverStream`，但**流只是订阅者** —— 驱动在 `LocalAgentManager.driveTurn`（`turns` 注册表持有，与生成器解耦），消费端断开（刷新/切页/关窗/杀 CLI）**只退订、不 abort**（旧行为"`finally` 里 `if(!done) ctrl.abort()`、无人消费即停"已废；改写这块别把生成器当驱动者）。无人消费**继续烧 token**（定案：窗口只是后端的使用窗口），开销由 **`maxSteps`（缺省 200，`DEFAULT_LIMITS.n`）步数上限**自然收口 —— **禁加时间维度的"无人即停"回收**（会误杀正常长任务）；真卡死由人在全局会话视图（导航「会话」`components/SessionOverviewPage.tsx`）手动中断（##308 已落地，见 `app.find#sessions`）。可见性 = `LocalAgentManager.watchers`（chat 流消费端 + `opsFeed` 订阅**都算**，UI 只走后者）→ `agent.local.running` 的 `subscribers`。⚠️ 摘除靠 **service 层听 RPC 注入的 `signal`**（`withCleanup` 第三参）：断开时 RPC 层调的是 `abort` + `void g.return()`，而 `return()` **排在悬挂的 `next()` 之后**（生成器卡在 `await inner.next()`）⇒ 无事件期间断开根本走不到 cleanup，订阅要等**下一条事件**才释放（`subscribers` 虚高）。**订阅类 serverStream 必须把 `signal` 一路传到 `withCleanup`**（`agent.local.chat` 的 `run.subs` / `ops-feed.subscribe` / `file-watcher.subscribe` **三处已接**，review1-R1 补齐 chat 那条），新增订阅源照办。重连追平走 ops 水位（读侧 ##307）

（见 ba99d638:pkgs.ts/diy-app/AGENTS.md:80）

## ui-notice

**所有用户可见提示（toast / 常驻条 / 内联状态条）必须能回答三问**：谁发的（机制名 + 代码位置）/ 为什么**此刻**发（带具体数值或时刻）/ 怎么消；一级只说一句话，二段进 `[详情]` 面板（`components/NoticeDetail.tsx`）。**只给结论不给机制的成功类提示一律不许上屏**（要么带详情，要么不弹）。新代码用 `addToast`（空 `source`/`reason`/`detail` 直接抛错），债务只许走 `addToastLegacy` 且条数不得增加（`tests/core/notice-contract.test.ts` 按文件钉死）。见 `app.find#notice`

（见 ba99d638:pkgs.ts/diy-app/AGENTS.md:78）

## user-run-merge

**「provider 拒连续同角色」是未验证假设，已于 2026-10-16 实测推翻**：`goat`（`api.commandcode.ai`）与 `opencode-go`（`opencode.ai/inference/go`）对 `[{user:A},{user:B}]` 及 content **parts** 形态**均 HTTP 200** ⇒ `local-agent.ts::normalizeUserRuns` 的合并是**收敛语义**（一份信封只留一条 user），**不是** provider 要求；真遇到拒的 provider，那里是唯一改动点（探针 ##310 的 `gen/probe/role-run-probe.sh`）

（见 ba99d638:pkgs.ts/diy-app/AGENTS.md:82）

## wire-envelope

投给模型的**一条消息 = 一份 YAML 信封**：一切**自动生成** / 机器携带的段（`summary:` / `history:` / `from:` / `runtime:` / `runtimeDiff:`）**各占一个顶层键**，**禁止**混进 `user.message`（混进去 = 自动生成的元数据伪装成用户原话；tasks/5 实测模型为此多烧 3 次 bash / 5.6 万 prompt token）。`from:`（##422）只出现在**历史** user 消息上（`from.id` = 成员 id、`name` = 当时的显示名；老块无 `speaker` ⇒ 裸文本，不造 `from: unknown`），它与 `user.message` **并列**而非嵌套 —— `withRuntime` 遇末条已是**信封**时尾部信封**自占一条消息**。**重放只剥 `runtime:` / `runtimeDiff:`**（`stripRuntimeSections`；`from:` / `history:` / `summary:` 是线索，逐字保留；裸文本与没有顶格 `user:` 的粘贴 YAML 一字不动），剥完仍是信封时也**不嵌套**。契约与派生唯一处 `src/shared/context/envelope.ts` + `README.md` 的「信封」行

（见 ba99d638:pkgs.ts/diy-app/AGENTS.md:81）

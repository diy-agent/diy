> 全仓契约见**仓库根 `AGENTS.md`**。本文件只写**包内定位**（去哪找）与**代码看不出来的坑**。
> UI 文案、字段清单、实现步骤等易变细节**不在此外** —— 现场 `rg`。意图测试是需求真源：`tests/cli.intent.*` + `tests/core/*`。

## find — 包内定位

- `find.main` — `src/main/index.ts` 主进程入口（窗口 / 诊断 / 单实例）
- `find.core` — `src/main/core/` 状态与文件落位：`state.ts`（数据根/任务路径单一出口）· `task*.ts`（任务读写与字段）· `tree-format.ts` · `drafts.ts`（草稿 + 插话队列）· `steer-queue.ts` · `persona.ts` · `cwd.ts` · `ref*.ts`（引用仓库同步）
- `find.svc` — `src/main/services/` RPC 与业务：`api-def.ts`（**契约**）· `api-impl.ts`（**实现**）· `local-agent.ts`（本地 agent 循环）· `local-blocks.ts`（op 流）· `usage-report.ts`（用量账本读取 + CLI 报表渲染，与 UI 同源）· `prompt-registry.ts`（提示词装配）· `agent-guard.ts`（自毁命令拦截）· `diagnostics.ts`（日志/异常兜底）
- `find.cli` — `src/cli/index.ts` CLI 入口（命令定义与 RPC 调用）
- `find.renderer` — `src/renderer_solid/`（Solid，主线）：`components/` 业务组件 · `store/` signal 单例 · `lib/` rpc client 与 `diy.ui.*` handler · `App.tsx` / `main.tsx`
- `find.shared` — `src/shared/` **跨层契约**（zod schema / 纯函数，main 与 renderer 共用，禁止各处重写）：`task-uri.ts`（URI 解析）· `task-detail.ts` · `task-list.ts`（排序搜索）· `persona.ts` · `prompt-schema.ts` · `session-view.ts` · `usage.ts`（**token 四桶 / 单价 / 金额的唯一口径处**，含 tier 选价与聚合）
- `find.context` — `src/shared/context/` 上下文树与投递：`README.md` 是**完整约定表**（领域模型 / 投递构造 / 划分真源 / step 快照 / 渲染坑）；投递构造唯一入口 `delivery.ts` 的 `buildDelivery`；划分真源 `$DIY_HOME/context.yaml`（契约 `config.ts`、I/O `src/main/core/context-config.ts`）
- `find.compact` — 压缩（**目标式预算**）：策略/账本/选择 `shared/context/compaction.ts`（`CompactPolicySchema` 真源 + `selectHistoryByBudget` 的宿主 `main/services/local-blocks.ts`）· 预算注记 `shared/context/budget-note.ts`（YAML 文本，`kept` 保留区间）+ 其**格式说明变量树节点** `history-index.ts` · 缓存 TTL 夹逼 `cache-ttl.ts` · 自动压缩 `auto-compact.ts`（真源 `$DIY_HOME/auto-compact.yaml`，契约 `shared/context/auto-compact.ts`、I/O `src/main/core/auto-compact-config.ts`）· 会话落盘路径唯一出口 `src/main/core/local-paths.ts`
- `find.model` — 模型 provider 配置机制（##184）：契约 `src/shared/model-config.ts`（`model.yaml` 配置层 + `providers.custom.yaml` spec 层 + 限定名切分 `splitQualified`）· 运行时可解析目录 `src/shared/models.ts`（`setModelCatalog`/`findModel`/`apiOf`…，**无内置 provider：无配置 = 空目录**）· 装配 `src/main/core/model-runtime.ts`（snapshot ⊕ custom ⊕ `$DIY_HOME/model.yaml` → 目录，含 `$VAR` 展开）· 文件 I/O `src/main/core/model-config.ts` · 配置 UI `src/renderer_solid/components/ModelConfigPage.tsx` · spec 真源 `src/main/data/models-snapshot.json`（models.dev npm 白名单产物，`scripts/gen-models-snapshot.mts`）· 单测夹具 `tests/fixtures/models.ts` · env 导入 `src/main/core/model-import.ts`（snapshot 声明的 env ∩ 本机变量 → 候选；**只列不写、不落明文、不覆盖已有**，UI 提示条与 `diy llmConfig scanEnv|importEnv` 同源）
- `find.env-import` — 模型页「环境变量导入」提示条 `src/renderer_solid/components/EnvImportBar.tsx`：**四态常显**（可导入 / 命中但均已配置 / 零命中 / 扫描失败），零命中态靠 `llmConfig.scanEnv` 回报的**扫描面**（`scanned`：191 家 / 181 个变量名）交代「查过什么」——只在有候选时出条，会让用户分不清「env 没这个变量」与「功能没跑」
- `find.seed` — 空数据根的初始种入 `src/main/core/seed.ts`：preview/lab 启动自动（`DIY_SEED` 开关）+ `diy seed run` 手动；**只配 opencode-go、人物模型 = `0@opencode-go/mimo-v2.6-flash`**，写 `$VAR` 引用；幂等（已存在不动），prod/test 缺省不种
- `find.serve` — `src/serve/index.ts` 纯 Web 模式（无 Electron）
- `find.tests` — `tests/`：`cli.intent.*` 意图测试（真实 UI / 隔离 Electron，**跑 `out/` 产物**）· `core/` `services/` 单测（vitest **直读 `src/`**）· 夹具 `electron-test.ts` · `ui-drive.ts` · `shell-test.ts` · `setup.ts`
- `find.scripts` — 仓库 `scripts/`：`ui-smoke/`（CDP 冒烟）· `cdp-colorscheme-demo.mts` · `repro-epipe-dialog.mts` · `doctor-env.sh`

## entry — 入口注入的环境变量

> 三者辨析（谁是客户端、谁起 GUI、数据根差异）见**仓库根 AGENTS.md「entry」**。本节只记本包读到什么。

入口脚本只负责**注入环境变量**，业务统一由 `src/runtime.ts readRuntimeConfig()` 读取组装，不做路径/模式派生。

| 入口 | 跑什么 | 注入 |
|------|--------|------|
| `./diy.sh`（仓库根） | `auto`：`build/<variant>/cli/index.js` 优先，打包源比产物新回退 `tsx src/cli/index.ts`（`DIY_CLI_MODE`） | `DIY_HOME=./build/<variant>/home`、`DIY_VARIANT=preview`、`DIY_CLI` |
| `bin/diy`（发布） | `node build/prod/cli/index.js` | `DIY_HOME=~/.diy`、`DIY_CLI=$0`、`DIY_ENV=production` |
| `scripts/electron-dev.mts`（preview / lab） | `build/<variant>/main/index.mjs` | `DIY_HOME=./build/<variant>/home`（继承来的生产根被拒，见 `env.home`）、`DIY_VARIANT`、`DIY_CLI`、`DIY_DEV_SERVER_URL`、`DIY_ENV=development` |

- `env.home` — `DIY_HOME` 数据根（state/task/**app.port**），缺省 `~/.diy`；**preview/lab 与 `diy.sh` 一律拒绝继承来的 `~/.diy`**（判据唯一定义处 `core/instance-identity.ts::isProdDataHome` ── 真实家目录；撞上后怎么回落见 `core/dev-home.ts::resolveDevHome`；放行需 `DIY_ALLOW_PROD_HOME=1`）
- `env.seed` — `DIY_SEED` 三态开关（`0`/`false`/`off` 关 · `1`/`true`/`on` 开；未声明 = 仅 `DIY_VARIANT` 为 `preview`/`lab` 时开）→ `src/main/core/seed.ts`（契约 `src/runtime.ts`）。**自动种入只跑一次**（`.seed-done` 标记：删掉的 provider 不会被种回来），补缺项用 `diy seed run`；**生产根永不种入**
- `env.cli` — `DIY_CLI` 当前 CLI 入口绝对路径（提示词模版 `diy.md` 消费）；缺 → 提示词里告警，**不静默冒充 `diy`**
- `env.env` — `DIY_ENV` = `production`/`development`/`test`，**dev/test 专属能力的唯一判据**（如窗口副屏定位）；缺省 = production（未声明即生产，能力全关）
- `env.port` — `DIY_PORT` 首选端口（测试注 `0`=随机）；优先级 `DIY_PORT` > `app.port` 文件 > 18888
- `env.noLaunch` — `DIY_NO_LAUNCH=1` 禁止 CLI 自动拉起 app（测试专用，防实例逃逸）
- `env.inject` — **入口自证，不继承**：`DIY_CLI` = 「跑的是谁」。各入口各声明自己（`diy.sh` → 自身；`bin/diy` → `$0`；`electron-dev.mts` → `<repo>/diy.sh`；`serve/index.ts` → 从自身位置找仓库根）。`main/index.ts` **只在未注入时**兜底自证（`||=`，按数据根推导：生产根 → `"diy"`，隔离 → `<repo>/diy.sh`）—— 无条件覆盖会误伤生产 GUI（把 `bin/diy` 注入的 `$0` 换成 `<repo>/diy.sh`）。`serve` 不 import main，故独立自证一次
- `env.self-declare` — **三件套 `DIY_HOME`/`DIY_CLI`/`DIY_ENV` 都自证，不继承**（开发入口）。继承的生产值（agent 会话常带 `DIY_HOME=~/.diy`、`DIY_CLI=<全局 diy>`、`DIY_ENV=production`）会：操作生产数据 / 让模型敲错的 CLI / 误关 dev 能力。数据根判据：`core/instance-identity.ts`（`prodDataHome` / `isProdDataHome` / `cliEntryForRepo`，**全仓唯一**；dev 侧再经 `core/dev-home.ts::resolveDevHome` 回落 `build/<variant>/home`）；`DIY_ALLOW_PROD_HOME=1` 放行。数据根：未设置或指向生产根 → `<repo>/build/<variant>/home`；`DIY_ENV`：`production` → `development`。`serve` 直接跑也走同一套（它不 import main）
- `env.variant` — `DIY_VARIANT` = `prod|test|preview|lab`，**产物/数据分根的唯一轴**：vite 配置据此定 `outDir=build/<variant>/*`，运行时据此选 `build/<variant>/main`，缺省 `prod`（`./diy.sh` 缺省 `preview`）。preview/lab 各占一根 → 可并行、互不打断 watch；test 独占 `build/test/**`

## rule — 硬约束

- `rule.noemit` — **类型检查绝不 emit**（各包 `noEmit: true`，唯一入口 `./sha.sh check`）。一旦产物落在源码旁，`resolve.extensions` 里 `.js/.jsx` 排在 `.ts/.tsx` 之前 → dev/构建/单测全部静默加载旧产物
- `rule.stdio` — 子进程 stdio 判据是**读端是否一定被排空**：常驻/分离式 spawn 一律 `inherit`/`ignore`；测试侧 `pipe` 必须挂 `data` 监听持续排空。⚠️ **不得**为解析 `DevTools listening on` 而 pipe stderr —— CDP 地址一律读 `DevToolsActivePort` 文件
- `rule.test-home` — intent 的隔离 HOME（`$TMPDIR/diy-app-test-*`）**用后即删**（`tests/temp-home.ts`）：测试目录不再永久堆积（曾 4 天积 1583 个 / 2.9GB）。删除双校验：必须在 `os.tmpdir()` 下 + 带本套件前缀，缺一不可
- `rule.test-render` — intent 用 `--no-file-parallelism` + `fileParallelism:false`：**单实例串行**（起→测→收），实测 app 并发恒为 1；别改成并发（多实例抢 CPU 会让墙钟判据假红）
- `rule.renderer-io` — renderer **永不直接写文件**，一律经 RPC（如 `diy.task.drafts.*`）
- `rule.check` — 类型检查只准 `./sha.sh check`；**同一变体**的 `preview`/`lab` 运行中勿并发 `tsc -b`/`vite build`/全量 vitest（抢同一 `outDir`，watcher 卡死）。跨变体（preview vs test）不抢——各写 `build/<variant>`
- `rule.agents-chain` — AGENTS.md 链**上界到 `$HOME` 为止**（不进 `/`、`/Users`）；不在 `$HOME` 下时只取工作目录一层
- `rule.budget` — 系统提示词预算 `clamp(模型上下文 × 4B × 5%, 16KB, 64KB)`；超限**拒发不截断**，且早退也必须闭合轮次（stop + noteTurnEnd + 审计）
- `rule.golden` — 改内置模版（`src/main/prompts/defaults.ts`）**必须同步** `tests/fixtures/system.golden.txt`（当前内置模版的逐字节快照）。⚠️ `./sha.sh check` **不含 vitest**，不会替你抓到这类失效 —— 改完模版跑 `npx vitest run tests/core/template-dsl-golden.test.ts`
- `rule.agents-injected` — **本文件会被 `chainOf` 注入 system 提示词**（受 64KB 预算 `SYSTEM_BUDGET_CAP_BYTES` 约束）：长文写 README / 独立文档，这里只留指针
- `rule.no-silent-catch` — 不要静默吞异常（如切模型曾一律 `catch {}` → 用户以为切了其实没切）
- `rule.log-vs-config` — **落盘日志**（`local/*.jsonl`）读侧宽松（初版紧凑/扩展松散/缺必填即**异常数据**，见 `log-schema.ts`）；**配置真源**（`context.yaml` / `auto-compact.yaml`）读侧出声回落默认、写侧归一 + 原子写，且**不进 localStorage**（有损 + 两进程各持一份）
- `rule.form-toggle` — **表单里的三态控件**：二态开/关用 daisyUI **toggle**、多选一用 **radio**（两者形态必须一眼可分，别都塞 checkbox）；**按钮位**（工具条 / view bar / 图标切换）用 **swap**（隐藏 checkbox + 图标双态，省地方）—— 三者各司其职，别互串
- `pit.budget-compact` — 压缩 = **一个字节预算**（`budgetBytes`，UI 显示 KB，除固定开支外历史消息可占上限；`0`=清零）：按**纵向优先级阶梯** `selectHistoryByBudget`（`user > assistant结论 > assistant非结论 > tool-call > tool-result`，全局跨轮、同层新的先、call 与 result 同进退）保留到预算。**不是**「保留 N 轮」（横向会整轮陪葬前面重要的用户消息 —— 用户明确否决）
- `pit.config-vs-history` — **配置 / 历史分离**（用户 2026-10-07）：投递口径 = **当前配置**（`$DIY_HOME/auto-compact.yaml` 的 `policy`），**每次请求实时算** ⇒ 改预算**本轮即生效**；压缩账（`<key>.compact.jsonl`）只是**不可变快照**（历史页/回溯用），**不决定投递**。⚠️ 别再让投递去读 `resolveBoundary`（旧边界机制已废：没压过就不生效，违反直觉）
- `pit.history-filter` — **历史 = 固定的消息集合**；一次压缩 = 用**某算法**对它定义的一个**过滤条件**。事件里的 `policy` 承载**算法**（`mode`，现役只有 `budget`）与该算法的**过滤器表达**；**换算法 = 加新分支 + 新 filter 形状**，别用一套结构硬套。旧「分代（generations）」**已删除**（连续轮边界表达不了预算的分散保留）
- `pit.compact-shape` — 策略真源是**带归属的结构** `{ mode:"budget", modeData:{ budgetBytes, toolResult }, summary }`（`modeData` 内 = 该 mode 私有；与 `mode` 同级 = 共有）。现役**只有 `budget` 一种算法**（`reset`/`keep` 已删，未发布无需兼容）。工具结果的呈现（`toolResult`，headtail 参数在 `renderData`）是**系统内部旋钮**（不给用户拧）。互转收口：`normalizePolicy`（任意→合法）/ `flatPolicyOf`（→扁平输入面）/ `budgetBytesOf`（→字节预算唯一入口）。**别再新增第三形状**
- `pit.compact-note` — 预算压缩的历史标注 = **普通 YAML 文本塞进 messages**（同 system/runtime 变量树同一机制）：只列**保留区间** `kept: [[a,b],…]`，区间之间的行号即被省略（**不逐 gap 标注**）；字段说明走 **YAML 的 `legend:` 元数据节点**（由 zod 派生，非 `#` 注释）。⚠️ 标注是投递时现算的文本 ⇒ **本就在预算内**（无需为它另设封顶）
- `pit.compact-triggers` — 自动压缩的三个触发（`systemContextChanged` / `cacheExpired` / `contextWindowOver`）**全是从现成数据可判定的确定事实**（零额外请求），**不含"划不划算"的预测** —— 后者是 ##230#25 明确放弃的评估；改动别把判据换成估算
- `rule.schema-source` — 需自说明的结构（策略 / 投递注记 / 日志行）一律以 **zod 定义为唯一真源**：字段说明由 `src/shared/schema-doc.ts` 从 `.describe()` 派生，**禁止手写字段表**（手写 = 第二真源，改字段忘改注释就撒谎）；日志读侧校验走 `src/shared/context/log-schema.ts`（初版紧凑 / 扩展松散 / 缺必填即**异常数据**，不计入统计）

## pit — 坑（反直觉，代码看不出来）

- `pit.watch-restart` — 改 `src/**` 会触发 preview/lab watch 重启 Electron，**正在跑的本机 agent 轮次会被打断**（tool 被标 `interrupted`）→ 轮次中别拿源码当探针，探针写 `/tmp`
- `pit.solid-show` — Solid 组件函数体里的 `if (props.x) return A; return B;` **对 props 变化不响应**（函数体只执行一次）→ 用 `<Show when=… fallback=…>`。反之，`<Show>` 内组件在 `onCleanup` 里读 `props` 会抛 `Stale read from <Show>` 并中断更新 → 需"卸载前落盘"的副作用放面板级组件
- `pit.singleton-lock` — 隔离实例必须用**全新 `DIY_HOME`**（`mktemp -d`）：`SingletonLock` 写在 `electron_user_data/` 下，残留实例会抢锁 → 新实例打 `SingleInstanceLock: failed` 后直接退出。撞锁时换新 home，别动别人的进程
- `pit.self-destruct` — agent 起的进程**继承宿主 main 的进程组**，所以收掉自己拉起的实例会命中自毁护栏被拒（判据 `src/main/services/agent-guard.ts` 的 `collectSelfInfo`：同 pgid 或命令行含 `main/index.mjs`）。**不要绕过护栏** —— 把「要收的实例号 + 用途」列给用户手动收
- `pit.cdp-port` — `DevToolsActivePort` 文件内容**不一定是当前实例的端口**（输给单实例锁的第二个实例也会先写自己的端口再退出）→ 读后必须 `curl --max-time 3 http://127.0.0.1:<port>/json/version` 校验
- `pit.cdp-goto` — `playwright-cli attach` 模式下**不要用 `goto`**（CDP 附加态不支持 `Target.createTarget`，一次 goto 就打坏会话）；换页用 `reload`
- `pit.cdp-hit` — 点击前做**命中自检** `document.elementFromPoint(中心) === 目标元素`（抓「按钮溢出被相邻元素盖住」的唯一手段）；断言读 DOM 不靠截图；`elementFromPoint` 只测坐标，**真实手势链**要 `mouse.move/down/up` 分步，且拖拽**必须给真实时间 + 至少一帧**（CDP 合成事件是瞬时的，dnd-kit 异步激活等不到）
- `pit.shell-test` — `ShellTest` 的输出边界 = stderr 的 PS1 marker + **stdout 的哨兵**：marker 只证明命令结束，stdout 是另一管道、到达顺序不保证，只等 marker 会读到半截输出并让后续每条命令错位
- `pit.env-pollution` — 跑意图测试 / CDP 夹具前 shell 里**不要 export `DIY_PORT` / `DIY_HOME`**（`ShellTest` 继承 `process.env` → 每条 `./diy.sh` 都去打别的端口、各拉一个新 app 互踢）。正确姿势 `env -u DIY_PORT -u DIY_HOME npx vitest run …`
- `pit.intent-build` — **`tests/cli.intent.*` 跑的是 `build/test/` 编译产物**（起隔离 Electron，main/preload/renderer 全来自产物）：改 `src/**` 后不构建就跑 = 拿旧代码断言（症状：文案/diff 断言莫名失败，而同一份源码的单测全绿）。`sha.sh test-intent` 自动 `DIY_VARIANT=test build`；`tests/core|services` 是 vitest 直读源码，无需构建
- `pit.app-root` — **包根别数 `dirname`**：CLI 的源码 `src/cli/index.ts`（包根下 2 级）与产物 `build/<V>/cli/index.js`（4 级）深度不同 —— 固定 4 次只对产物成立，`DIY_CLI_MODE=tsx` 直跑时报「未构建: `<repo>`/pkgs.ts/build/…」（少了 `diy-app`）。判据 = 按 `package.json` 标记上溯（`core/app-root.ts`，有单测）
- `pit.excepthook` — 主进程**自注册 `uncaughtException` 处理器即抑制 Electron 的模态异常框**（其内置守卫是 `listenerCount > 1`），与有没有 try/catch 无关；诊断由 `installDiagnostics` 统一挂（三入口各落独立日志）
- `pit.interrupt` — 中断的 tool 调用必须**在新一轮开始时收敛成显式终态并写进 ops**，投影（`blocksToMessages`）只做纯翻译。禁止退回"投影时现造占位文案"：文案会被模型当待办，重载后同一条自毁命令会被重发
- `pit.llm-log` — `$DIY_HOME/local/<key>.llm.jsonl` 是**append-only 全量消息日志**（每行 1 条原生 ModelMessage + 索引位 `turn`/`step` + 工具结果的 `origin` 自证位），**行号 = 消息序号**（压缩注记的 `range` 就指它）。与压缩**解耦**：压缩只改投递期投影，绝不写它。加载时与 ops 投影对账（前缀则补齐 / 中部不一致则整份重建）
- `pit.theme` — 主题**不得回落 `prefers-color-scheme`**：Playwright 的 `colorScheme` 默认 `"light"`，attach CDP 会覆盖系统外观把界面刷白
- `pit.daisyui-drawer` — drawer 需渲染 `<input class="drawer-toggle">`，漏了侧栏 `visibility:hidden` 直接消失
- `pit.hl-token` — CodeMirror 默认**只给 token 挂 class、不上色**：必须配 `HighlightStyle` + `syntaxHighlighting()`。`&light`/`&dark` **只能**用在 `EditorView.baseTheme`，写在 `EditorView.theme` 里是**模块加载期**抛错 → 整个 renderer 白屏
- `pit.ctx-two-lines` — **上下文树页**（ctxlab）的请求预览是**真发形态**（走 `buildDelivery`）；**提示词页**（lab）是**模版线**（`assembleSystem`）。两者不是同一条链，改动别互推
- `pit.one-prompt-source` — `_guard.md` 不得复述 `INTERRUPTED_TOOL_NOTICE`；该文案唯一来源是 `local-blocks.ts` 的常量
- `pit.localstorage` — **禁止把草稿写 localStorage**（属有损数据，且 serve 与 Electron 各持一份）：草稿 + 插话队列落任务目录 `.diy/drafts.yaml`，会话日志落 `$DIY_HOME/local/`
- `pit.ref-lock` — `ref-sync.ts` 写 **v5** 格式的 `.diy/ref.lock.yaml`（`ref.{python,node}.{scope}.{category}`），而 `pkgs.ts/diy-dev/src/ref/store.ts` 写 **v1**（`source.{key}`）到**同一个文件** → 后写覆盖前者，且两者**互读为空、不报错**（读侧各自 `?? 5` / `?? 1` 兜底）。改这个文件前先确认哪边是活的
- `pit.ownership` — 任务目录内 `AGENTS.md` 面向用户可编辑，`.diy/**` 系统独占（仅 main 经 RPC 写）；路径单一出口 `src/main/core/state.ts` 的 `taskSystemDir(uri)`
- `pit.agent-history` — 本地 agent 的 `bash` 工具若执行批量杀进程命令（按名字匹配 electron 的一类），会杀掉宿主自己的 renderer → 永久白屏且进程被杀事件捕获不到：只能**执行前拦截 + 执行前落盘**（`src/main/services/agent-guard.ts` / `agent-audit.ts`）

- `pit.steer-two-phase` — 插话的「认领」（`prepareStep` 只读队列、注入请求 messages）与「落位」（流里出现 `start-step` 时才 sink + 出队）**不能合并**：两条流不同一时间轴，提前 sink 会把插话插到上一步未完内容之前。轮末开场则**只读不取**（先记账再出队），中途崩掉最坏重复投一遍、不会丢。理由见 `local-agent.ts` 的 `claimStepSteers` 头注
- `pit.model-ref` — `persona.model` = **完全限定名** `account@provider/model`（按**第一个** `/` 切 provider|model —— 模型 id 自带 `/`；provider 段按**最后一个** `@` 切 account|provider）。custom provider 恒带 `custom:` 前缀（永不与 models.dev id 撞）。存量裸名不自动迁移（手工批处理）。账号名缺省 = 序号 `0`
- `pit.model-apiface` — API 面**由 npm 解析**（与 models.dev 对齐，不硬编码名单）：`provider.npm` 默认 + 模型级 `provider.npm` 覆写（opencode-go 的 gpt-5.6/6-luna 在 models.dev 里就是 `@ai-sdk/openai`）。白名单 `@ai-sdk/openai-compatible`→chat / `@ai-sdk/openai`→responses，其余 npm 的模型不出现。`providerOptions` 命名空间随面对齐（chat → `openaiCompatible` / responses → `openai`）
- `pit.model-env` — `model.yaml` 的账号 `data.value` 支持 `$VAR`/`${VAR}` 展开（未定义 = **fail-fast**，不静默发空 key）；无 env 回退，账号必填。密钥**明文可**（最简单），多账号是一等公民（同一 provider 多订阅）
- `pit.persona-id` — persona 引用**存 id 不存名字**：名字只是标签（可随时改），拿名字当引用键则改名 = 打断所有引用（引用者静默回落缺省人物）。理由见 `src/shared/persona.ts` 头注
- `pit.usage-buckets` — 用量口径三条硬约束（`shared/usage.ts` 是唯一实现，别在别处另算）：① **思考输出是总输出的子集**，展示可拆、计价**不另加**（照抄 opencode 公式即重复计费）；② **不可测桶写 `null` 不写 0**（`api:"chat"` 面拿不到 cacheWrite，记 0 = 静默低估成钱）；③ **窗口占用取最后一步**（总输入+总输出），累加值只解释「这轮为什么贵」。单价快照随每行落盘（单价会变，历史账不能漂）
- `pit.cli-kebab` — CLI 选项名默认取 schema 字段名（camelCase），parser 另注册 kebab 别名并**在 help 里显示 kebab**（`--by-agent`），两种写法都接受 —— 新增 camelCase 选项无需额外处理
- `pit.head-note` — **关键设计理由都写在各自文件头注**（`src/main/core/steer-queue.ts` / `persona.ts` / `drafts.ts` / `src/main/services/local-agent.ts`）：改动前先读头注，别只看函数名

## tool — 验证与调试

- `tool.check` — `./sha.sh check`（提交前唯一检查）· `./sha.sh test` 全仓 · `npx vitest run tests/core/…` 单测
- `tool.ui-verify` — **两层互补**：`diy.ui.*`（handler 层，CLI 经 RPC 直调 renderer 共享函数，测行为/契约，稳定但**测不到真实 DOM 事件链的 bug**）vs **Playwright/CDP 真实事件层**（`mouse.move/down/up` 驱动真实 renderer，抓 gesture bug —— UI 交互改动后必跑）
- `tool.inspect` — `./diy.sh ui inspect` 遍历 renderer DOM 生成无障碍树，快速看 UI 全貌
- `tool.cdp` — 取 CDP 地址：`cat "$DIY_HOME/electron_user_data/DevToolsActivePort"`（**读后校验**，见 `pit.cdp-port`）；`./sha.sh preview | lab` 启动日志会打印完整 `attach` 命令
- `tool.smoke` — `node scripts/ui-smoke/task-detail-smoke.mjs`（任务详情三块 + 拖宽落盘）· `python3 scripts/ui-smoke/dnd-smoke.py`（⚠️ 它的收尾用按名匹配的强杀，**会连正在用的 diy 一起收掉** —— 跑之前先改掉那段；且本机需 `pip install playwright`）
- `tool.log` — 应用日志 `$DIY_HOME/log/`：`main.log` / `cli.log` / `serve.log` / `dev.jsonl`（`grep watch-stall-suspect` 判 watcher 卡死）/ `agent-bash.jsonl`（agent 命令审计，write-ahead）
- `tool.isolate` — 起隔离实例：全新 `DIY_HOME`（`mktemp -d`）+ `export HOME=$H`；演示数据落 `/tmp`，不写用户 `~/.diy`
- `tool.persona` — `diy agent persona list|set|setDefault`；模型/参数属**人物**，任务只持引用 id
- `tool.steer` — `diy chat --mode next-step|next-turn` 入队插话；`steer` 组只做队列管理（list/cancel/toggleMode/reorder）

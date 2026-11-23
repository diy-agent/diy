---
desc: 入口注入的环境变量（DIY_HOME / DIY_CLI / DIY_ENV / DIY_VARIANT…）
updated: 2026-10-23
---

## bin-diy

`bin/diy`（发布）→ `node build/prod/cli/index.js`；注入 `DIY_HOME=~/.diy`、`DIY_CLI=$0`、`DIY_ENV=production`

（见 ba99d638:pkgs.ts/diy-app/AGENTS.md:48）

## cli

`DIY_CLI` 当前 CLI 入口绝对路径（提示词模版 `diy.md` 消费）；缺 → 提示词里告警，**不静默冒充 `diy`**

（见 ba99d638:pkgs.ts/diy-app/AGENTS.md:54）

## diy-sh

`./diy.sh`（仓库根）→ 跑 `auto`：`build/prod/cli/index.js` 优先，打包源比产物新则回退 `tsx src/cli/index.ts`（`DIY_CLI_MODE`）；注入 `DIY_HOME=./run/diy-app/<variant>`（缺省 lab）、`DIY_VARIANT=lab`（**只是标签**）、`DIY_CLI`

（见 ba99d638:pkgs.ts/diy-app/AGENTS.md:47）

## electron-dev

`scripts/electron-dev.mts`（lab）→ `build/prod/main/index.mjs`；注入 `DIY_HOME=run/diy-app/lab`（缺了报错、继承来的生产根被拒，见 `app.entry#home`）、`DIY_VARIANT`、`DIY_CLI`、`DIY_DEV_SERVER_URL`、`DIY_ENV=development`

（见 ba99d638:pkgs.ts/diy-app/AGENTS.md:49）

## env

`DIY_ENV` = `production`/`development`/`test`，**dev/test 专属能力的唯一判据**（如窗口副屏定位）；缺省 = production（未声明即生产，能力全关）

（见 ba99d638:pkgs.ts/diy-app/AGENTS.md:55）

## home

`DIY_HOME` 数据根（state/task/**app.port**），缺省 `~/.diy`；**lab / `diy.sh` / `serve` 一律拒绝继承来的 `~/.diy`**（判据唯一定义处 `core/instance-identity.ts::isProdDataHome` ── 真实家目录；撞上后怎么回落见 `core/dev-home.ts::resolveDevHome`；放行需 `DIY_ALLOW_PROD_HOME=1`）。bash 侧（`diy.sh`）同口径归一写法（`cd <dir> && pwd -P`：尾斜杠 / `..` / `./` / 符号链接，是 TS `resolve` 的超集）

（见 ba99d638:pkgs.ts/diy-app/AGENTS.md:51）

## inject

**入口自证，不继承**：`DIY_CLI` = 「跑的是谁」。各入口各声明自己（`diy.sh` → 自身；`bin/diy` → `$0`；`electron-dev.mts` → `<repo>/diy.sh`；`serve/index.ts` → 从自身位置找仓库根）。`main/index.ts` **只在未注入时**兜底自证（`||=`，按数据根推导：生产根 → `"diy"`，隔离 → `<repo>/diy.sh`）—— 无条件覆盖会误伤生产 GUI（把 `bin/diy` 注入的 `$0` 换成 `<repo>/diy.sh`）。`serve` 不 import main，故独立自证一次；它**无条件覆盖** `DIY_CLI`（没有上游入口为它声明，只能自证），与 main 的 `||=` 语义相反 —— 别照抄。**三处入口（`diy.sh` / `bin/diy` / `electron-dev.mts`）漏一处注入，提示词就退化成裸 `diy`（→ 打到生产）**

（见 ba99d638:pkgs.ts/diy-app/AGENTS.md:59）

## injection-only

入口脚本**只负责注入环境变量**，业务统一由 `src/runtime.ts readRuntimeConfig()` 读取组装 —— 不在入口里做路径 / 模式派生（派生逻辑只在 runtime 与 `core/*`，两处各推一遍必然分叉）

（见 ba99d638:pkgs.ts/diy-app/AGENTS.md:43）

## instance-identity

CLI 复用已运行实例前**必须问对方是谁**：连端口发 `diy.getAppInfo`，比 `diyHome`（同一性判据 `core/instance-identity.ts::sameDataHome` = 写法归一 + 解符号链接）→ 不是本数据根就拒绝复用、另起自己的（实现 `src/cli/probe-instance.ts`，等待循环里同样校验）。`app.port` 只是端口缓存、可能陈旧到别人的实例上（##328(实例身份只靠端口) 的串台就是这样发生的）

（见 ba99d638:pkgs.ts/diy-app/AGENTS.md:57）

## noLaunch

`DIY_NO_LAUNCH=1` 禁止 CLI 自动拉起 app（测试专用，防实例逃逸）

（见 ba99d638:pkgs.ts/diy-app/AGENTS.md:58）

## port

`DIY_PORT` 首选端口（测试注 `0`=随机）；优先级 `DIY_PORT` > `app.port` 文件 > **按环境缺省**（`runtime.ts::defaultPort`：production=`18888` 门牌，development/test=`0` 随机）；裁决 `runtime.ts::resolvePort`（纯函数、可单测，**非生产不沿用记录里的 `18888`**）。**端口不承载身份** —— 别再往它上面挂「谁在跑」的判据

（见 ba99d638:pkgs.ts/diy-app/AGENTS.md:56）

## scope

**本节只记本包读到什么**；入口辨析（谁是客户端 / 谁起 GUI / 启动器≠客户端 / 变体必须配对 / 数据根差异）在仓库级 `entry.*` 主题（见 `entry#choose` / `entry#launch-vs-client` / `entry#variant-match`）

（见 ba99d638:pkgs.ts/diy-app/AGENTS.md:41）

## seed

`DIY_SEED` 三态开关（`0`/`false`/`off` 关 · `1`/`true`/`on` 开；未声明 = 仅 `DIY_VARIANT` 为 `lab` 时开）→ `src/main/core/seed.ts`（契约 `src/runtime.ts`）。**自动种入只跑一次**（`.seed-done` 标记：删掉的 provider 不会被种回来），补缺项用 `diy seed run`；**生产根永不种入**。**职责 = 示例/测试数据**（示例项目与任务 + 缺省人物 + `$VAR` 占位凭据）；真配置见下条

（见 ba99d638:pkgs.ts/diy-app/AGENTS.md:52）

## self-declare

**三件套 `DIY_HOME`/`DIY_CLI`/`DIY_ENV` 都自证，不继承**（开发入口）。继承的生产值（agent 会话常带 `DIY_HOME=~/.diy`、`DIY_CLI=<全局 diy>`、`DIY_ENV=production`）会：操作生产数据 / 让模型敲错的 CLI / 误关 dev 能力。数据根判据：`core/instance-identity.ts`（`prodDataHome` / `isProdDataHome` / `cliEntryForRepo`，**全仓唯一**；`core/dev-home.ts::resolveDataHome` 只认显式值）。**非生产没给 `DIY_HOME` → 报错退出**（不推导、不回落；路径由入口脚本按 `run/<app>/<label>` 算）；撞生产根 → 报错（`DIY_ALLOW_PROD_HOME=1` 才放行）；`DIY_ENV`：`production` → `development`。`serve` 直接跑也走同一套（它不 import main）

（见 ba99d638:pkgs.ts/diy-app/AGENTS.md:60）

## sync-home

**测试实例完整依赖自己的数据根**（2026-11-23 起）：运行时**不**直读 `~/.diy/model.yaml` —— 否则 lab 里改模型/存凭据会写生产文件（假隔离）。查找链 = `--model-config` > `<home>/model.yaml`；`~/.diy/model.yaml` 只剩「home 的父目录就是生产根」这一档（结构性判据，非 mode 标签）。真配置由 `scripts/seed-run-home.sh` 在**准备**阶段填进 `run/<app>/<label>/`（`./sha.sh sync` 顺带跑，幂等；含 key、只落 gitignore 内的 run/）。**新 worktree 只需跑一次 `./sha.sh sync`**：它以 `--defaults` 建出每个 app 的 `run/<app>/lab` 并填配置，之后 `./sha.sh lab` 直接可跑（不必先起一次空实例）。清单只 3 份且**只有 model.yaml 是必需的**：personas 缺 → 内置人物 `persona/1 大副`、providers.custom 缺 → customProviders 为空（没人读）、input-limit 等是运行时写入式有默认值。其它标签（`staging`/`preview`/自定义）不在 `--defaults` 里，按需 `./scripts/seed-run-home.sh run/<app>/<label>` 填

（见 ba99d638:pkgs.ts/diy-app/AGENTS.md:53）

## variant

`DIY_VARIANT` = `prod|test|lab|preview`，**只剩运行时标签**（dev 能力 / 自动种入缺省 / 实例显示名）——**不决定任何路径**。产物固定 `apps/<app>/build/prod/**`（vite `outDir` 写死）；数据根由入口脚本算 `run/<app>/<label>` 并显式传 `DIY_HOME`。**`lab` = watch/HMR（边改边看）**；**`preview` = 编译后运行、无 watch 的稳定实例**（##404：lab 每改一处 src 就重启主进程、打断正在跑的轮次 ⇒ 要持续对话用它）。`preview` 只是标签，产物仍是 `build/prod`，数据根 `run/diy-app/preview`；入口 `apps/diy-app/sha.sh preview`（`--build` 强制重编译 / `--from <label>` 首次克隆那份 home）。**一份产物 ⇒ 同一 worktree 的 `lab` 与 `test`/`staging --build` 不能同时跑**（watch 会覆盖产物）。

（见 apps/diy-app/sha.sh:113）

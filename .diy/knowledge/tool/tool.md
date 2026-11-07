---
desc: 命令
updated: 2026-11-06
---

## async-io

**app（主进程 / shared / preload）里不许出现同步 IO**：一律 `node:fs/promises` 的 `await` 版本，子进程用 `execFile` 而非 `execFileSync`/`spawnSync`。判据不是「会不会卡」而是**主进程是单线程事件循环** —— 一次 `readFileSync` 就把渲染、RPC、流式输出一起按停；落在热路径上（面板每 3s 刷、每个输出块）就是 UI 掉帧的唯一原因。**新增由 `scripts/check-sync-io.sh` 拦**（挂 `./sha.sh check`，存量按 `LEGACY_SYNC_IO_BASELINE` 逐文件钉数**只减不增**）；确实必须在同步窗口里做（启动早期 / 原子写工具本身 / CLI 一次性初始化）写 `// sync-io-ok: <理由>`。测试文件不在此列（不在事件循环关键路径）。

## bash-sync

**同步就同步，不要诱导转后台**。给 bash 设短超时再引导 model 走 nohup 会破坏同步语义（「搜完再做一件事」变成叫醒服务）。长命令可以慢，问题只在「命令早结束但工具调用还挂着」这类故障点（见 ##454）。默认不超时；显式给了 `timeout` 就尊重它。

## check

`./sha.sh check` 是**提交前唯一检查**（tsc `--noEmit` + oxlint + 产物 / 可执行位 / 规范索引护栏）；改一行只跑受影响测试，全量收工前一次

## cli

查/改数据：生产 `diy <域> <命令>` · worktree `./diy.sh <域> <命令>`；**域名清单真源 = `diy --help`**，别抄清单

## cli-stderr

**CLI 的 stderr 是「环境警告」通道，不是错误噪音**（数据根被拒 / 变体被改 / `DIY_ENV` 被改都在里面），stdout 才是 JSON 数据。**禁止 `2>/dev/null`** —— 屏掉的恰是「你连的不是你以为的数据根」这类唯一提示（实测因此把正常输出误判成「命令没输出」）。要静音就 `2>/tmp/warn.log`，别丢

## confirm

破坏性操作的应用内二次确认走 `ConfirmDialog.tsx`；**禁用原生 `window.confirm`**（窗口级模态，且自动化点不到）

## dev-launcher

**dev 启动器（_diy/apps/dev）的命令层**：
- `./sha.sh build` 只出产物，固定 `build/app/`（与变体无关）
- `./sha.sh run <launch> --slot N` 跑某条 launch（lab / staging…）；数据根**由槽位推导**：`<worktree>/build/<launch>/<slot>/home`，app.yaml 不再声明 `home`（显式写才算例外）；注入 `DIY_LAUNCH=<launch>/<slot>`、`DIY_VARIANT=<launch>`、`DIY_DEV_LAUNCH_SLOT=<slot>`
- `./sha.sh app list | new --launch lab | stop <slot|pid|all>`：多实例管理，`new` 自动挑最小空闲槽位并后台起（日志 `build/<launch>/<slot>.log`）
- `./sha.sh -h` / `./sha.sh run lab -h` 看帮助（帮助由 `#:` 注释自动生成）
- 实例注册表**只有一个真源**：`@diy-agent/dev-paths` 的 `registryDir()` = `~/.diy/dev/apps/<pid>.json`（`DIY_INSTANCE_REGISTRY` 可覆盖，测试用）；各 app 不再自己拼路径
- 面板认领三元组：`(worktree, app, launch 名允许 /slot 后缀, 数据根族 build/<launch>)`；族外（如真生产 `~/.diy`）归「外部实例」，只读不可停

## diy-cli-root

**能力真源是 `diy --help` / `diy <域> --help`，但先确认你敲的是哪个 `diy`**：PATH 首位常是 worktree 的 `node_modules/.bin/diy`（**未构建 ⇒ 只报错**），生产客户端在 `~/.local/share/mise/installs/node/lts/bin/diy`；跨数据根必须 `env -u DIY_HOME -u DIY_VARIANT`，否则被环境变量拉去连别的实例 —— 症状是「任务 N 不存在」，不是报错。**「有真源 ≠ 有送达」**：不知道某域存在时先跑 `diy --help` 再翻源码。

## electron

electron 43 **无 postinstall**：缺二进制会在进程内**无超时**下载（症状＝静默卡死）；布局与校验收口 `scripts/ensure-electron.mjs` + `ensure-electron-if-needed.sh`

## electron-cache

**缓存里明明有 zip 却重下**的根因：`@electron/get` 缓存键 = **下载 URL 目录**的 sha256；`~/.npmrc` 的 `electron_mirror` 只在 npm 上下文生效（运行时直接 node 没有 `npm_config_electron_mirror`）⇒ 走 GitHub 键必 miss。`ensure-electron` 显式读 npmrc 把镜像传下去，键才与 npm 安装时一致

（见 docs/toolchain.md:51）

## file-loc

**文件定位统一格式**：`<绝对路径>:<行>[:<列>]`；范围 `<路径>:<起行>[:<起列>]-<止行>[:<止列>]`，纯行可省列；备选（未来编辑器格式）`<路径>#<起行>[:<起列>]…`。凡引用文件内具体位置（日志某条、代码某行）一律用它，不写裸路径 + 自然语言「第几行」

## file-write

写文件按改动面选工具：新建 / 整文件重写用 `write`、局部改几行用 `edit`（批量 `edits[]` 一次改多处）；**改文件别用 `bash` heredoc / `sed -i`**（绕开路径护栏、diff 摘要与审计）；管道 / 程序化处理才用 `bash`

## fmt

格式真源 = 各包 `.oxfmtrc.json`（oxfmt **不读** `package.json` 的 `oxfmt` 块）；**fmt 未纳入 `check`**（##323(oxfmt 配置腐坏)）

## hang-detect

**先证「卡死」别再报「在推进」**：`top -l 2 -pid <pid> -stats pid,cpu,time,command`（macOS **第二行**才是瞬时 CPU，只看一行会误判）+ `lsof -nP -a -p <pid> -iTCP`（`-a` 必须，否则串到别的进程；看卡在哪条连接）+ 产出文件 mtime 是否还在前进。**CPU≈0 + 产出 mtime 不动 = 卡死**（进程活着 ≠ 在推进）。报状态先给这三个数，再下结论

## intent-tests-off

**UI 意图测试（`apps/diy-app/tests/cli.intent.*`）自 2026-11-06 起整体停跑**（用户裁，##518）。`apps/diy-app/sha.sh` 的 `test()` 只剩 `test-unit` + `test-os`；`test-intent` 保留为显式入口，默认只打印停用提示并 exit 0，要跑必须 `DIY_INTENT_ENABLE=1 ./sha.sh test-intent <文件片段>`。

停跑原因：每个断言一个 `./diy.sh` 子进程（实测 0.68s/次、每用例 1.9 次）+ 起真 Electron，单文件 80~140s、全量 1 小时以上；慢因是**执行通道**而非用例深度 —— 同一文件在 `DIY_CLI_MODE=http`（curl 到实例 `/cli`，~60ms）下实测 137.7s → 46.98s。

要写规则类用例：放 `tests/fast.*.test.ts`（纯函数级，不起 Electron、不需 build，毫秒级）。

## model-import

环境变量 → provider 导入候选（只列不写）→ `apps/diy-app/src/main/core/model-import.ts`

## npm-timeout

npm 默认 `fetch-timeout=300000`（5 分钟）、`fetch-retries=2`，网络半死时表现是**长时间静默**：先 `npm config get fetch-timeout` 核，按次用 `--fetch-timeout=<ms>` 收短；但**流式下载不一定吃这个超时**，判据仍靠上一条

## pkg

TS 用 npm workspaces（`package.json` + `package-lock.json`）；Python 遗留用 uv（仅归档区）

## pkg-action

`apps/diy-app/sha.sh lab|build|test|cli` 单包动作

## publish

npm 发布（`@diy-agent`）：根 `./sha.sh publish [--dry-run]`，认证 `NPM_PUBLISH_TOKEN`；仓内 `package.json` 恒指 `src/*.ts` 且留 `private:true`（护栏）

## py-script

**单文件 Python 工具脚本用 PEP 723 inline metadata** 声明依赖（文件头 `# /// script` 块），调用式就是 `uv run script.py`，不建 `.venv`。**不要**为脚本建 pyproject / 走项目模式

## scan-big-dirs

**搜之前先摸体量**：仓外目录（`~`、`$DIY_HOME`、`/tmp`、`build/`）先 `du -d 1 -h <dir> | sort -h | tail` 看清哪一层是 GB 级，再决定 `rg` / `fd` 显式排除哪些（`-g '!{.venv,build,node_modules,dist,_diy.worktrees,.cache}/**'`）。

判据：

- 仓内（有 `.gitignore`）先 `rg --files | wc -l` —— 上千正常、上万即已扫进大目录，别再猜
- **一次卡死 = 纪律没落实**，不是「机器慢」：`rg` 在 1 GB 的 `build/` 上会把整轮请求赔进去（bash 超时 300s 都不够），而 `du` 一秒出结果
- `build/lab/home` 这类数据根尤其危险：`electron_user_data/`、`log/network/` 都是万级小文件

## scan-scope

rg/fd 必须限定范围，禁 `rg … .` 全仓扫。排除：`-g '!*.jsonl'`（`.diy/local/*.jsonl` 单文件可达 181MB）、`-g '!**/{node_modules,.venv}/**'`、`-g '!**/{build,dist,lib,release}/**'`、`-g '!diy.worktrees/**'`。跨仓扫前先 `fd -t d -d 1` 看体量。

## sha

每个项目自带开发入口 `./sha.sh`（`./sha.sh --help` 看子命令）；公共函数库 `sha.common.sh`

## shell

文件操作优先 `fd` / `rg`，替代 `find` / `grep`

## skill-dir

共享 skills 真身在 `~/.agents/skills/`（`~/.hermes/skills/skills` 是它的 symlink，归档区 `~/.agents/skills.archive/` 同仓）；**自 2026-10-22 起是独立 git 仓**（首提交 `b961916`，279 文件 / 2.2 MB）—— 此前因磁盘满被手动删过 `.git`，单机仓只防误改、不防盘挂。**`~` 本身不是 git 仓**（`git -C ~ rev-parse` 直接失败），要判归属就判 `~/.agents`

## skill-rule

命名前缀完整规则见 `c-hermes` skill；摘要见下节

## sync

**新开 worktree 先 `./sha.sh sync`**（漏 `--include-workspace-root` 必现 build 解析失败）；末尾把 `~/.diy` 真配置投影进 `build/<variant>/home/`（`DIY_SYNC_HOME=0` 关）

## sync-gate

build/check/test/lab 入口先过 `ensure-sync`，命中即自动 `sync-deps`；`DIY_AUTO_SYNC=0` 关掉改报错，`./sha.sh sync-status` 只看状态

## test

`./sha.sh test` 全仓 · `test-unit` 不起 Electron · `apps/diy-app/sha.sh test-intent [片段…]`（位置参数过滤文件，带 `/` 或 `.test.ts` 原样传，无参全量）

## ui

真实 UI 验证走 CDP：`playwright-cli attach --cdp=…`

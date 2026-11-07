---
desc: 实例与进程（单例锁 / 自毁 / CDP / 外壳 / 异常出口）
updated: 2026-10-23
---

## app-root

**包根别数 `dirname`**：CLI 的源码 `src/cli/index.ts`（包根下 2 级）与产物 `build/<V>/cli/index.js`（4 级）深度不同 —— 固定 4 次只对产物成立，`DIY_CLI_MODE=tsx` 直跑时报「未构建: `<repo>`/pkgs.ts/build/…」（少了 `diy-app`）。判据 = 按 `package.json` 标记上溯（`core/app-root.ts`，有单测）

（见 ba99d638:pkgs.ts/diy-app/AGENTS.md:127）

## bash-kill-group

**取消 / 超时 / 输出溢出三种"我们主动杀"一律杀整个进程组**（`killProcessGroup`，`main/services/local-agent.ts`），前提是 `runBash` **自持 `spawn` + `detached:true`**：`execFile` 把选项**白名单**转发给 spawn、**`detached` 被静默丢掉**（node 24 `lib/child_process.js`），所以「execFile + detached + `kill(-pid)`」是**假修法**（实测 pgid 仍属父进程组、`kill(-pid)` 直接 ESRCH、子孙照跑满）。组杀只在子进程**未收尸**时发（`exitCode`/`signalCode` 已置位即跳过）—— pid 可复用，取消信号可能比命令活得久

（见 ba99d638:pkgs.ts/diy-app/AGENTS.md:105）

## cdp-goto

`playwright-cli attach` 模式下**不要用 `goto`**（CDP 附加态不支持 `Target.createTarget`，一次 goto 就打坏会话）；换页用 `reload`

（见 ba99d638:pkgs.ts/diy-app/AGENTS.md:122）

## cdp-hit

点击前做**命中自检** `document.elementFromPoint(中心) === 目标元素`（抓「按钮溢出被相邻元素盖住」的唯一手段）；断言读 DOM 不靠截图；`elementFromPoint` 只测坐标，**真实手势链**要 `mouse.move/down/up` 分步，且拖拽**必须给真实时间 + 至少一帧**（CDP 合成事件是瞬时的，dnd-kit 异步激活等不到）

（见 ba99d638:pkgs.ts/diy-app/AGENTS.md:123）

## cdp-port

`DevToolsActivePort` 文件内容**不一定是当前实例的端口**（输给单实例锁的第二个实例也会先写自己的端口再退出）→ 读后必须 `curl --max-time 3 http://127.0.0.1:<port>/json/version` 校验

（见 ba99d638:pkgs.ts/diy-app/AGENTS.md:121）

## ctx-two-lines

**上下文树页**（ctxlab）的请求预览是**真发形态**（走 `buildDelivery`）；**提示词页**（lab）是**模版线**（`assembleSystem`）。两者不是同一条链，改动别互推

（见 ba99d638:pkgs.ts/diy-app/AGENTS.md:136）

## env-pollution

跑意图测试 / CDP 夹具前 shell 里**不要 export `DIY_PORT` / `DIY_HOME`**（`ShellTest` 继承 `process.env` → 每条 `./diy.sh` 都去打别的端口、各拉一个新 app 互踢）。正确姿势 `env -u DIY_PORT -u DIY_HOME npx vitest run …`

（见 ba99d638:pkgs.ts/diy-app/AGENTS.md:125）

## err-triage

**已识别的外部不许标红**（当 bug 会让缺陷率失真、把用户训练成忽略红色）：HTTP 5xx / 请求超时**不进** `KNOWN_EXTERNAL`（上游有响应 = 网络通着，那是 ##369(模型不可用) 的服务端故障）；`InvariantError` 之外**拿不到码就如实判 unknown**，别为「看着严重」判 defect，也别给未知码编一个假 code 凑统计（`triageOf` 对未知码原样带回）。`invariant` 只表达**人为判据**，别拿它做用户输入校验（那是预期内的世界，属 external-*）。改 `LEGACY_THROW_BASELINE` 只能往下调；**别改成整文件豁免**（那会让该文件以后的新 throw 永远不被拦）。

（见 ba99d638:pkgs.ts/diy-app/AGENTS.md:114）

## excepthook

主进程**自注册 `uncaughtException` 处理器即抑制 Electron 的模态异常框**（其内置守卫是 `listenerCount > 1`），与有没有 try/catch 无关；诊断由 `installDiagnostics` 统一挂（三入口各落独立日志）

（见 ba99d638:pkgs.ts/diy-app/AGENTS.md:128）

## intent-build

**`tests/cli.intent.*` 跑的是 `build/test/` 编译产物**（起隔离 Electron，main/preload/renderer 全来自产物）：改 `src/**` 后不构建就跑 = 拿旧代码断言（症状：文案/diff 断言莫名失败，而同一份源码的单测全绿）。`sha.sh test-intent` 自动 `DIY_VARIANT=test build`；`tests/core|services` 是 vitest 直读源码，无需构建

（见 ba99d638:pkgs.ts/diy-app/AGENTS.md:126）

## llm-log

`$DIY_HOME/local/<uri 路径>/<key>/llm.jsonl`（##379 分层；旧平铺 `<key>.llm.jsonl` 读侧兜底）是**append-only 全量消息日志**（每行 1 条原生 ModelMessage + 索引位 `turn`/`step` + 工具结果的 `origin` 自证位），**行号 = 消息序号**（压缩注记的 `range` 就指它）。与压缩**解耦**：压缩只改投递期投影，绝不写它。加载时与 ops 投影对账（前缀则补齐 / 中部不一致则整份重建）

（见 ba99d638:pkgs.ts/diy-app/AGENTS.md:130）

## one-prompt-source

`_guard.md` 不得复述 `INTERRUPTED_TOOL_NOTICE`；该文案唯一来源是 `local-blocks.ts` 的常量

（见 ba99d638:pkgs.ts/diy-app/AGENTS.md:137）

## probe

轮次中勿改 `src/**` 当探针（watch 重启打断自己的轮次）；探针写 `/tmp`

## self-destruct

生产 diy（数据根 `~/.diy`，管任务管理）与 agent 同进程树，杀它 = 窗口白屏 + 无日志（SIGKILL 捕获不到）：**绝不可杀**。agent **自己**起的隔离实例（数据根在 worktree 的 `build/home` 等）可自行按**精确 pid** 收掉 —— `_guard.md` 已明许（运行时护栏 `agent-guard.ts` 已停用，判据分不清宿主与自己起的实例）；**只禁 `pkill/killall electron` 这类无差别指令**（会捎带生产实例）

（见 ba99d638:pkgs.ts/diy-app/AGENTS.md:120）

## shell-test

`ShellTest` 的输出边界 = stderr 的 PS1 marker + **stdout 的哨兵**：marker 只证明命令结束，stdout 是另一管道、到达顺序不保证，只等 marker 会读到半截输出并让后续每条命令错位

（见 ba99d638:pkgs.ts/diy-app/AGENTS.md:124）

## singleton-lock

隔离实例必须用**全新 `DIY_HOME`**（`mktemp -d`）：`SingletonLock` 写在 `electron_user_data/` 下，残留实例会抢锁 → 新实例打 `SingleInstanceLock: failed` 后直接退出。撞锁时换新 home，别动别人的进程

（见 ba99d638:pkgs.ts/diy-app/AGENTS.md:118）

## tool-result-error

tool-result 的**成败落在 `output.type`**（`error-text` = 失败），**不是**块上的 `status` —— `status` 是 diy 私有属性、模型看不见。投影（`projectAll`）与投递渲染（`renderMessage`）**两处都不许压回 `text`**：只改前者会被后者静默撤销（##329 的 b；理由见 `local-blocks.ts` 的 `ToolResultOutput` 头注）

（见 ba99d638:pkgs.ts/diy-app/AGENTS.md:131）

## watch-restart

改 `src/**` 会触发 lab watch 重启 Electron，**正在跑的本机 agent 轮次会被打断**（tool 被标 `interrupted`；这是「本轮未完成/流中断」的头号成因，实测 12/12 —— facts `dev.turn-interrupt#rate`）。三条对策：① 轮次中别拿源码当探针，探针写 `/tmp`；② **要持续对话的实例改用 preview**（`apps/diy-app/sha.sh preview` = 编译后运行、无 watch，改 src 波及不到它；lab 留给边改边看，见 `app.entry#variant`）；③ `interrupted.data` 今天为空，热重启与真流断仍无法区分（`dev.turn-interrupt#blind`）。

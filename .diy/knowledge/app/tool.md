---
desc: 验证与调试打法（UI 改动顺序 / 喊人 / 叫醒机制缺口）
updated: 2026-10-22
---

## cdp

取 CDP 地址：`cat "$DIY_HOME/electron_user_data/DevToolsActivePort"`（**读后校验**，见 `app.dev#cdp-port`）；`./sha.sh lab` 启动日志会打印完整 `attach` 命令

（见 ba99d638:pkgs.ts/diy-app/AGENTS.md:171）

## inspect

`./diy.sh ui inspect` 遍历 renderer DOM 生成无障碍树，快速看 UI 全貌

（见 ba99d638:pkgs.ts/diy-app/AGENTS.md:170）

## isolate

起隔离实例：全新 `DIY_HOME`（`mktemp -d`）+ `export HOME=$H`；演示数据落 `/tmp`，不写用户 `~/.diy`

（见 ba99d638:pkgs.ts/diy-app/AGENTS.md:174）

## log

应用日志 `$DIY_HOME/log/`：`main.log` / `cli.log` / `serve.log` / `dev.jsonl`（`grep watch-stall-suspect` 判 watcher 卡死）/ `agent-bash.jsonl`（agent 命令审计，write-ahead）

（见 ba99d638:pkgs.ts/diy-app/AGENTS.md:173）

## models-sync

models.dev 快照**两层、别看错层**：① **CI 层**（##107）`./sha.sh models-sync [源]` 重下 → 仓库 `src/main/data/models.dev.json`（上游产物整份覆盖，要重新构建才生效）；② **应用内层**（##385）`diy llmConfig syncModels`（RPC 同名）→ 写 `$DIY_HOME/data/models.dev.json` 并**写后 invalidate 进程内目录**（当场生效、无需重启）；启动后台自动跑一次，24h 定时**待 ##408 挂上**（别自己造第二套调度器）。演算全在 `src/main/core/models-sync.ts`：`refreshModelsOnce()` = 一次 tick 的干净边界，返回 `{ok,changed,providers,models,added*,removed*,error}`

（见 ba99d638:pkgs.ts/diy-app/AGENTS.md:179）

## persona

`diy agent persona list|set|setDefault`；模型/参数属**人物**，任务只持引用 id

（见 ba99d638:pkgs.ts/diy-app/AGENTS.md:177）

## smoke

`node scripts/ui-smoke/task-detail-smoke.mjs`（任务详情三块 + 拖宽落盘）· `python3 scripts/ui-smoke/dnd-smoke.py`（⚠️ 它的收尾用按名匹配的强杀，**会连正在用的 diy 一起收掉** —— 跑之前先改掉那段；且本机需 `pip install playwright`）

（见 ba99d638:pkgs.ts/diy-app/AGENTS.md:172）

## steer

`diy chat --mode next-step|next-turn` 入队插话；`steer` 组只做队列管理（list/cancel/toggleMode/reorder）

（见 ba99d638:pkgs.ts/diy-app/AGENTS.md:178）

## traffic

`diy traffic snapshot|clear|cleanLogs|query|logFiles|readLog|revealLog|setFullCapture|setCap|events`（worktree 里 `./diy.sh traffic …`；清单真源 `diy traffic --help`）；日志落 `$DIY_HOME/log/network/`（**等同 cache，可随时清理**）

（见 ba99d638:pkgs.ts/diy-app/AGENTS.md:175）

## ui-priority

**UI 类改动的打法：lab 优先、叫醒优先、CDP 末位**。顺序是 ① `./sha.sh lab` 起来自己点一遍（本 worktree 数据根，非生产）② 判据能写成纯函数的部分补单测（##329 R1 教训：UI 语义抽纯函数）③ 只有「真实事件链 / 手势」这类 handler 层测不出的，才上 Playwright/CDP，且**只跑 1~2 条**。**不要**为一行样式跑几十轮 CDP 逐像素猜 —— UI 的可观测性有硬上限（动画、时序、观感），越猜越慢。见 `dev#wake-user`（`~/AGENTS.md`）。

（见 ba99d638:pkgs.ts/diy-app/AGENTS.md:109）

## ui-verify

**两层互补**：`diy.ui.*`（handler 层，CLI 经 RPC 直调 renderer 共享函数，测行为/契约，稳定但**测不到真实 DOM 事件链的 bug**）vs **Playwright/CDP 真实事件层**（`mouse.move/down/up` 驱动真实 renderer，抓 gesture bug —— UI 交互改动后必跑）

（见 ba99d638:pkgs.ts/diy-app/AGENTS.md:169）

## verify

本包验证入口：`./sha.sh test`（全仓）· `npx vitest run tests/core/…`（单测）；`./sha.sh check` 的口径见仓根 `AGENTS.md::tool.check`

（见 ba99d638:pkgs.ts/diy-app/AGENTS.md:168）

## wake-gap

**agent 主动叫醒用户：机制尚未闭环（2026-10-21 核实）**。术语按 `~/AGENTS.md::level.notice`（N0 强干预 / N1 toast / N2 顶栏图标 / N3 极小点）。现有三级提示真源 `src/shared/session-alerts.ts` **全是旁观者推断**（跑完 / 停滞 / 异常 / 等回复），agent 没有「主动发起一条提示」的出口（`notice.*` RPC 只有模型不可用）⇒ N0 / N1 / N2 都发不出去。当前唯一可行喊法：**本轮最后一条消息写清三句话 + 结束本轮**（只触发「跑完了」）。要 N0 横幅 / N1 toast / N2 角标 + 跳会话，需另立项（含 `level#inbox` 的通知信箱），勿在任务里绕路造。

（见 ba99d638:pkgs.ts/diy-app/AGENTS.md:110）

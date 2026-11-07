---
desc: 本机 agent 轮次「未完成」的成因与可辨识度
updated: 2026-10-24
---

## blind

冷读补 `interrupted` 时，`data` 里两组标注都是**可选**：`code`/`triage`（##393 三档性质）与 `why`/`evidence`（##416 现场可命名的原因）。**缺 `why` 才是真盲** —— 退化成兜底句「本轮未完成（流中断/崩溃恢复）」（`turn-end.ts:60` / `chat-fold.ts:232`）；能命名时给具体说法「进程重启」/「进程崩溃」（`turn-end.ts:58-59`）。所以「热重启 / 流断 / 进程被杀同形、人和 agent 都无法归因」已被 ##416 消掉大半，只剩老记录仍不可辨

（见 apps/diy-app/src/main/services/local-blocks.ts:43）

## cause

lab/dev 下「本轮未完成」的**历史**头号成因是 dev 热重启：main bundle 一变就让旧实例退场，而轮次跑在 main 进程内存里。**##404 起不再直接 kill** —— POSIX 发 `SIGUSR2`，主进程 restart-gate 先等在跑的轮次跑完再自退（`electron-dev.mts::retireElectron`，宽限 20 分钟）；仍超时才 `SIGKILL` 并由本脚本亲手补一条 `electron-restart` 证据（##416）。win32 无 `SIGUSR2` ⇒ 退回 `SIGTERM`，仍会立刻中断

（见 apps/diy-app/scripts/electron-dev.mts:348）

## rate

实测 tasks/5 + tasks/7 共 37 个真发请求轮：HTTP 全 200；interrupted 12 起，12 起全部命中 electron-restart（末请求后 7.2~31.3s）；服务器侧成因 0 起，唯一 error 是流读 read ETIMEDOUT

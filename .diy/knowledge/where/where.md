---
desc: 总入口：什么信息去哪里查（问路，不答值）
updated: 2026-10-25
---

## agent

「谁在跑 / 跟别的 agent 说话 / 中止别人」→ `diy agent local running`（活体表）· `chat <taskUri> "<消息>"`（消息是**位置参数**，没有 `--message`；`-` 不读 stdin，多行用 `"$(cat 文件)"`）· 加 `--mode next-turn` 入队到对方下一轮开场、**不打断**它当前轮（对方没在跑则入队即开一轮）· `history <taskUri>` · `cancel <taskUri>`

## cmd

「这命令怎么用 / 有什么能力」→ `diy --help` 与 `diy <域> --help`（真源，别猜）；提示词骨架 `diy template`。

## code

「这功能在哪 / 怎么实现」→ `diy facts brief find`（各包定位）+ `rg`/`fd`（排 `.venv` `node_modules` `dist`）；扫前先 `du -d 1 -h` 看体量。

## config

「X 怎么配」三处：模型/价格 `diy llmConfig read`（`$DIY_HOME/model.yaml` + `providers.custom.yaml`）· 人物 `personas.yaml` · 上下文组装 `context.yaml`。代码内缺省值走 `where#code`。

## doc

「设计稿 / 方案 / 计划」→ `diy docs index`（`docs/` 不在 AGENTS.md 链上）。信封的 `docs` 单元只给摘要，且**按项目路径求仓库根** —— 项目不在仓库内则整节缺席（lab 的 sample-project 就是这样，别以为 docs 单元坏了）；任务自己的产出在 `$DIY_HOME/<taskUri>/gen/`。

## fact

「X 现在是什么 / 有没有约定」→ `diy facts find <词>`（多词=与）→ `brief <主题>` → `get <主题>#<面>`；已知主题见 `runtime.kb`。**先查库，再 rg**。

## history

「当时为什么这么定 / 做过什么」→ `diy journal find <taskUri>`（append-only 事件流）。

## job

「那条后台长活跑完了吗 / 停了没」→ `diy job ps` · `tail <runId>` · `job kill <runId>`（只管 background；前台命令不登记）

## locate-first

问题里的名词不认识 / 「X 在哪」→ 先看本库 full 暴露的 `where#*`（信息地图）**定类**，再用 `diy facts find <词>` 确认它指什么；不许先 rg 猜词乱翻。

## rule

只写「去哪查」，不写值；一行一条通道（通道才变，故不腐坏）。判据：再过一轮，这行还成立吗？

## runtime

运行时值（端口 / 数据根 / 环境）：本信封 `system.*` · `runtime.*` · `runtimeDiff.*`；值不进库，别去 rg。

## task

「谁在做什么 / 任务树 / 某任务目标」→ `diy task list` · `diy task show <uri>`；body 只留结论，过程走 `where#history`。

## traffic

真发出去的请求（含消息体）：`runtime.reqlog.file`（按天 jsonl）；UI 流量页 / 「该步实际请求」。

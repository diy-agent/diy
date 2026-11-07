---
desc: 出站流量观测（覆盖范围 / 步归属 / 落盘与清理）
updated: 2026-10-22
---

## traffic-chunk

undici 事件的 `chunk` 是**底层复用/回收的字节** → 落盘前必须 `Buffer.from(chunk)` 复制；归属靠请求头 `x-opencode-session`（`local-agent.ts` 每处真发都带，按 task 稳定），**新增 LLM 发送入口若漏带该头，流量页就认不出任务归属**（退化成按 origin 兜底、或记为「其它」）

（见 ba99d638:pkgs.ts/diy-app/AGENTS.md:164）

## traffic-clean

清理（##324）**单位是整个按天文件**，且**今天正在写入的那个一律不删**（Writer 持着 fd，unlink 后后续记录写进已删 inode）；删除**不可恢复**（不进回收站）→ 界面必须走 `ConfirmDialog` 二次确认

（见 ba99d638:pkgs.ts/diy-app/AGENTS.md:176）

## traffic-scope

流量观测**只覆盖 undici**（Electron 主进程 / serve 的 `fetch` 与 ai-sdk 发出的请求）：renderer 是 Chromium 栈（要看需 CDP）、`net.fetch` / 子进程 / native binding **看不到** —— 「某条请求怎么没记下」先问它走的是不是这条路。订阅必须早于任何请求（`traffic.init()` 在 `src/main/index.ts` 与 `src/serve/index.ts`，另有 `noteRun` 惰性兜底）

（见 ba99d638:pkgs.ts/diy-app/AGENTS.md:162）

## traffic-step

流量记录的**步归属**（`stepSeq` / `attemptInStep`，##409）由 `traffic.noteStep` 在 `prepareStep` 里**每步登记一次**（该步请求之前）→ 该步内 SDK 的重试自然收成一条重试链；探测 / 摘要 / 老记录没有步号（null）。**别把老字段 `attempt` 当步序或重试序号**——它是本 run 内的往返序号（跨步累计）。新增 LLM 发送入口若不经过 prepareStep，记录里就没有步号

（见 ba99d638:pkgs.ts/diy-app/AGENTS.md:163）

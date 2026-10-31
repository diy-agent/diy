# `src/main/os` —— OS 层开发规范（R1–R12）

> 用户 2026-10-31 裁定（任务 ##4264）。这份文件是**规范**，不是设计笔记；`scripts/check-os-boundary.mjs`
> 做机检。改 os 层之前先读完 R1–R12。

## 三层（本仓唯一分层法）

```
L1 业务：local-agent / run-registry / process-scan / instances / agent-guard
        · 只调 L2 意图级 API；不出现任何平台名、不出现任何系统命令
L2 功能：os/<platform>.ts 里实现的同一组意图接口
        · 动作归一；做不到的降级要可见（facts / 工具缺席），不许假装
L3 原子：ps / wmic / Get-CimInstance / taskkill / kill(-pgid) / osascript…
        · 只出现在 os/*.ts 实现文件里，函数级封装，可注入 deps
```

## 规范条款

| 号 | 条款 | 判据 / 反例 |
|---|---|---|
| R1 | **平台分支只许在 `os/index.ts` 选型**；实现文件内部按 OS 细分（macOS 的 top 第二块 / osascript）**合法**，因为它是 `deps` 注入的实现细节 | 反例：共享函数里 `if (process.platform === "win32")`；README 写成「唯一允许看 platform 的文件」会误伤 `deps.platform` —— 必须区分「选型」与「实现细分」 |
| R2 | **L2 进程意图只有 4 个**：`ownProcesses(query)` / `killOwned()` / `jobAlive(pid)` / `facts()`；观测类 `snapshot()` / `snapshotSync()` / `hopSync()` / `probe(pid)` 独立成组；`query` 是**调用方状态注入**，不是选项（不许加模式/覆盖度/预算） | 反例：`getProcessEnvironment` / `killProcessGroup` —— 机制语言；把 `probe` 当成「砍掉连接观测」的理由 |
| R3 | **不承诺做不到的保证**：`killOwned(): void`，不返回 coverage / 概率 / budget；UI 与工具回执统一说「已发出结束请求」 | 反例：`{ coverage: 'complete' \| 'best-effort' }`、`budgetMs` 参数 —— 没人能拿它做决策 |
| R4 | **caps 只用于真能力/事实**（GPU、能否读别人环境变量、有没有 bash），**不用于实现差异**；且 **cap 必须与数据形状一致** | 反例：`ProcessRow.pgid: number` + Windows 填 `pid` 冒充，`caps.processGroups === false` 成摆设。正确：`pgid: number \| null` |
| R5 | **有类似动作但保证不等价的不许折叠成 bool**（「杀进程组」vs「杀进程树」），要么降级事实要么不出现在 L1 | 见 R4 反例 |
| R6 | **shell 是能力**：`ShellSpec.kind: 'bash' \| 'pwsh'`；两种能力语法边界不同，工具面**不同名**。Windows 上 pwsh 是**必须可达的基线**，Git Bash 是可选加分；工具面**并存**；执行器 = 模型实际调用的那个工具，`shellSpecs()[0]` 只用于内部自起命令的兜底 | 反例：「找不到 bash.exe」只给一句「去装 Git for Windows」 |
| R7 | **降级可见**：没有 bash → **不注册 `bash` 工具**，另注册 `pwsh` 工具（自己的描述写清语法边界）；Windows 有 Git Bash 时 bash 作为可选第二能力并存 | 反例：把 pwsh 塞进 `bash` 工具的执行器 —— 模型继续写 bash 语法，拿到一堆无名报错，比「没有工具」更糟 |
| R8 | **pwsh 调用契约**：`pwsh -NoProfile -NonInteractive -Command`，输出前置 `[Console]::OutputEncoding=[Text.Encoding]::UTF8;$OutputEncoding=...`；**退出码必须透传**（`& { <cmd> }; exit $LASTEXITCODE`）；多行命令用 `-EncodedCommand`（UTF-16LE base64）；优先 pwsh 7，5.1 无 `&&` / `??` 要在工具描述里明说 | 反例：不透传 → `[退出码 N]` 全是假值；直接拼多行字符串 → 引号地狱 |
| R9 | **成本靠常量与窄查询，不设预算参数**：同步取数超时用一个常量（2s）+ 2s 快照缓存，超时返回 `null`。**需要 ≥2 个进程的信息一律一次全量 + 缓存**（祖先链 4 跳也走快照）；只有「一次调用只要一个 pid 且频率极低」才单 pid 查询；PowerShell 任意查询 3.3s 起，永远不进热路径 | 实测：wmic 全量 ~0.5s、wmic 单 pid ~0.5s、tasklist ~0.18s、**PowerShell 任意查询 3.3–3.9s（冷启动主导）**。注：`instances` 需要 PPID + CommandLine，`tasklist` 两者都没有（只有 Image Name/PID/Mem），故仍走 wmic 全量（~0.5s）这条路 —— 见任务 ##4264 回执里的偏差说明 |
| R10 | **动作归一，事实不归一**：`facts(): string[]` 给人看的句子（如「Windows：后台作业寿命跟根进程，根退子活可能先报完成」）；排障不许回到读平台代码 | 反例：只给 `boolean`，UI 说「已结束」而其实还在跑 |
| R11 | **机检进 `sha.sh check`**：`scripts/check-os-boundary.mjs`，令牌 = `process.platform` / `wmic` / `tasklist` / `taskkill` / `powershell` / `pwsh` / `Get-CimInstance` / `osascript` / `system_profiler` / `/bin/bash` / `bash.exe` / `darwin` / `win32`；白名单只有 `pkgs.ts/diy-app/src/main/os/**`；**整行注释放行** | 反例：规则只活在 README 里 —— 三个月必破 |
| R12 | **测试分层**：OS 无关判据（认领、寿命、树聚合）留 `tests/core/**`；平台实现（解析器、命令拼装、探测降级）放 `tests/os/**`；实现**必须注入 deps**，不许真跑系统命令 | 反例：单测真起 PowerShell（3.3s/次，CI 直接爆） |

**名册与锚点身份（P1 补充）**：`live = 登记过的号 ∩ 本轮快照 ∪ 仍有后代被认领的锚点`
（不是全机 pid，否则老组永不退休；也不能只留根还在的组，否则根退后孤儿失联）。

lineage 的锚点判据是**身份**不是年龄：
- 锚点不在快照里 ⇒ 号没被复用 ⇒ 有效（继续给孤儿当依据，不按年龄退休）；
- 锚点在快照里 ⇒ 其 `createdAt` 与登记时刻（`GroupOwner.createdAt ?? at`）偏差 >5s ⇒ 已被复用 ⇒ 立刻退休；
- 拿不到创建时刻 ⇒ 才用 **7 天保险丝**兜底（常量只是保险丝，不是主判据）。

## 文件

| 文件 | 职责 |
|---|---|
| `types.ts` | `OsStrategy` 契约 + 归一化数据（`ProcessRow` / `ShellSpec` / `OwnQuery` …） |
| `posix.ts` | Linux / macOS：ps / top / lsof / osascript / system_profiler（L3 解析器也在这里，导出给单测） |
| `win32.ts` | Windows：wmic（~0.5s）优先 → CIM 回退；`taskkill /T /F`；Git Bash / pwsh 探测 |
| `index.ts` | **唯一按平台选型**的地方；`DIY_OS_STRATEGY` 只作 CI/排障覆盖（非法值 warn + 回落） |
| `duration.ts` / `tree.ts` | 两平台共用的纯工具（时长格式、进程树聚合） |
| `shell.ts` | shell 能力缓存 + `buildInvocation()`（bash / pwsh 的命令拼装，R8） |
| `shell-hint.ts` | 两种 shell 都没有时的事实句 |

## 加一个 OS 能力的流程

1. 先问：这是**意图**（L2）还是**机制**（L3）？机制不出现在 `OsStrategy` 上。
2. 在 `types.ts` 加意图/观测字段；做不到的用 `caps` 明说，并在 `facts()` 里给一句人话。
3. `posix.ts` / `win32.ts` 各实现一次（注入 deps 便于单测）。
4. 测试：平台解析/拼装放 `tests/os/**`；OS 无关判据留 `tests/core/**`。

## 测试集合

- `./sha.sh test-unit` → `tests/**` **排除** `tests/os/**`（OS 无关集合）。
- `./sha.sh test-os` → `tests/os/**`（OS 相关集合；命令执行注入，任意平台都能跑）。
- `./sha.sh test` → 两者 + 意图测试。
- 机检：`node scripts/check-os-boundary.mjs`（已在 `./sha.sh check` 里）。

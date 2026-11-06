# @diy-agent/jobs

**后台任务的账**（##515 第 3 步从 `apps/diy-app` 抽出）。与 `@diy-agent/tools` 的分工一句话：

> tools 管「一条命令怎么跑」（前台执行 / 超时 / 杀组 / 结果头），jobs 管「后台任务的账」
> （还有哪些在跑 / 是死是活 / 说了什么 / 停掉它 / 等它）。

## 有什么

| 文件 | 是什么 |
|---|---|
| `run-registry.ts` | run 表：`spawn` / `adopt` / `list` / `get` / `tail` / `kill` / `wait` / `shutdown` / `pruneOldDirs`。输出直落 `$DIY_HOME/log/job/runs/<日期>/<id>/out.log`，`meta.json` 自述 |
| `run-status.ts` | 纯函数判据：四态 / 结局（`RunOutcome`）/ 时长 / tail 截断 / 结束通知文案（零 IO） |
| `job-tool.ts` | `job` 工具面：list / status / output / kill / wait（用户可见文案在这） |

## 宿主必须注入的三样（**不注入就没有这些能力**）

```ts
import { RunRegistry, makeJobTool, defaultJobCaps } from "@diy-agent/jobs";

const registry = new RunRegistry({
    rootDir: join(home, "log", "job", "runs"), // 数据根由宿主配置
    caps: defaultJobCaps,                      // 或宿主自己 os 策略的 5 个能力位
    shells: () => detectShells(),              // shell 探测是 OS 策略
    notifier: (event) => wake(event),          // 不传 = silent（见下）
});

const job = makeJobTool({
    registry,
    visible: (r) => r.origin?.taskUri === taskUri, // 越权边界；不传 = 全都可见
    scopeLabel: "本任务",                          // bot 可传"本 bot"
});
```

### `notifier` 不传 = **silent**（显式语义，不是悄悄 no-op）

- `registry.notifyMode === "silent"`：run 照常收口、账照常落盘，**不通知任何人**；
  收口后 `info.notified` 保持 `undefined`（"没人被通知"是可断言的事实）。
- `registry.notifyMode === "callback"`：每条收口的 run（**不是我们主动杀的**、且有 `origin.taskUri`）
  投一次 `JobDoneEvent { taskUri, text, notify, run }`；`notified` 置 `true` 保证只投一次。
- 没有 `origin.taskUri` 的 run 一律不通知 —— 不知道该叫醒谁。

## 为什么长任务**必须**走 job，不能裸 `&`

实测（2026-11-05）：agent 用 `nohup env FOO=bar node -e '...' > /dev/null 2>&1 &` 起一个
10 分钟的后台进程，**几秒后就没了**。

原因不是 `nohup` 不灵，是**执行层收进程组**：bash 工具的命令挂在工具自己的进程组下，
命令"结束"（外壳退出）时它要把整组收干净，否则挂死的子孙进程会把工具调用卡住
（`runBash` 的收尾就是 SIGKILL 整组）。`nohup` 只屏蔽 SIGHUP，挡不住 SIGKILL。

**所以**：

```bash
# ❌ 表面"后台"、实际活不过这一轮
nohup ./long-task > /tmp/x.log 2>&1 &

# ✅ 进账本：我们自己的子进程 + 自己的 pid + 自己的 out.log
#    （bash 工具传 background: true，或 diy job 系列的 CLI）
```

差别不只是"能不能活"：
- 裸 `&`：谁起的、还活着没、说了什么、怎么停 —— **全都没有**
- job：`list` / `status` / `output` / `kill` / `wait` 都有，收口还会通知

反过来说，**前台命令不该登记**（用户 2026-10-24 口径）：`bash` 不加 `background`
就不进来 —— 不然每条 `ls` 都往账本里塞一行。

## 刻意不做的（别在文档里说成已实现）

- **不恢复**：真源是内存 Map，app 退出即空（重启不 reconcile、不接管）；
- **不记账**：落盘的只有该 run 自己的 `meta.json` + `out.log`（运行产物，整目录可删）；
- **不认 pid 之外的"进程内任务"**：`pid` 可选是为将来留形状，目前没有代码造出无 pid 的 run；
- **不做前台**：前台命令零登记（用户 2026-10-24 口径），`bash` 不加 `background` 就不进来。

## 测试

`./sha.sh test`（真起 `bash`，不 mock 子进程）：抽包语义 12 条 + 工具面 9 条。
diy-app 原有的 4 个 run-* 测试文件仍从 `src/main/services/run-registry` / `src/shared/run-status`
导入（那两个文件现在是转发），一共 85 条继续兜底。

// @diy-agent/tools/src/shell/tool.ts — `bash` / `pwsh` **工具定义**（宿主无关的那一半）
//
// 从 apps/diy-app/src/main/services/local-agent.ts 的 `makeShellTool` 搬来（##515 第 1 步）。
// **工具描述（用户可见文案）逐字照搬** —— 那些是用户踩坑总结出来的（超时 / 转后台 / stdin / 平台语法），
// 不许在搬包时缩写。宿主没提供的能力（如 job 账本）对应那一句才许去掉。
//
// 与宿主的切面只有 `ShellToolHost` 这几个回调：
//   audit（审计写哪）· onSpawn / onControl / onEnd（进程与转后台登记）·
//   toModelOutput（投递层截断）· background（job 账本，不传 = 本宿主不开放 background）·
//   effectiveArgs（与聊天里显示的「工具实际收到」共用同一份）
// 工具语义（前台执行 / 抛错判据 / 结果头）全在这里，宿主改不了。

import { tool } from "ai";
import { z } from "zod";
import { renderFieldDocs } from "@diy-agent/context/schema/schema-doc";
import { BASH_RESULT_HEAD_SCHEMA } from "./result.js";
import { runBash, type BashControl, type ShellLimits, type ShellRuntime } from "./run.js";
import type { ShellSpec } from "./spec.js";

/** 一次 shell 工具的审计事件（宿主决定写去哪、补什么身份：taskUri / 会话目录） */
export interface ShellAuditEvent {
    readonly phase: "bash-start" | "bash-end";
    readonly cwd: string;
    readonly command: string;
    /** 结果摘要（bash-end 用；已截断） */
    readonly result?: string;
    /** 耗时 ms（bash-end 用） */
    readonly ms?: number;
}

/** 一次工具调用的身份（宿主登记 / 摘登记时对号用） */
export interface ShellCallInfo {
    readonly command: string;
    /** SDK 给的 toolCallId（没有它就没法把 UI 按钮和调用对上） */
    readonly toolCallId?: string;
}

/** 「生效参数」：缺省值补完之后的实参（与聊天里显示的那份必须同源） */
export interface ShellEffectiveArgs {
    readonly command: string;
    readonly timeout: number;
    readonly background: boolean;
}

/**
 * 宿主切面。**全部可选** —— 一个都没有也能跑（纯前台执行 + 包内兜底），
 * diy-app 把审计 / job 账本 / 进程名册 / 投递截断都接在这上面。
 */
export interface ShellToolHost {
    /** 工作目录（相对路径的解析基准，也是命令的 cwd） */
    readonly cwd: string;
    /** 执行预算（只认 bashTimeoutMs） */
    readonly limits: ShellLimits;
    /** 平台能力（detached / 杀整组）；不传 = 包内兜底 */
    readonly runtime?: ShellRuntime;
    /** 执行审计（write-ahead：bash-start 先落盘再执行，保证最后一幕不丢） */
    readonly audit?: (event: ShellAuditEvent) => void;
    /**
     * 「生效参数」补缺省。diy-app 传 `shared/tool-args::effectiveBashArgs`——
     * 聊天里显示「工具实际收到」用的是**同一份**，两处各补一次必然漂成"界面说前台、实际跑后台"。
     */
    readonly effectiveArgs?: (raw: {
        command: string;
        timeout?: number;
        background?: boolean;
    }) => ShellEffectiveArgs;
    /** 子进程起来了（宿主登记进程组归属 / 面板 pid） */
    readonly onSpawn?: (pid: number, call: ShellCallInfo) => void;
    /** 前台调用的「转后台」句柄（宿主登记到自己的表；不登记 = UI 没有按钮） */
    readonly onControl?: (ctl: BashControl, call: ShellCallInfo) => void;
    /** 前台执行结束（正常 / 异常都调；宿主摘登记、释放进程组名册） */
    readonly onEnd?: (info: ShellCallInfo & { pid?: number }) => void;
    /** 投递层截断（##127）：不传 = 原样 */
    readonly toModelOutput?: (text: string, toolCallId: string) => string;
    /**
     * 后台模式（##408 刀 8）：**不传 = 本宿主没有 job 账本 ⇒ 不开放 `background`**
     * （参数与描述里那一句一起消失，免得告诉模型一个必然失败的选择）。
     */
    readonly background?: (input: { command: string; timeoutMs: number; toolCallId?: string }) => Promise<string>;
}

/** 审计里的结果摘要上限（与宿主 appendAudit 的口径一致） */
function clip(s: string, n = 500): string {
    return s.length <= n ? s : `${s.slice(0, n)}\n…（已截断 ${s.length - n} 字符）`;
}

/**
 * 包内缺省「生效参数」（宿主不传 effectiveArgs 时用）。
 *
 * 口径与 diy-app 的 `shared/tool-args::effectiveBashArgs` 一致（##454）：
 * `timeout` 省略 / 0 = 不设超时；负数 / 小数夹到 0 / 向下取整；非数字当没给；`background` 只认严格 true。
 * ⚠️ 宿主要有自己的「同一份」实现（聊天显示要用）就传 `effectiveArgs` —— 别让两处各补一次。
 */
function defaultEffectiveArgs(raw: {
    command: string;
    timeout?: number;
    background?: boolean;
}): ShellEffectiveArgs {
    const t = typeof raw.timeout === "number" && Number.isFinite(raw.timeout) ? Math.max(0, Math.floor(raw.timeout)) : 0;
    return { command: raw.command, timeout: t, background: raw.background === true };
}

/**
 * 造一个 shell 工具（`bash` 或 `pwsh`，由 `spec.kind` 定）。
 *
 * 一个 spec = 一个工具：Windows 上 bash（Git Bash）与 pwsh 可能并存，两个都装、各自一套文案。
 */
export function makeShellTool(spec: ShellSpec, host: ShellToolHost) {
    const isBash = spec.kind === "bash";
    const cwd = host.cwd;
    const supportsBackground = host.background !== undefined;
    return tool({
        description: (isBash
            ? [
                  "在项目目录执行 bash 命令并返回输出（查文件、跑命令、看系统信息）。",
                  "**缺省不设超时**（命令跑多久工具就等多久）；要限时就显式给 `timeout`（毫秒，到点整组 SIGKILL，并照样返回已收到的输出）。超时 / 取消 / 输出溢出都会杀掉整个进程组，且**照样返回结果**（不抛错）—— 看头里 timed_out / killed 判断怎么结束的。",
                  "命令退出后若有子孙进程还握着输出管道，最多再等 200ms 就返回（拿到已收到的输出），不会因为 `nohup … &` 这类后台孙进程挂死。",
                  ...(supportsBackground
                      ? [
                            "`background: true` 把长任务转到后台并**立即返回**作业 id —— 结束时会插话通知你，**不要轮询**（sleep 再查属于轮询），期间可以放心结束本轮去做别的事。查状态 / 取输出 / 停止用 `job` 工具。",
                        ]
                      : []),
                  "长任务写法：`nohup <命令> > /tmp/x.log 2>&1 < /dev/null & disown` 立刻返回，然后用**另一条**命令 `tail /tmp/x.log` 取增量；不要在同一条命令里 sleep 等它跑完。",
                  "stdin 已接 /dev/null：`cat`、无参 `grep` / `rg` 立刻拿到 EOF，不会挂住等输入。相对路径一律按 cwd（项目目录）解析。",
                  "结果 = YAML 头 + 正文原文（正文逐字不动）。头的字段：",
                  ...renderFieldDocs(BASH_RESULT_HEAD_SCHEMA),
              ]
            : [
                  "在项目目录执行 **PowerShell** 命令并返回输出（查文件、跑命令、看系统信息）。", // os-boundary-ok: 用户可见文案
                  // os-boundary-ok: 用户可见文案（语法边界）
                  "语法是 PowerShell，不是 bash：没有 `ls -la` / `grep` / `&&` 这套；文件用 `Get-ChildItem` / `Select-String` / `Get-Content`。Windows PowerShell 5.1 不支持 `&&` / `??`，需要串行就写两条命令或用 `;`。",
                  "**缺省不设超时**；要限时就显式给 `timeout`（毫秒，到点杀整棵进程树，并照样返回已收到的输出）。超时 / 取消 / 输出溢出都会杀掉整棵树，且**照样返回结果**（不抛错）。",
                  ...(supportsBackground
                      ? [
                            "`background: true` 把长任务转到后台并**立即返回**作业 id —— 结束时会插话通知你，**不要轮询**；查状态 / 取输出 / 停止用 `job` 工具。长任务用 `Start-Process` 或 `background: true`，不要在同一条命令里 `Start-Sleep` 等它。",
                        ]
                      : [
                            "长任务用 `Start-Process` 起，不要在同一条命令里 `Start-Sleep` 等它。",
                        ]),
                  "相对路径按 cwd（项目目录）解析；结果 = YAML 头 + 正文原文（正文逐字不动）。头的字段：",
                  ...renderFieldDocs(BASH_RESULT_HEAD_SCHEMA),
              ]
        ).join("\n"),
        inputSchema: z.object({
            command: z.string().describe(isBash ? "要执行的 bash 命令" : "要执行的 PowerShell 命令"), // os-boundary-ok: 用户可见文案
            timeout: z
                .number()
                .optional()
                .describe("本次执行的超时（毫秒）；0 = 不设超时；省略 = 不设超时（##454：默认不超时，显式设置就尊重）"),
            ...(supportsBackground
                ? {
                      background: z
                          .boolean()
                          .optional()
                          .describe(
                              "后台执行：立即返回作业 id，输出落日志文件；结束时会插话通知你。不需要在命令末尾加 &。" +
                                  "查状态/输出/停止用 job 工具。**后台同样缺省不设超时**；" +
                                  "要限时就显式给 timeout，到点整组停止。",
                          ),
                  }
                : {}),
        }),
        // ##127：单条工具输出的截断**只落投递层** —— `toModelOutput` 改写「发给模型的那一份」
        // （超 2000 行 / 50KB 时头尾 + marker + 原文落盘可 read 回取），`execute` 的返回值
        // 仍是全文（落进 ops 的原文永不动）。截断实现归宿主（见 services/tool-output.ts）。
        toModelOutput: ({ toolCallId, output }) => {
            const text = String(output);
            return { type: "text" as const, value: host.toModelOutput ? host.toModelOutput(text, toolCallId) : text };
        },
        execute: async ({ command, timeout, background }, opts) => {
            const execOpts = opts as { abortSignal?: AbortSignal; toolCallId?: string } | undefined;
            const call: ShellCallInfo = {
                command,
                ...(execOpts?.toolCallId ? { toolCallId: execOpts.toolCallId } : {}),
            };
            const t0 = Date.now();
            // 自杀护栏（agent-guard.ts）已停用（2026-10-02）：
            // 判据是命令文本，无法区分「宿主进程」与「agent 自己起的实例」——
            // 实测两类误拦（同 pgid、命令行含 main/index.mjs）把本仓库任意
            // worktree/测试实例都算宿主家人，连 agent 收自己起的实例都被拒。
            // 恢复方式：还原调用方那处 + import（模块与单测均保留，见 agent-guard.ts）。
            // 现仅保留 write-ahead 审计：先落盘再执行，保证最后一幕不丢
            host.audit?.({ phase: "bash-start", cwd, command });
            // **生效参数**：缺省值只在这里补一次（宿主传 effectiveArgs 时与聊天显示同源）。
            const eff = (host.effectiveArgs ?? defaultEffectiveArgs)({
                command,
                ...(typeof timeout === "number" ? { timeout } : {}),
                ...(typeof background === "boolean" ? { background } : {}),
            });
            // ── 后台模式（##408 刀 8）──
            // 与前台共用**同一个** bash 工具和同一套入参，只由 `background` 一位分叉：
            //   · 前台 = 阻塞到结束（缺省不设超时，显式 timeout 才限时）——「现在就要结果」
            //   · 后台 = 立即返回 id + 日志路径，结束时插话唤醒——「等得起，先干别的」
            // 这也是 opencode `shell` 工具的形状（`background` + `timeout` 两位），
            // 两边的口径一致，模型不必学两套。
            // ⚠️ 后台那一路**整段归宿主**（run 账本 / 审计 / 通知都在宿主），本层只转交一次。
            if (eff.background) {
                if (!host.background) {
                    throw new Error("[后台不可用] 本宿主没有作业账本（background 仅 diy-app 开放）");
                }
                return host.background({
                    command,
                    timeoutMs: eff.timeout,
                    ...(call.toolCallId ? { toolCallId: call.toolCallId } : {}),
                });
            }
            // ── 前台命令**不登记**（##408 刀 16，用户 2026-10-24 定口径）──
            // 「前台进程不进观察名单，不属于 job，就是当前 llm 自己的事，不管、不列出、
            // 不记录。job 现阶段只管后台任务。」
            // 于是：不建 run 行、不落 out.log、不写 meta、不投通知 —— 结果直接回给工具调用方。
            // 唯一保留的是**组号归属**（宿主的 onSpawn）：它不是 job，是"进程总管"认领孤儿的
            // 依据（命令里自己 `nohup xxx &` 的进程，ppid 会变成 launchd，只有组号还记得是谁起的）。
            let fgPid: number | undefined;
            let run: Awaited<ReturnType<typeof runBash>>;
            try {
                run = await runBash(
                    command,
                    cwd,
                    host.limits,
                    execOpts?.abortSignal,
                    {
                        onSpawn: (pid) => {
                            fgPid = pid;
                            host.onSpawn?.(pid, call);
                        },
                        ...(host.onControl
                            ? { onControl: (ctl: BashControl) => host.onControl?.(ctl, call) }
                            : {}),
                    },
                    eff.timeout,
                    spec,
                    ...(host.runtime ? [host.runtime] : []),
                );
            } finally {
                // 正常结束（含异常）就把登记摘掉：结束的进程没有「转」这回事，
                // 留在表里只会让 UI 显示一个按了必失败的按钮。
                // 转成功的条目已由宿主的 `detach` 摘除，这里是无操作。
                host.onEnd?.({ ...(fgPid !== undefined ? { pid: fgPid } : {}), ...call });
            }
            host.audit?.({
                phase: "bash-end",
                cwd,
                command,
                ms: Date.now() - t0,
                result: clip(run.text, 500),
            });
            // **抛，不 return**（##353，与 read 的 ##329 同口径）：catch-and-return 的字符串是
            // **正常工具结果** → SDK 走 tool-result 分支 → patch status:"done" → UI 画 ✓（就是
            // 「✓ + Command failed」那种自相矛盾）；抛出 → SDK 发 tool-error → status:"error"
            // → ✗ 且恒展开。失败文案随 error.message 落进 ops —— 模型侧照旧看得到（它要靠
            // 退出码/诊断改命令）。判据（① 非零退出 + 有错误输出 · ③ spawn/IO 失败）全在 runBash 头注。
            if (run.failed) throw new Error(run.text);
            return run.text;
        },
    });
}

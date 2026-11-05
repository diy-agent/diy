// @diy-agent/jobs/src/job-tool.ts — `job` 工具的**定义与执行**（宿主无关的那一半）
//
// 从 `apps/diy-app/src/main/services/local-agent.ts` 抽出（##515 第 3 步）：
// 描述文案与 action 语义**逐字照搬**，只把两处宿主耦合换成入参：
//   · 「本任务的 run」→ `visible(info)`（diy-app 传 `origin.taskUri === 当前任务`；bot 传全部）
//   · 「本任务」这个**主语**→ `scopeLabel`（文案里出现的地方用它，别在包里写死"任务"）
//
// 判据真源在 `run-status.ts`（纯函数：四态 / 结局 / 时长 / 表格行）；这里只做 IO 编排。

import { tool } from "ai";
import { z } from "zod";
import type { RunInfo, RunRegistry } from "./run-registry.js";
import { exitText, formatDuration, runLine, stateLabel, type TailResult } from "./run-status.js";

/**
 * `job wait` 的上限（10 分钟）。`timeoutMs = 0` 曾经表示「一直等」，等于给模型一把
 * 自锁的钥匙（永不退出的 daemon + 等待 = 这一轮再也回不去，而唤醒是「结束才叫」）。
 */
export const WAIT_MAX_MS = 600_000;

const EMPTY_TAIL: TailResult = { text: "", lines: 0, droppedBytes: 0 };

/** 一条 run 的**详情文案**（job status / wait 共用）：状态 + 结局 + 来源 + 输出尾巴。 */
export function runDetail(info: RunInfo, tail: TailResult, now: number): string {
    const rows = [
        `${info.id} · ${stateLabel(info.state)} · ${formatDuration((info.endedAt ?? now) - info.startedAt)}`,
        `命令：${info.command}`,
        `目录：${info.cwd}`,
        `结局：${exitText(info.state, info.exitCode, info.signal)}${info.error ? `（${info.error}）` : ""}`,
        `输出：${info.logPath}`,
        ...(info.origin ? [`来源：${info.origin.taskUri}${info.origin.turnId ? ` / ${info.origin.turnId}` : ""}`] : []),
    ];
    if (tail.lines === 0) rows.push("（无输出）");
    else {
        rows.push(`—— 输出尾部${tail.droppedBytes > 0 ? `（前 ${tail.droppedBytes} 字节已截断）` : ""} ——`, tail.text);
    }
    return rows.join("\n");
}

/** `job` 工具的宿主切面（**只有两件事**：表 + 可见性） */
export interface JobToolHost {
    /** run 表（宿主自己 new 的那一个；包不提供单例 —— 一张表一个进程，宿主更清楚是谁的） */
    readonly registry: RunRegistry;
    /**
     * 这一条算不算"我能看见/能动"的（**越权边界**）。
     *
     * diy-app：`origin.taskUri === 当前任务`（同 app 多任务并行时，A 不许列 B 的命令、kill B 的活）；
     * bot：不传 = 全都看得见（一个 bot 的进程表就是它自己的）。
     */
    readonly visible?: (info: RunInfo) => boolean;
    /** 文案里的主语（缺省「本任务」；bot 传「本 bot」），只影响两处错误/空表文案 */
    readonly scopeLabel?: string;
}

/**
 * 造 `job` 工具 —— 后台进程的**唯一问询口**。
 *
 * 为什么要有这个工具（而不是让模型每轮 bash 去 `ps`）：用户要的是「llm 心里有数」——
 * 它得能用一个**稳定、可预期**的动作回答四件事：还有哪些在跑（list）、这条是死是活
 * （status）、它说了什么（output）、停掉它（kill），以及"我等它"（wait）。
 * 靠 bash 手搓 `ps -p` / `tail` 会把判据散进命令行，模型每次都要重新想一遍。
 */
export function makeJobTool(host: JobToolHost) {
    const registry = host.registry;
    const visible = host.visible ?? (() => true);
    const scope = host.scopeLabel ?? "本任务";
    const mine = (all: RunInfo[]): RunInfo[] => all.filter(visible);

    return tool({
        // ⚠️ 文案会进 **wire 的 tools 段**（排在 system 之前）—— 改一个字节就把整段前缀缓存作废（##519）。
        // 改这里 ⇒ 同步更新 `apps/diy-app/tests/services/tools-surface-golden.test.ts` 的快照，
        // 那个 diff 就是「本次会冷启一次」的签字。
        description:
            // 「别的任务的 run」那个空格是原文案的一部分：抽包时丢了它，一样砸缓存（##519）。
            `管理**${scope}**用 bash(background: true) 起的后台进程（别的${scope === "本任务" ? "任务的 " : " "}run 看不见、停不掉）。action：` +
            `list（${scope === "本任务" ? "本任务全部" : "全部"}，活着的在前）· status（一条的详情 + 输出尾巴）· output（取输出 tail）· ` +
            "kill（按进程组停止）· wait（等它结束，最多 timeoutMs；**0 = 等 10 分钟上限**，不能无限等）。" +
            "**有完成通知，不需要轮询。**",
        inputSchema: z.object({
            action: z.enum(["list", "status", "output", "kill", "wait"]),
            id: z.string().optional().describe("进程 id（list 不需要；其余必填）"),
            lines: z.number().optional().describe("output/status 取多少行尾巴（缺省 40 / 10）"),
            timeoutMs: z.number().optional().describe("wait 的等待上限（毫秒，缺省 30000；0 = 用上限 10 分钟，不能无限等）"),
        }),
        execute: async ({ action, id, lines, timeoutMs }) => {
            const now = Date.now();
            if (action === "list") {
                const all = mine(registry.list());
                if (all.length === 0) return `（${scope}没有后台进程）`;
                const running = all.filter((p) => p.state === "running").length;
                return [`共 ${all.length} 条（运行中 ${running}）`, ...all.map((p) => runLine(p, now))].join("\n");
            }
            if (!id) return `[缺 id] action=${action} 需要给 id（先用 job list 看有哪些）`;
            const info = registry.get(id);
            if (!info || !visible(info)) {
                return `[没有这个后台进程] ${id}（只认${scope}起的；job list 看现有；宿主重启后表会清空）`;
            }

            if (action === "kill") {
                const ok = registry.kill(id);
                return ok
                    ? `已发送停止信号（进程组 ${info.pid}）：${id}。稍后用 job status 确认终态。`
                    : `未发送：${id} 当前是「${stateLabel(info.state)}」（只有运行中的才可停）。`;
            }
            if (action === "wait") {
                // 0 曾经等于「永远等」：一个永不退出的 daemon + `wait 0` ⇒ 这一轮再也回不去，
                // 而唤醒机制本身是「结束才叫」⇒ 自锁且外部无解。改成**有上限**（10 分钟）。
                const asked = timeoutMs === undefined ? 30_000 : Math.max(0, Math.floor(timeoutMs));
                const limit = asked === 0 ? WAIT_MAX_MS : Math.min(asked, WAIT_MAX_MS);
                const done = await registry.wait(id, limit);
                if (done && done.state === "running") {
                    return `${runDetail(done, (await registry.tail(id, 5)) ?? EMPTY_TAIL, now)}\n（已等 ${formatDuration(limit)}，仍未结束；别干等长任务 —— 去做别的，结束会通知你）`;
                }
                return runDetail(done ?? info, (await registry.tail(id, lines ?? 10)) ?? EMPTY_TAIL, now);
            }
            const tail = (await registry.tail(id, lines ?? (action === "output" ? 40 : 10))) ?? EMPTY_TAIL;
            return runDetail(info, tail, now);
        },
    });
}

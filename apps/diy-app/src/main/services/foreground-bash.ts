/**
 * 前台 bash 的「转后台」入口表（##408 刀 21）—— 给 UI 一个**按工具调用定位**的把手。
 *
 * 为什么需要单独一张表：`runBash` 的控制句柄（`BashControl`）活在 `execute` 的闭包里，
 * 只有**跑着的那一次工具调用**才拿得到它；而用户点「转后台」发生在 UI，两个世界之间
 * 唯一的公共线索就是 `toolCallId`（ops 里、面板里、block id 里都是同一个）。
 *
 * 判据（不满足就不该出现在表里）：
 *   · 前台命令 —— 后台 run 从起跑就是 run，没有「转」这回事；
 *   · 还没结束 —— 结束的进程没有「转」，如实拒绝（`job/already-ended`）；
 *   · 拿到 `toolCallId` —— 没有它就没法把按钮和调用对上，宁可不登记（不造无主按钮）。
 *
 * 这张表**只在内存里**，随进程消失即空：它描述的是"此刻有哪个工具调用还等着"，不是历史。
 * 与 `runRegistry` 的分工：本表管**转的那一刻**，转完的归属、输出、收口全归 run 表。
 */
import type { ChildProcess } from "node:child_process";
import { ownedGroups } from "./owned-groups";
import { fenceTaskOwner } from "../../shared/job-fence";
import { runRegistry, type RunInfo, type RunOrigin, type RunRegistry } from "./run-registry";

/**
 * 转后台失败（**不是缺陷**：并发点击、命令恰好在这毫秒结束，都是正常时序）。
 * 带 `code` 让调用方按码分支，`message` 直接给人看。
 */
export class ForegroundBashError extends Error {
    readonly code: string;
    /** 与 `DetachError` 同形状（`{ code, message }`）：错误码是**判据**，出场就该带着它 */
    constructor(input: { code: string; message: string }) {
        super(input.message);
        this.code = input.code;
    }
}

/** 结构化（不 import `local-agent`：那边要 import 本文件，反向 import 会成环）。 */
export interface DetachableProcess {
    readonly child: ChildProcess;
    readonly pid: number;
    readonly startedAt: number;
    ended(): boolean;
    handoff(write: (b: Buffer) => void): Buffer;
    finishAsDetached(text: string): void;
}

export interface ForegroundEntry {
    readonly process: DetachableProcess;
    readonly command: string;
    readonly cwd: string;
    readonly origin?: RunOrigin;
}

/** 一条可转后台的前台调用（给 UI 列按钮用；不含控制句柄） */
export interface DetachableView {
    toolCallId: string;
    command: string;
    taskUri?: string;
    startedAt: number;
    /** 已经跑到第几毫秒（UI 显示「已跑 N 秒」）。用调用时的时间算，不是快照 —— 面板每 3s 刷新一次，够准 */
    runningMs: number;
}

export class ForegroundBash {
    private readonly map = new Map<string, ForegroundEntry>();

    constructor(
        private readonly registry: RunRegistry = runRegistry,
        private readonly now: () => number = Date.now,
    ) {}

    /** `runBash` 的 `onControl` 里调（同步）：登记一条可转后台的前台调用。 */
    register(toolCallId: string, entry: ForegroundEntry): void {
        this.map.set(toolCallId, entry);
    }

    /** 工具调用收尾时调（`finally`）：正常结束的条目没有「转」这回事，直接摘掉。 */
    drop(toolCallId: string): void {
        this.map.delete(toolCallId);
    }

    /** 可转的调用（按任务过滤：A 任务不该看见 B 任务的按钮 —— 与 `job.ps` 同一道围栏） */
    list(taskUri: string): DetachableView[] {
        const now = this.now();
        const out: DetachableView[] = [];
        for (const [toolCallId, e] of this.map) {
            if (e.origin?.taskUri !== taskUri) continue;
            if (e.process.ended()) continue;
            out.push({
                toolCallId,
                command: e.command,
                taskUri: e.origin?.taskUri,
                startedAt: e.process.startedAt,
                runningMs: Math.max(0, now - e.process.startedAt),
            });
        }
        return out;
    }

    /**
     * 把一次前台调用转成后台 run：接管同一个进程（不重启、不换读端），并**替它收尾**
     * （工具调用立刻返回一段「已转后台」+ run id，模型据此去 `job status`）。
     */
    async detach(toolCallId: string, taskUri: string): Promise<RunInfo> {
        const e = this.map.get(toolCallId);
        if (!e) throw new ForegroundBashError({ code: "agent/job-not-found", message: "这条工具调用已经不在前台表里（可能已结束或已转后台）" });
        // 归属闸（`shared/job-fence.ts`）：与 kill 同一份判据 —— 声明必须与记录一致。
        // 转后台之后这条 run 就归那个任务了（退出即收 / 通知都按它算），认错归属等于替别人起活。
        const fence = fenceTaskOwner(taskUri, e.origin?.taskUri ?? null, "这条前台调用");
        if (!fence.ok) throw new ForegroundBashError({ code: fence.code, message: fence.msg });
        if (e.process.ended()) {
            this.map.delete(toolCallId);
            throw new ForegroundBashError({ code: "agent/job-already-ended", message: "命令已经结束，结果就在那条工具调用里" });
        }
        let info: RunInfo;
        try {
            info = await this.registry.adopt({
                process: e.process,
                command: e.command,
                cwd: e.cwd,
                ...(e.origin ? { origin: e.origin } : {}),
            });
        } catch (err) {
            // 交接已经发生了（`handoff` 是 adopt 内部的一步）就必须收尾，否则这条工具调用永远挂着；
            // 还没交接则这行抛 `not-detached`，吞掉即可（真正的错误是 err 本身）。
            try {
                e.process.finishAsDetached(`[转后台失败] ${(err as Error).message}`);
            } catch {
                /* 未交接 ⇒ 无需收尾 */
            }
            this.map.delete(toolCallId);
            throw err;
        }
        this.map.delete(toolCallId);
        // 组名册：转后台之后它和 `background:true` 起的一样归我们管（退出即收、孤儿认领都靠它）
        ownedGroups.record(info.pid ?? e.process.pid, {
            at: info.startedAt,
            command: e.command,
            cwd: e.cwd,
            ...(e.origin?.taskUri ? { taskUri: e.origin.taskUri } : {}),
            runId: info.id,
        });
        e.process.finishAsDetached(
            [
                `[已转后台] ${info.id}（pid ${info.pid ?? e.process.pid}）`,
                `输出：${info.logPath}`,
                "结束时会自动通知你，**不要轮询**（sleep 再查 = 轮询）。现在可以继续干别的，或直接结束本轮。",
                `随时查：job status ${info.id} / job output ${info.id} / job kill ${info.id}`,
            ].join("\n"),
        );
        return info;
    }
}

export const foregroundBash = new ForegroundBash();

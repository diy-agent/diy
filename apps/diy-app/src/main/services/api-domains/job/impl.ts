/**
 * api-domains/job/impl.ts —— `job` 域的 handler（活体表：run = 进程型或进程内任务）
 */
import type { ServerBinding } from "@diy-agent/rpc";
import { runRegistry } from "../../run-registry";
import { foregroundBash } from "../../foreground-bash";
import { scanOwnedProcs, groupOwnerOf, killOwnedProc } from "../../process-scan";
import { procRowOf, runViewOf } from "../../../../shared/run-view";
import { parseEtime } from "../../../os";
import { stateLabel } from "../../../../shared/run-status";
import { fenceTaskOwner } from "../../../../shared/job-fence";
import { jobService } from "./api";

export function bindJob(server: ServerBinding): void {
    jobService.bind(server, {
        ps: async ({ input }) => {
            const now = Date.now();
            const all = runRegistry.list();
            const picked = input.all === true ? all : all.filter((r) => r.state === "running");
            // 顺带扫一遍 ps：登记过的 run 之外，命令里自己 `nohup xxx &` 起的进程也要看见（##408 刀 10）。
            // `scan:false` 只给"我只要表里那几条"的调用方（省一次 ps）。
            // 缺省**扫**；`--no-scan` 才跳过。为什么不是 `scan: boolean`：
            // CLI 的布尔选项缺省是 `false`（`--scan` 不写就是 false），会把"没表态"读成"不要扫"
            // —— 实测症状：`diy job ps` 永远 `scanOk:false`、看不见 `nohup xxx &` 起的孤儿。
            const scan = input.noScan === true ? null : await scanOwnedProcs({ runPids: runRegistry.pidMap() });
            const procRows = (scan?.procs ?? []).map((p) =>
                procRowOf(p, parseEtime(p.etimeText), groupOwnerOf(p.anchorPid ?? p.pgid)),
            );
            const byRun: Record<string, typeof procRows> = {};
            for (const row of procRows) if (row.runId) (byRun[row.runId] ??= []).push(row);
            return {
                status: "ok",
                data: {
                    runs: await Promise.all(
                        picked.map(async (r) => runViewOf(r, now, (await runRegistry.outputBytes(r.id)) ?? null)),
                    ),
                    /** 没登记进活体表的进程（表格里跟在 run 后面） */
                    untracked: procRows.filter((r) => r.runId === null),
                    /** 每条 run 名下的进程（含根进程；根进程退了但子孙还在时这里仍非空） */
                    procsByRun: byRun,
                    running: all.filter((r) => r.state === "running").length,
                    total: all.length,
                    scanAt: scan?.at ?? null,
                    scanOk: scan?.ok ?? false,
                    /** R10：平台能力/寿命差异的事实句（Windows 明说「寿命跟根进程」） */
                    facts: scan?.facts ?? [],
                },
            };
        },
        detachables: async ({ input }) => ({
            status: "ok",
            data: { items: foregroundBash.list(input.taskUri) },
        }),
        detach: async ({ input }) => {
            try {
                const info = await foregroundBash.detach(input.toolCallId, input.taskUri);
                return { status: "ok", data: { id: info.id, pid: info.pid ?? null, logPath: info.logPath } };
            } catch (err) {
                // 拒绝是**正常时序**（恰好结束 / 连按两次 / 跨任务）—— 如实回给调用方，不抛
                const code = (err as { code?: unknown }).code;
                return { status: "error", msg: `${typeof code === "string" ? `[${code}] ` : ""}${(err as Error).message}` };
            }
        },
        procs: async () => {
            const scan = await scanOwnedProcs({ runPids: runRegistry.pidMap() });
            return {
                status: "ok",
                data: {
                    at: scan.at,
                    ok: scan.ok,
                    facts: scan.facts,
                    procs: scan.procs.map((p) => procRowOf(p, parseEtime(p.etimeText), groupOwnerOf(p.anchorPid ?? p.pgid))),
                },
            };
        },
        killproc: async ({ input }) => {
            // 重新扫一遍再动手：pid 可能已被回收、也可能根本不是我们的（调用方给错号的代价是杀别人）
            const scan = await scanOwnedProcs({ runPids: runRegistry.pidMap() });
            const hit = scan.procs.find((p) => p.pid === input.pid);
            if (!hit) {
                return { status: "error", msg: `pid ${input.pid} 不在"归我们管"的进程名单里（diy job procs 看现在有哪些）` };
            }
            // 归属闸（`shared/job-fence.ts`）：声明必须与我们记下的归属一致。
            // 组名册是首选（野进程只有它有记录）；登记过的 run 再退到它的 origin。
            const owner = groupOwnerOf(hit.anchorPid ?? hit.pgid)?.taskUri ?? (hit.runId ? runRegistry.get(hit.runId)?.origin?.taskUri : undefined);
            const fence = fenceTaskOwner(input.taskUri, owner ?? null, `进程 ${hit.pid}`);
            if (!fence.ok) return { status: "error", msg: fence.msg };
            const ok = killOwnedProc(hit);
            // ok = 「结束请求已发出」（Windows 的 taskkill 是异步的，不承诺此刻已死）
            return { status: "ok", data: { ok, pid: hit.pid, pgid: hit.pgid } };
        },
        kill: async ({ input }) => {
            const info = runRegistry.get(input.id);
            if (!info) return { status: "error", msg: `没有这条 run：${input.id}（diy job ps 看在跑什么）` };
            if (info.state !== "running") return { status: "error", msg: `这条 run 已经结束（${stateLabel(info.state)}），无需停止` };
            const fence = fenceTaskOwner(input.taskUri, info.origin?.taskUri ?? null, `run ${input.id}`);
            if (!fence.ok) return { status: "error", msg: fence.msg };
            const ok = runRegistry.kill(input.id);
            return { status: "ok", data: { ok, id: input.id } };
        },
        tail: async ({ input }) => {
            const tail = await runRegistry.tail(input.id, input.lines ?? 40);
            if (!tail) return { status: "error", msg: `没有这条 run：${input.id}` };
            return { status: "ok", data: { ...tail, logPath: runRegistry.get(input.id)?.logPath ?? null } };
        },
        meta: async ({ input }) => {
            const info = runRegistry.get(input.id);
            if (!info) return { status: "error", msg: `没有这条 run：${input.id}` };
            return {
                status: "ok",
                data: {
                    metaJson: (await runRegistry.metaJson(input.id)) ?? null,
                    dir: info.dir,
                    logPath: info.logPath,
                    outputBytes: (await runRegistry.outputBytes(input.id)) ?? null,
                },
            };
        },
    });
}

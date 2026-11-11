/**
 * api-domains/traffic/impl.ts —— `traffic` 域的 handler
 *
 * 从 api-impl.ts 拆出。**注意**：`api-impl.ts` 里 `traffic` 没有自己的 `// ── 分组`
 * 注释（紧贴在 `job` 头后面），所以按注释切会漏。
 */
import type { ServerBinding } from "@diy-agent/rpc";
import { traffic } from "../../../core/traffic";
import { openUrlWith } from "../../../core/open-url";
import { trafficApi } from "./api";
import { clearTraffic, recentTraffic, trafficStats } from "../../../core/traffic-log";

/** 内存窗口查询：entries + 窗口计数一起回（界面要显示「N/500」） */
function recentWindow(q: Parameters<typeof recentTraffic>[0]): {
    entries: Record<string, unknown>[];
    count: number;
    bytes: number;
    dropped: number;
} {
    const st = trafficStats();
    return {
        entries: recentTraffic(q) as unknown as Record<string, unknown>[],
        count: st.count,
        bytes: st.bytes,
        dropped: st.dropped,
    };
}

export function bindTraffic(server: ServerBinding): void {
    server.use({
        prefix: "diy",
        api: trafficApi,
        // 模块层由模块自己声明（traffic）：与 defineService(name: "diy.traffic") 等价
        handlers: {
            traffic: {
            snapshot: async ({ input }) => traffic.snapshot(input.withRecords ?? true),
            clear: async () => {
                traffic.clear();
                clearTraffic();
                return { status: "ok" };
            },
            recent: async ({ input }) =>
                recentWindow({
                    ...(input.n === undefined ? {} : { n: input.n }),
                    ...(input.kind === undefined ? {} : { kind: input.kind }),
                    ...(input.taskUri === undefined ? {} : { taskUri: input.taskUri }),
                    ...(input.since === undefined ? {} : { since: input.since }),
                }),
            setFullCapture: async ({ input }) => {
                traffic.setFullCapture(input.on);
                return traffic.snapshot();
            },
            setCap: async ({ input }) => {
                traffic.setCap(input.n);
                return traffic.snapshot();
            },
            readLog: async ({ input }) => {
                try {
                    const record = traffic.readLog({ file: input.file, offset: input.offset, len: input.len });
                    return { ok: true, message: null, record };
                } catch (e) {
                    return { ok: false, message: e instanceof Error ? e.message : String(e), record: null };
                }
            },
            query: async ({ input }) => traffic.query(input),
            logFiles: async () => ({
                dir: traffic.logDir(),
                files: traffic.listLogFiles(),
                dates: traffic.listLogDates(),
                bytes: traffic.logStats().bytes,
                detail: traffic.listLogFileDetail(),
            }),
            cleanLogs: async ({ input }) => traffic.cleanLogs(input),
            revealLog: async ({ input }) => {
                const abs = traffic.absLogFile(input.file);
                try {
                    const { shell } = await import("electron");
                    shell.showItemInFolder(abs);
                    return { ok: true, message: null };
                } catch (e) {
                    return { ok: false, message: e instanceof Error ? e.message : String(e) };
                }
            },
            openUrl: async ({ input }) => {
                const { shell } = await import("electron");
                return openUrlWith(shell, input.url);
            },
            events: async function* () {
                for await (const ev of traffic.events()) yield ev;
            },
        } },
    });
}

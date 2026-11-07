/**
 * api-domains/traffic/impl.ts —— `traffic` 域的 handler
 *
 * 从 api-impl.ts 拆出。**注意**：`api-impl.ts` 里 `traffic` 没有自己的 `// ── 分组`
 * 注释（紧贴在 `job` 头后面），所以按注释切会漏。
 */
import type { ServerBinding } from "@diy-agent/rpc";
import { traffic } from "../../../core/traffic";
import { openUrlWith } from "../../../core/open-url";
import { trafficService } from "./api";

export function bindTraffic(server: ServerBinding): void {
    trafficService.bind(server, {
        snapshot: async ({ input }) => traffic.snapshot(input.withRecords ?? true),
        clear: async () => {
            traffic.clear();
            return { status: "ok" };
        },
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
    });
}

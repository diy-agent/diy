/**
 * client.ts —— 领域式 rpc 客户端（##518）
 *
 * 规则（docs/ui-architecture.md §2.1）：组件里不出现 `invoke('query', …)` 这种字符串方法名；
 * 方法名与入参形状只在这个文件里。app 改协议 ⇒ 编译期在这里报错。
 */
import type { DevtoolsHost, LogFiles, QueryResult, TrafficEntry } from "./types.js";

export interface TrafficQuery {
    readonly text?: string;
    readonly status?: "all" | "ok" | "4xx" | "5xx" | "err";
    readonly method?: string;
    readonly date?: string;
    readonly limit?: number;
}

export interface TrafficClient {
    /** 按条件查磁盘日志（主界面数据源） */
    query(q: TrafficQuery): Promise<QueryResult>;
    /** 内存窗口里最近几条（比读盘快三个数量级） */
    recent(n?: number): Promise<readonly TrafficEntry[]>;
    /** 日志文件清单（顶部体积 / 日期过滤） */
    logFiles(): Promise<LogFiles>;
}

export function createTrafficClient(host: DevtoolsHost): TrafficClient {
    return {
        query: (q) => host.invoke<QueryResult>("query", q),
        recent: async (n) => {
            const res = await host.invoke<{ entries: readonly TrafficEntry[] }>("traffic.recent", n === undefined ? {} : { n });
            return res.entries;
        },
        logFiles: () => host.invoke<LogFiles>("logFiles"),
    };
}

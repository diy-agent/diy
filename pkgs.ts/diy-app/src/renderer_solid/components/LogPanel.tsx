import { createSignal, onMount, For, createMemo } from "solid-js";
import { diyService } from "../lib/rpc";

export interface LogEntry {
  timestamp?: string;
  time?: string;
  level?: string;
  message?: string;
  msg?: string;
  raw?: string;
}

export function LogPanel() {
    const [logs, setLogs] = createSignal<LogEntry[]>([]);
    const [filter, setFilter] = createSignal("");
    const [levelFilter, setLevelFilter] = createSignal<string | null>(null);
    const load = async () => {
        const e = await diyService.diy.log.read({ limit: 500 });
        setLogs(e);
    };
    onMount(load);
    const filtered = createMemo(() =>
        logs().filter((e) => {
            if (levelFilter() && e.level !== levelFilter()) return false;
            if (filter() && !JSON.stringify(e).toLowerCase().includes(filter().toLowerCase()))
                return false;
            return true;
        }),
    );
    const levels = createMemo(
        () =>
            [...new Set(logs().map((e) => e.level ?? ""))]
                .filter(Boolean)
                .sort() as string[],
    );
    return (
        <div class="flex flex-col h-full">
            <div class="flex items-center gap-2 px-3 py-2 border-b shrink-0">
                <input
                    value={filter()}
                    onInput={(e) => setFilter(e.currentTarget.value)}
                    placeholder="搜索日志…"
                    class="input input-bordered input-sm w-40"
                />
                <select
                    value={levelFilter() ?? ""}
                    onChange={(e) => setLevelFilter(e.currentTarget.value || null)}
                    class="select select-bordered select-sm"
                >
                    <option value="">全部</option>
                    <For each={levels()}>{(lv) => <option value={lv}>{lv}</option>}</For>
                </select>
                <button class="btn btn-ghost btn-sm ml-auto" onClick={load}>
                    刷新
                </button>
                <span class="text-xs opacity-60">{filtered().length} 条</span>
            </div>
            <div class="flex-1 overflow-auto">
                {filtered().length === 0 ? (
                    <div class="flex items-center justify-center h-full opacity-60 text-xs">
                        无日志
                    </div>
                ) : (
                    <div class="font-mono text-xs leading-relaxed">
                        <For each={filtered()}>
                            {(entry) => {
                                const level = String(entry["level"] ?? "");
                                const time = String(
                                    entry["timestamp"] ?? entry["time"] ?? "",
                                ).slice(0, 19);
                                const msg = String(
                                    entry["message"] ?? entry["msg"] ?? JSON.stringify(entry),
                                );
                                return (
                                    <div class="border-b border-base-300 px-3 py-1.5 hover:bg-base-200">
                                        {time} <span class="font-bold uppercase">{level}</span>{" "}
                                        {msg}
                                    </div>
                                );
                            }}
                        </For>
                    </div>
                )}
            </div>
        </div>
    );
}

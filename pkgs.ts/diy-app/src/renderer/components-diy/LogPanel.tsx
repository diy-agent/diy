import { useState, useEffect, useCallback } from "react";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { diyService } from "./lib/rpc";

const levelColor: Record<string, string> = {
  error: "text-destructive",
  warn: "text-diy-state-pending",
  info: "text-diy-state-active",
  debug: "text-muted-foreground",
};

export function LogPanel() {
  const [logs, setLogs] = useState<Array<Record<string, unknown>>>([]);
  const [filter, setFilter] = useState("");
  const [levelFilter, setLevelFilter] = useState<string | null>(null);

  const load = useCallback(async () => {
    const entries = await diyService.diy.log.read({ limit: 500 });
    setLogs(entries);
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const filtered = logs.filter((e) => {
    if (levelFilter && e["level"] !== levelFilter) return false;
    if (filter && !JSON.stringify(e).toLowerCase().includes(filter.toLowerCase())) return false;
    return true;
  });

  const levels = [...new Set(logs.map((e) => String(e["level"] ?? "")))].filter(Boolean).sort();

  return (
    <div className="flex flex-col h-full">
      {/* 工具栏 */}
      <div className="flex items-center gap-2 px-3 py-2 border-b shrink-0">
        <input
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          placeholder="搜索日志…"
          className="h-7 w-40 rounded border bg-background px-2 text-xs"
        />
        <select
          value={levelFilter ?? ""}
          onChange={(e) => setLevelFilter(e.target.value || null)}
          className="h-7 rounded border bg-background px-1 text-xs"
        >
          <option value="">全部</option>
          {levels.map((lv) => (
            <option key={lv} value={lv}>
              {lv}
            </option>
          ))}
        </select>
        <Button variant="ghost" size="sm" className="text-xs ml-auto" onClick={load}>
          刷新
        </Button>
        <span className="text-xs text-muted-foreground">{filtered.length} 条</span>
      </div>

      {/* 日志列表 */}
      <ScrollArea className="flex-1">
        {filtered.length === 0 ? (
          <div className="flex items-center justify-center h-full text-muted-foreground text-xs">
            无日志
          </div>
        ) : (
          <div className="font-mono text-xs leading-relaxed">
            {filtered.map((entry, i) => {
              const level = String(entry["level"] ?? "");
              const time = String(entry["timestamp"] ?? entry["time"] ?? "").slice(0, 19);
              const msg = String(entry["message"] ?? entry["msg"] ?? JSON.stringify(entry));
              return (
                <div
                  key={i}
                  className={cn(
                    "border-b border-border/30 px-3 py-1.5 hover:bg-muted/30",
                    levelColor[level] ?? "",
                  )}
                >
                  <span className="text-muted-foreground/50">{time}</span>{" "}
                  <span className="font-semibold uppercase">{level}</span> {msg}
                </div>
              );
            })}
          </div>
        )}
      </ScrollArea>
    </div>
  );
}

import { useState, useEffect } from "react";
import { diyService } from "./lib/rpc";
import { Button } from "@/components/ui/button";
import { useNotificationStore } from "./store/notificationStore";

export function LlmPage() {
  const [running, setRunning] = useState(false);
  const [loading, setLoading] = useState(true);
  const addToast = useNotificationStore((s) => s.addToast);

  const refresh = async () => {
    const s = await diyService.diy.llmProxy.status({});
    setRunning(s.running);
    setLoading(false);
  };

  useEffect(() => {
    refresh();
  }, []);

  const toggle = async () => {
    setLoading(true);
    try {
      if (running) {
        await diyService.diy.llmProxy.stop({});
        addToast("success", "LLM 代理已停止");
      } else {
        await diyService.diy.llmProxy.start({});
        addToast("success", "LLM 代理已启动");
      }
    } catch (e) {
      addToast("error", e instanceof Error ? e.message : "操作失败");
    }
    await refresh();
  };

  return (
    <div className="flex flex-col gap-4 p-4 max-w-xl">
      <h2 className="text-base font-bold">LLM 代理</h2>

      <div className="rounded-lg border p-4">
        <div className="flex items-center justify-between mb-3">
          <span className="text-sm font-medium">运行状态</span>
          <span
            className={`text-xs px-2 py-0.5 rounded-full ${running ? "bg-diy-state-done text-black" : "bg-muted text-muted-foreground"}`}
          >
            {loading ? "检查中…" : running ? "运行中" : "已停止"}
          </span>
        </div>

        {running && (
          <div className="text-xs text-muted-foreground space-y-1">
            <div>
              端口: <code className="text-foreground">8000</code>
            </div>
            <div>
              地址: <code className="text-foreground">http://127.0.0.1:8000</code>
            </div>
          </div>
        )}

        <Button className="mt-3" size="sm" onClick={toggle} disabled={loading}>
          {loading ? "处理中…" : running ? "停止" : "启动"}
        </Button>
      </div>
    </div>
  );
}

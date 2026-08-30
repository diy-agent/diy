// src/renderer/components-diy/TaskDetailPanel.tsx
// 🎯 任务详情浮动面板 — 非模态，列表保持可点击，点任务切换内容
import { useEffect, useRef } from "react";
import { useTaskStore } from "./store/taskStore";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { XIcon } from "lucide-react";

const stateColor: Record<string, string> = {
  pending: "bg-diy-state-pending text-black",
  active: "bg-diy-state-active text-black",
  done: "bg-diy-state-done text-black",
  blocked: "bg-diy-state-blocked text-black",
  cancelled: "bg-diy-state-cancelled text-white",
};

export function TaskDetailPanel() {
  const { selectedUri, selectedTask, selectTask } = useTaskStore();
  const panelRef = useRef<HTMLDivElement>(null);

  // Esc 关闭
  useEffect(() => {
    if (!selectedUri) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") selectTask(null);
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [selectedUri, selectTask]);

  if (!selectedUri) return null;

  const task = selectedTask as Record<string, unknown> | null;

  return (
    <div
      ref={panelRef}
      className="absolute inset-y-0 right-0 z-40 flex flex-col bg-background border-l shadow-xl"
      style={{ width: "65%" }}
    >
      {/* 面板顶栏 */}
      <div className="flex items-center justify-between px-4 py-2 border-b shrink-0">
        <span className="text-xs font-mono text-muted-foreground truncate max-w-[300px]">
          {selectedUri}
        </span>
        <Button
          variant="ghost"
          size="icon-sm"
          onClick={() => selectTask(null)}
          className="shrink-0"
        >
          <XIcon size={14} />
        </Button>
      </div>

      {/* 面板内容 */}
      <div className="flex-1 overflow-y-auto p-4">
        {task ? <TaskDetail task={task} /> : (
          <div className="text-muted-foreground text-sm">加载中…</div>
        )}
      </div>
    </div>
  );
}

function TaskDetail({ task }: { task: Record<string, unknown> }) {
  const uri = String(task["uri"] ?? "");
  const title = String(task["title"] ?? "");
  const state = String(task["state"] ?? "");
  const project = String(task["project"] ?? "");
  const created = String(task["created"] ?? "");
  const updated = String(task["updated"] ?? "");
  const body = String(task["body"] ?? "");
  const detail = String(task["detail"] ?? "");

  return (
    <div className="space-y-4">
      {/* 标题 + 状态 */}
      <div>
        <h2 className="text-lg font-bold text-foreground mb-1">{title || uri}</h2>
        {state && (
          <Badge className={`${stateColor[state] ?? ""} border-0 text-xs`}>
            {state}
          </Badge>
        )}
      </div>

      {/* 元信息 */}
      <div className="flex gap-2 flex-wrap text-xs text-muted-foreground">
        {project && (
          <span className="bg-muted px-2 py-0.5 rounded">📂 {project}</span>
        )}
        {created && (
          <span className="bg-muted px-2 py-0.5 rounded">
            🕐 {new Date(created).toLocaleString()}
          </span>
        )}
        {updated && updated !== created && (
          <span className="bg-muted px-2 py-0.5 rounded">
            ✏️ {new Date(updated).toLocaleString()}
          </span>
        )}
      </div>

      {/* 详情 */}
      {detail && (
        <div>
          <h3 className="text-xs font-semibold text-muted-foreground mb-1">详情</h3>
          <div className="text-sm text-foreground/80 whitespace-pre-wrap">{detail}</div>
        </div>
      )}

      {/* 正文 */}
      {body && (
        <div>
          <h3 className="text-xs font-semibold text-muted-foreground mb-1">正文</h3>
          <div className="text-sm text-foreground/80 whitespace-pre-wrap leading-relaxed">
            {body}
          </div>
        </div>
      )}
    </div>
  );
}

// src/renderer/components-diy/CreateTaskSheet.tsx
// 🎯 任务树「+」按钮 → 右侧滑出表单 → 创建任务（支持子任务）并刷新树。
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetDescription,
  SheetFooter,
} from "@/components/ui/sheet";
import { diyService } from "./lib/rpc";
import { useTaskStore } from "./store/taskStore";
import { useNotificationStore } from "./store/notificationStore";

interface Props {
  projectId: string;
  projectLabel: string;
  /** 父任务 URI — 有值时创建子任务 */
  parentUri?: string;
  /** 触发按钮外观：false=紧凑（任务行用），true=完整（项目行用） */
  compact?: boolean;
}

export function CreateTaskSheet({ projectId, projectLabel, parentUri, compact }: Props) {
  const [open, setOpen] = useState(false);
  const [title, setTitle] = useState("");
  const [busy, setBusy] = useState(false);
  const loadTree = useTaskStore((s) => s.loadTree);
  const addToast = useNotificationStore((s) => s.addToast);

  const isSubtask = !!parentUri;
  const desc = isSubtask ? `添加到「${projectLabel}」` : `为「${projectLabel}」创建新任务`;

  const submit = async () => {
    if (!title.trim()) {
      addToast("error", "标题不能为空");
      return;
    }
    setBusy(true);
    try {
      await diyService.diy.task.create({
        title: title.trim(),
        project: projectId,
        parent: parentUri ?? undefined,
        detail: undefined,
        body: undefined,
      });
      setOpen(false);
      setTitle("");
      await loadTree();
      addToast("success", isSubtask ? "子任务已创建" : "任务已创建");
    } catch (e) {
      addToast("error", `创建失败: ${(e as Error).message}`);
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <button
        className="ml-auto text-muted-foreground hover:text-foreground text-xs px-1 opacity-0 group-hover:opacity-100 transition-opacity"
        onClick={(e) => {
          e.stopPropagation();
          setOpen(true);
        }}
      >
        ＋
      </button>

      <Sheet open={open} onOpenChange={setOpen}>
        <SheetContent side="right">
          <SheetHeader>
            <SheetTitle>{isSubtask ? "添加子任务" : "添加任务"}</SheetTitle>
            <SheetDescription>{desc}</SheetDescription>
          </SheetHeader>

          <div className="flex flex-col gap-3 p-4">
            <Input
              placeholder="任务标题"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && title.trim()) submit();
              }}
              autoFocus
            />
          </div>

          <SheetFooter>
            <Button variant="ghost" onClick={() => setOpen(false)}>
              取消
            </Button>
            <Button onClick={submit} disabled={busy || !title.trim()}>
              {busy ? "创建中…" : "创建"}
            </Button>
          </SheetFooter>
        </SheetContent>
      </Sheet>
    </>
  );
}

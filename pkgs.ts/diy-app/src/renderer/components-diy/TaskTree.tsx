// src/renderer/components-diy/TaskTree.tsx
// 🎯 任务树：项目分组 + 拖拽改父子 + 每行「+」加子任务
import { useEffect, useCallback } from "react";
import {
  DndContext,
  DragOverlay,
  PointerSensor,
  useSensor,
  useSensors,
  type DragEndEvent,
  type DragStartEvent,
} from "@dnd-kit/core";
import { useDraggable, useDroppable } from "@dnd-kit/core";
import { useTaskStore, type TreeNode } from "./store/taskStore";
import { ScrollArea } from "@/components/ui/scroll-area";
import { cn } from "@/lib/utils";
import { CreateProjectSheet } from "./CreateProjectSheet";
import { CreateTaskSheet } from "./CreateTaskSheet";
import { diyService } from "./lib/rpc";
import { useNotificationStore } from "./store/notificationStore";
import { useState } from "react";

const stateColor: Record<string, string> = {
  pending: "bg-diy-state-pending",
  active: "bg-diy-state-active",
  done: "bg-diy-state-done",
  blocked: "bg-diy-state-blocked",
  cancelled: "bg-diy-state-cancelled",
};

export function TaskTree() {
  const { nodes, selectedUri, loading, loadTree, selectTask } = useTaskStore();
  const addToast = useNotificationStore((s) => s.addToast);
  const [activeId, setActiveId] = useState<string | null>(null);

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 5 } }),
  );

  useEffect(() => {
    loadTree();
  }, []);

  /** 收集所有 task URI → project 映射（同项目内才能拖） */
  const findTaskProject = useCallback(
    (uri: string): { project: string; parent: string | undefined } | null => {
      for (const proj of nodes) {
        if (proj.kind !== "project") continue;
        const found = findInTree(proj.children, uri);
        if (found) return { project: proj.project ?? "", parent: found.parentUri };
      }
      return null;
    },
    [nodes],
  );

  const handleDragStart = (e: DragStartEvent) => {
    setActiveId(String(e.active.id));
  };

  const handleDragEnd = async (e: DragEndEvent) => {
    setActiveId(null);
    const { active, over } = e;
    if (!over || active.id === over.id) return;

    const dragUri = String(active.id);
    const dropUri = String(over.id);

    // 只允许同项目内拖拽
    const dragInfo = findTaskProject(dragUri);
    const dropInfo = findTaskProject(dropUri);
    if (!dragInfo || !dropInfo) return;
    if (dragInfo.project !== dropInfo.project) {
      addToast("error", "只能在同一项目内拖动");
      return;
    }
    // 不能拖到自己的子任务上（会形成循环）
    if (dropUri === dragInfo.parent) return;

    try {
      await diyService.diy.task.edit({
        uri: dragUri,
        title: undefined,
        state: undefined,
        detail: undefined,
        parent: dropUri,
      });
      await loadTree();
      addToast("success", "已调整层级");
    } catch (err) {
      addToast("error", `调整失败: ${(err as Error).message}`);
    }
  };

  return (
    <DndContext sensors={sensors} onDragStart={handleDragStart} onDragEnd={handleDragEnd}>
      <div className="h-full flex flex-col">
        <div className="flex items-center justify-between px-2 py-1.5 border-b shrink-0">
          <span className="text-sm font-semibold">项目</span>
          <CreateProjectSheet />
        </div>
        <ScrollArea className="flex-1 overflow-hidden">
          <div className="p-1">
            {nodes.map((node) => (
              <ProjectNode
                key={node.project ?? ""}
                node={node}
                depth={0}
                selectedUri={selectedUri}
                onSelect={selectTask}
              />
            ))}
            {!loading && nodes.length === 0 && (
              <div className="text-sm text-muted-foreground p-4 text-center">暂无任务</div>
            )}
          </div>
        </ScrollArea>
      </div>
      <DragOverlay>
        {activeId ? <DragGhost uri={activeId} nodes={nodes} /> : null}
      </DragOverlay>
    </DndContext>
  );
}

// ═══════════════════════════════════════
// 拖拽时的浮层
// ═══════════════════════════════════════

function DragGhost({ uri, nodes }: { uri: string; nodes: TreeNode[] }) {
  const task = findInAll(nodes, uri);
  if (!task) return null;
  return (
    <div className="flex items-center px-3 py-1 text-sm bg-background border rounded shadow-md opacity-80 max-w-[200px]">
      <span className="truncate">{task.title}</span>
    </div>
  );
}

// ═══════════════════════════════════════
// 项目节点
// ═══════════════════════════════════════

function ProjectNode({
  node,
  depth: _depth,
  selectedUri,
  onSelect,
}: {
  node: TreeNode;
  depth: number;
  selectedUri: string | null;
  onSelect: (uri: string | null) => void;
}) {
  return (
    <div>
      <div className="group flex items-center px-2 py-1.5 text-sm font-semibold text-foreground">
        <span className="mr-1.5">📁</span>
        <span className="truncate">{node.title}</span>
        {node.project && (
          <CreateTaskSheet projectId={node.project} projectLabel={node.title ?? node.project} />
        )}
      </div>
      {node.children.map((child) => (
        <TaskRow
          key={child.uri}
          node={child}
          depth={1}
          selectedUri={selectedUri}
          onSelect={onSelect}
          projectId={node.project ?? ""}
        />
      ))}
    </div>
  );
}

// ═══════════════════════════════════════
// 任务行（可拖拽 + 可放置 + ＋按钮）
// ═══════════════════════════════════════

function TaskRow({
  node,
  depth,
  selectedUri,
  onSelect,
  projectId,
}: {
  node: TreeNode;
  depth: number;
  selectedUri: string | null;
  onSelect: (uri: string | null) => void;
  projectId: string;
}) {
  const isSelected = node.uri === selectedUri;
  const colorClass = node.state ? (stateColor[node.state] ?? "bg-border") : "bg-border";
  const uri = node.uri ?? "";

  const { attributes, listeners, setNodeRef: setDragRef, isDragging } = useDraggable({ id: uri });
  const { setNodeRef: setDropRef, isOver } = useDroppable({ id: uri });

  return (
    <div>
      <div
        ref={(el) => {
          setDragRef(el);
          setDropRef(el);
        }}
        className={cn(
          "group flex items-center py-1 text-sm cursor-pointer rounded-sm mx-1",
          isSelected ? "bg-accent/20 text-foreground" : "hover:bg-muted",
          isDragging && "opacity-40",
          isOver && "ring-1 ring-primary/50",
        )}
        style={{ paddingLeft: 16 + depth * 16 + "px" }}
        onClick={() => onSelect(uri)}
        {...listeners}
        {...attributes}
      >
        <span className={cn("w-2 h-2 mr-2 rounded-full inline-block shrink-0", colorClass)} />
        <span className="text-muted-foreground mr-1.5 text-xs font-mono truncate max-w-[120px]">{uri}</span>
        <span className="truncate flex-1">{node.title}</span>
        {node.starred && <span className="text-xs ml-1">⭐</span>}
        <CreateTaskSheet
          projectId={projectId}
          projectLabel={node.title ?? ""}
          parentUri={uri}
          compact
        />
      </div>
      {node.children.map((child) => (
        <TaskRow
          key={child.uri}
          node={child}
          depth={depth + 1}
          selectedUri={selectedUri}
          onSelect={onSelect}
          projectId={projectId}
        />
      ))}
    </div>
  );
}

// ═══════════════════════════════════════
// 工具函数
// ═══════════════════════════════════════

function findInTree(children: TreeNode[], uri: string): TreeNode | null {
  for (const c of children) {
    if (c.uri === uri) return c;
    const found = findInTree(c.children, uri);
    if (found) return found;
  }
  return null;
}

function findInAll(nodes: TreeNode[], uri: string): TreeNode | null {
  for (const n of nodes) {
    if (n.uri === uri) return n;
    const found = findInTree(n.children, uri);
    if (found) return found;
  }
  return null;
}

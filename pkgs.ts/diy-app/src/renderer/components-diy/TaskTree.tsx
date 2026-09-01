// src/renderer/components-diy/TaskTree.tsx
// 🎯 任务树 — 表格树 + 拖拽 + 键盘导航 + 展开/折叠
import { useEffect, useCallback, useState, useMemo } from "react";
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
import { cn } from "@/lib/utils";
import { CreateProjectSheet } from "./CreateProjectSheet";
import { CreateTaskSheet } from "./CreateTaskSheet";
import { diyService } from "./lib/rpc";
import { useNotificationStore } from "./store/notificationStore";
import { ChevronRight, ChevronDown } from "lucide-react";

const stateColor: Record<string, string> = {
  pending: "bg-diy-state-pending",
  active: "bg-diy-state-active",
  done: "bg-diy-state-done",
  blocked: "bg-diy-state-blocked",
  cancelled: "bg-diy-state-cancelled",
};

// ═══════════════════════════════════════
// 扁平化树 → 可见行列表
// ═══════════════════════════════════════

interface FlatRow {
  key: string;
  kind: "project" | "task";
  node: TreeNode;
  depth: number;
  projectId: string;
}

function flattenTree(
  nodes: TreeNode[],
  expanded: Set<string>,
  depth = 0,
): FlatRow[] {
  const rows: FlatRow[] = [];
  for (const node of nodes) {
    const key = node.kind === "project" ? `proj:${node.project}` : (node.uri ?? "");
    rows.push({ key, kind: node.kind, node, depth, projectId: node.project ?? "" });
    // 项目默认展开（负逻辑：不在 set=展开，点击折叠加入）；任务默认折叠（在 set=展开）
    const shouldExpand = node.kind === "project"
      ? !expanded.has(key)
      : expanded.has(key);
    if (shouldExpand && node.children.length > 0) {
      rows.push(...flattenTree(node.children, expanded, depth + 1));
    }
  }
  return rows;
}

// ═══════════════════════════════════════
// 主组件
// ═══════════════════════════════════════

export function TaskTree() {
  const { nodes, selectedUri, loading, loadTree, selectTask } = useTaskStore();
  const addToast = useNotificationStore((s) => s.addToast);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 5 } }),
  );

  useEffect(() => { loadTree(); }, []);

  const rows = useMemo(() => flattenTree(nodes, expanded), [nodes, expanded]);
  const selectableKeys = useMemo(
    () => rows.filter((r) => r.kind === "task").map((r) => r.key),
    [rows],
  );

  const toggleExpand = useCallback((key: string) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key); else next.add(key);
      return next;
    });
  }, []);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
      e.preventDefault();
      const cur = selectableKeys.indexOf(selectedUri ?? "");
      const next = e.key === "ArrowDown"
        ? (cur < selectableKeys.length - 1 ? cur + 1 : 0)
        : (cur > 0 ? cur - 1 : selectableKeys.length - 1);
      if (selectableKeys[next]) selectTask(selectableKeys[next]);
    },
    [selectableKeys, selectedUri, selectTask],
  );

  const handleDragStart = (e: DragStartEvent) => setActiveId(String(e.active.id));

  const handleDragEnd = async (e: DragEndEvent) => {
    setActiveId(null);
    const { active, over } = e;
    if (!over || active.id === over.id) return;
    const dragUri = String(active.id);
    const dropUri = String(over.id);
    const dragInfo = findTaskProject(nodes, dragUri);
    const dropInfo = findTaskProject(nodes, dropUri);
    if (!dragInfo || !dropInfo) return;
    if (dragInfo.project !== dropInfo.project) { addToast("error", "只能在同一项目内拖动"); return; }
    if (dropUri === dragInfo.parent) return; // 拖到直接父级：无需改动
    try {
      await diyService.diy.task.move({ uri: dragUri, parent: dropUri });
      await loadTree();
      addToast("success", "已调整层级");
    } catch (err) { addToast("error", `调整失败: ${(err as Error).message}`); }
  };

  return (
    <DndContext sensors={sensors} onDragStart={handleDragStart} onDragEnd={handleDragEnd}>
      <div className="h-full flex flex-col">
        {/* 顶栏 */}
        <div className="flex items-center justify-between px-3 py-1.5 border-b shrink-0">
          <span className="text-sm font-semibold">任务</span>
          <CreateProjectSheet />
        </div>

        {/* 表格树 — 占满全部剩余空间 */}
        <div className="flex-1 overflow-auto min-w-0" tabIndex={0} onKeyDown={handleKeyDown}>
          <table className="w-full text-sm">
            <thead className="sticky top-0 bg-background z-10">
              <tr className="border-b text-left text-muted-foreground">
                <th className="px-2 py-1.5 font-medium w-[50%]">标题</th>
                <th className="px-2 py-1.5 font-medium w-[30%]">URI</th>
                <th className="px-2 py-1.5 font-medium w-[20%]">状态</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) =>
                row.kind === "project" ? (
                  <ProjectRow key={row.key} node={row.node} depth={row.depth} expanded={expanded} onToggle={toggleExpand} />
                ) : (
                  <TaskRow
                    key={row.key}
                    node={row.node}
                    depth={row.depth}
                    projectId={row.projectId}
                    selectedUri={selectedUri}
                    onSelect={selectTask}
                    expanded={expanded}
                    onToggle={toggleExpand}
                  />
                ),
              )}
              {!loading && rows.length === 0 && (
                <tr><td colSpan={3} className="text-center text-muted-foreground py-8">暂无任务</td></tr>
              )}
            </tbody>
          </table>
        </div>
      </div>

      <DragOverlay>
        {activeId ? <DragGhost uri={activeId} nodes={nodes} /> : null}
      </DragOverlay>
    </DndContext>
  );
}

// ═══════════════════════════════════════
// 项目行
// ═══════════════════════════════════════

function ProjectRow({ node, depth, expanded, onToggle }: {
  node: TreeNode; depth: number; expanded: Set<string>; onToggle: (key: string) => void;
}) {
  const hasChildren = node.children.length > 0;
  const key = `proj:${node.project}`;
  const indent = 8 + depth * 20;

  return (
    <tr className="bg-muted/30 hover:bg-muted/50 border-b">
      {/* 标题：缩进 + 箭头 + 图标 + 名称 */}
      <td className="px-2 py-1.5 font-semibold" style={{ paddingLeft: indent + "px" }}>
        <span className="inline-flex items-center gap-1">
          {hasChildren ? (
            <button className="p-0.5 hover:bg-muted rounded shrink-0" onClick={() => onToggle(key)}>
              {expanded.has(key) ? <ChevronRight size={14} /> : <ChevronDown size={14} />}
            </button>
          ) : <span className="w-5" />}
          <span className="mr-1">📁</span>
          <span className="truncate cursor-pointer" onClick={() => onToggle(key)}>{node.title}</span>
        </span>
      </td>
      <td className="px-2 py-1.5 text-muted-foreground font-mono text-xs">{node.project}</td>
      <td />
    </tr>
  );
}

// ═══════════════════════════════════════
// 任务行
// ═══════════════════════════════════════

function TaskRow({ node, depth, projectId, selectedUri, onSelect, expanded, onToggle }: {
  node: TreeNode; depth: number; projectId: string;
  selectedUri: string | null; onSelect: (uri: string | null) => void;
  expanded: Set<string>; onToggle: (key: string) => void;
}) {
  const uri = node.uri ?? "";
  const isSelected = uri === selectedUri;
  const hasChildren = node.children.length > 0;
  const colorClass = node.state ? (stateColor[node.state] ?? "bg-border") : "bg-border";
  const indent = 8 + depth * 20;

  const { attributes, listeners, setNodeRef: setDragRef, isDragging } = useDraggable({ id: uri });
  const { setNodeRef: setDropRef, isOver } = useDroppable({ id: uri });

  return (
    <tr
      ref={(el) => { setDragRef(el); setDropRef(el); }}
      className={cn(
        "border-b cursor-pointer ",
        isSelected && "bg-accent/90",
        isDragging && "opacity-40",
        isOver && "ring-1 ring-primary/50 ring-inset",
      )}
      data-state={isSelected ? "selected" : undefined}
      onClick={() => onSelect(uri)}
      {...listeners}
      {...attributes}
    >
      {/* 标题：缩进 + 箭头 + 状态点 + 文字 */}
      <td className="px-2 py-1.5" style={{ paddingLeft: indent + "px" }}>
        <span className="inline-flex items-center gap-1">
          {hasChildren ? (
            <button
              className="p-0.5 hover:bg-muted rounded shrink-0"
              onClick={(e) => { e.stopPropagation(); onToggle(uri); }}
            >
              {expanded.has(uri) ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
            </button>
          ) : <span className="w-5" />}
          <span className={cn("w-2 h-2 rounded-full inline-block shrink-0", colorClass)} />
          <span className="truncate font-medium">{node.title}</span>
          {node.starred && <span className="text-xs">⭐</span>}
          <CreateTaskSheet projectId={projectId} projectLabel={node.title ?? ""} parentUri={uri} compact />
        </span>
      </td>
      <td className="px-2 py-1.5 text-muted-foreground font-mono text-xs truncate">{uri}</td>
      <td className="px-2 py-1.5 text-xs text-muted-foreground">{node.state}</td>
    </tr>
  );
}

// ═══════════════════════════════════════
// 拖拽浮层
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
// 工具函数
// ═══════════════════════════════════════

function findTaskProject(nodes: TreeNode[], uri: string): { project: string; parent: string | undefined } | null {
  for (const proj of nodes) {
    if (proj.kind !== "project") continue;
    const found = findInTree(proj.children, uri);
    if (found) return { project: proj.project ?? "", parent: found.parentUri };
  }
  return null;
}

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

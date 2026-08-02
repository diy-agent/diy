// src/renderer/components/TaskTree.tsx

import { useEffect } from "react";
import { useTaskStore, type TreeNode } from "./store/taskStore";
import { ScrollArea } from "@/components/ui/scroll-area";
import { cn } from "@/lib/utils";


const stateColor: Record<string, string> = {
  pending: "bg-diy-state-pending",
  active: "bg-diy-state-active",
  done: "bg-diy-state-done",
  blocked: "bg-diy-state-blocked",
  cancelled: "bg-diy-state-cancelled",
};

export function TaskTree() {
  const { nodes, selectedUri, loading, loadTree, selectTask } = useTaskStore();

  useEffect(() => {
    loadTree();
  }, []);



  return (
    <ScrollArea className="h-full">
      <div className="p-1">
        {nodes.map((node) => (
          <SubjectNode
            key={node.subjectPath ?? ""}
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
  );
}

function SubjectNode({
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
      <div className="flex items-center px-2 py-1.5 text-sm font-semibold text-foreground">
        <span className="mr-1.5">📁</span>
        {node.title}
      </div>
      {node.children.map((child) => (
        <TaskRow key={child.uri} node={child} selectedUri={selectedUri} onSelect={onSelect} />
      ))}
    </div>
  );
}

function TaskRow({
  node,
  selectedUri,
  onSelect,
}: {
  node: TreeNode;
  selectedUri: string | null;
  onSelect: (uri: string | null) => void;
}) {
  const isSelected = node.uri === selectedUri;
  const colorClass = node.state ? (stateColor[node.state] ?? "bg-border") : "bg-border";

  return (
    <div
      className={cn(
        "flex items-center px-3 py-1 text-sm cursor-pointer rounded-sm mx-1",
        isSelected ? "bg-accent/20 text-accent-foreground" : "hover:bg-muted",
      )}
      style={{ paddingLeft: 24 + "px" }}
      onClick={() => onSelect(node.uri ?? null)}
    >
      <span className={cn("w-2 h-2 mr-2 rounded-full inline-block", colorClass)} />
      <span className="text-muted-foreground mr-1.5 text-xs font-mono">{node.uri}</span>
      <span className="truncate flex-1">{node.title}</span>
      {node.starred && <span className="text-xs ml-auto">⭐</span>}
    </div>
  );
}

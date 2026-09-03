// @ts-nocheck
import { createSignal } from "solid-js";
import { diyService } from "../lib/rpc";

export interface TreeNode {
  kind: "project" | "task";
  uri?: string;
  title?: string;
  state?: string;
  project?: string;
  parentUri?: string;
  starred: boolean;
  children: TreeNode[];
}

const [nodes, setNodes] = createSignal<TreeNode[]>([]);
const [selectedUri, setSelectedUri] = createSignal<string | null>(null);
const [selectedTask, setSelectedTask] = createSignal<Record<string, unknown> | null>(null);
const [loading, setLoading] = createSignal(false);

async function loadTree() {
  setLoading(true);
  try {
    const n = (await diyService.diy.loadTaskTree({ allTasks: true })) as TreeNode[];
    setNodes(n);
  } finally {
    setLoading(false);
  }
}

async function selectTask(uri: string | null) {
  setSelectedUri(uri);
  setSelectedTask(null);
  if (!uri) return;
  const task = (await diyService.diy.getTask({ uri })) as Record<string, unknown> | null;
  if (task) setSelectedTask(task);
}

// 单例：以「值 getter」暴露信号（组件当值用）。读 taskStore.nodes 即读 nodes()，
// 在 JSX 模板 / createMemo 里读取会追踪该信号 → 响应式保持。
export const taskStore = {
  get nodes() { return nodes(); },
  get selectedUri() { return selectedUri(); },
  get selectedTask() { return selectedTask(); },
  get loading() { return loading(); },
  loadTree,
  selectTask,
};
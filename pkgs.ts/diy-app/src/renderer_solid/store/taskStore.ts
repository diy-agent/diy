import { createSignal } from "solid-js";
import { diyService } from "../lib/rpc";
import { draftStore } from "./draftStore";

export interface TreeNode {
  kind: "project" | "task";
  uri?: string;
  /** 任务号（uri 末段，项目内自增；跨项目会重号）。由 main 的 task-tree 回填。 */
  num?: string;
  title?: string;
  state?: string;
  project?: string;
  project_path?: string;
  project_label?: string;
  parentUri?: string;
  children: TreeNode[];
}

export interface TaskDetail {
  uri: string;
  title?: string;
  state?: string;
  project?: string;
  project_path?: string;
  project_label?: string;
  parent?: string;
  detail?: string;
  body?: string;
  created?: string;
  updated?: string;
  /** 未提交草稿（main 的 getTask/task.show 随任务一起返回，见 core/drafts.ts） */
  ui_drafts?: { base_updated?: string; saved?: string; fields: Record<string, string> } | null;
}

const [nodes, setNodes] = createSignal<TreeNode[]>([]);
const [selectedUri, setSelectedUri] = createSignal<string | null>(null);
const [selectedTask, setSelectedTask] = createSignal<TaskDetail | null>(null);
const [loading, setLoading] = createSignal(false);

async function loadTree() {
  setLoading(true);
  try {
    const r = await diyService.diy.loadTaskTree({});
    setNodes(r.data);
  } finally {
    setLoading(false);
  }
}

async function selectTask(uri: string | null) {
  setSelectedUri(uri);
  setSelectedTask(null);
  if (!uri) return;
  const r = await diyService.diy.getTask({ uri });
  if (!r.data) return;
  // 草稿先灌入再放行任务：详情面板是「选中任务即创建」的组件，构造时就要读到草稿
  // 来判定是否恢复编辑态；反过来则会以「无草稿」初始化，表现为草稿丢失。
  draftStore.seed(uri, r.data.ui_drafts ?? null, r.data.updated);
  setSelectedTask(r.data);
}

async function setState(uri: string, state: string) {
  await diyService.diy.task.edit({ uri, state: state as any, title: undefined, detail: undefined, body: undefined, parent: undefined });
  await loadTree();
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
  setState,
};
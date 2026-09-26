import { createSignal } from "solid-js";
import { diyService } from "../lib/rpc";
import type { TaskDetail as ContractTaskDetail } from "../../shared/task-detail";
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

/**
 * 任务详情 —— 直接取 **RPC 契约的类型**（shared/task-detail.ts 的 TaskDetailSchema）。
 *
 * 为什么不再手抄一份 interface（真实教训）：这里曾经逐字段抄一遍，于是"契约加了字段、
 * 这里忘了抄"就成了静默缺陷 —— 类型检查不会报（字段可选），界面只是显示不出来。
 * 语料：change_type / module / priority / persona 都发生过（详情面板显示"未设置"，
 * 而数据其实好好的）。用契约类型后不可能滞后：契约加字段这里自动有，加错会直接编译失败。
 */
export type TaskDetail = ContractTaskDetail;

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


/**
 * 重新拉当前任务详情（改了任务字段后用，如切换 agent 人物）。
 * 与 selectTask 的差别：不清空选中的任务（不闪空态），也不动 uri。
 * 期间用户切了任务就丢弃结果，避免把 A 的旧数据写回 B。
 */
async function refreshSelected(): Promise<void> {
  const u = selectedUri();
  if (!u) return;
  const r = await diyService.diy.getTask({ uri: u });
  if (!r.data || r.data.uri !== selectedUri()) return;
  draftStore.seed(u, r.data.ui_drafts ?? null, r.data.updated);
  setSelectedTask(r.data);
}

async function setState(uri: string, state: string) {
  await diyService.diy.task.edit({ uri, state: state as any, title: undefined, body: undefined, parent: undefined, persona: undefined });
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
  refreshSelected,
  setState,
};
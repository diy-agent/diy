import type { StreamHandle } from "@diy/rpc";

export interface AgentChatParams {
  model: string;
  messages: Array<{ role: string; content: string }>;
}
export interface AgentChatResult {
  role: string;
  content: string;
}
export interface AgentModel {
  id: string;
  name: string;
}
export interface AgentStatusResult {
  agentId: string;
  state: string;
  model?: string;
}

export interface TaskCreateParams {
  title: string;
  subject: string;
  parent?: string;
  detail?: string;
  body?: string;
}
export interface TaskCreateResult {
  status: string;
  data: { uri: string };
}
export interface TaskListResult {
  status: string;
  data: { tasks: string[] };
}
export interface TaskShowResult {
  status: string;
  data?: unknown;
  msg?: string;
}
export interface TaskEditResult {
  status: string;
  data: { uri: string };
}
export interface TaskDeleteResult {
  status: string;
  data: { uri: string };
}
export interface TaskStarResult {
  status: string;
  data: { uri: string; starred: boolean };
}

export interface SubjectAddResult {
  status: string;
  data: { path: string };
}
export interface SubjectListResult {
  status: string;
  data: { subjects: Array<{ path: string; info: { label?: string } }> };
}
export interface SubjectRemoveResult {
  status: string;
  data: { path: string };
}

export interface UiTreeResult {
  status: string;
  data: string;
}
export interface UiStatusResult {
  status: string;
  data: { pid: number; uptime: number; memory: number };
}
export interface UiToastResult {
  status: string;
  data: { message: string; level: string };
  meta: { pushedToGui: boolean };
}
export interface UiNavigateResult {
  status: string;
  data: { page: string };
  meta: { pushedToGui: boolean };
}
export interface UiFocusResult {
  status: string;
  data: { uri: string };
  meta: { pushedToGui: boolean };
}

export interface DoctorResult {
  status: string;
  data: unknown;
}

export interface LlmProxyStatus {
  running: boolean;
  port: number;
}

export interface ClientApi {
  task: {
    create(params: TaskCreateParams): Promise<TaskCreateResult>;
    list(params?: { subject?: string }): Promise<TaskListResult>;
    show(params: { uri: string }): Promise<TaskShowResult>;
    edit(params: { uri: string; title?: string; state?: string; detail?: string }): Promise<TaskEditResult>;
    delete(params: { uri: string }): Promise<TaskDeleteResult>;
    star(params: { uri: string }): Promise<TaskStarResult>;
    unstar(params: { uri: string }): Promise<TaskStarResult>;
  };

  subject: {
    add(params: { path: string; label?: string }): Promise<SubjectAddResult>;
    list(): Promise<SubjectListResult>;
    remove(params: { path: string }): Promise<SubjectRemoveResult>;
  };

  ui: {
    tree(params?: { all?: boolean }): Promise<UiTreeResult>;
    status(): Promise<UiStatusResult>;
    navigate(params: { page: string }): Promise<UiNavigateResult>;
    focus(params: { uri: string }): Promise<UiFocusResult>;
    toast(params: { message: string; level?: string }): Promise<UiToastResult>;
  };

  doctor(): Promise<DoctorResult>;

  loadTaskTree(params?: { allTasks?: boolean }): Promise<unknown>;
  getTask(params: { uri: string }): Promise<unknown>;

  agent: {
    chat(params: AgentChatParams): Promise<AgentChatResult>;
    chatStream(params: AgentChatParams): Promise<StreamHandle<string>>;
    listModels(): Promise<AgentModel[]>;
    status(params: { agentId: string }): Promise<AgentStatusResult>;
  };

  llmProxy: {
    status(): Promise<LlmProxyStatus>;
    start(): Promise<{ status: string }>;
    stop(): Promise<{ status: string }>;
  };

  log: {
    read(params?: { limit?: number }): Promise<Array<Record<string, unknown>>>;
  };
}

import type { Transport, StreamHandle } from "@diy/rpc";
import { RawClient } from "@diy/rpc";
import type { ClientApi } from "../../../shared/client";

declare global {
  interface Window {
    transport: Transport;
  }
}

function makeClient(): ClientApi {
  const cli = new RawClient(window.transport);

  const s = (method: string) => (input: unknown) =>
    cli.serverStream(method, { input, meta: {} }) as Promise<StreamHandle<string>>;

  return {
    // 任务
    task: {
      create: (p) => cli.invoke("task.create", { input: p, meta: {} }),
      list: (p?) => cli.invoke("task.list", { input: p ?? {}, meta: {} }),
      show: (p) => cli.invoke("task.show", { input: p, meta: {} }),
      edit: (p) => cli.invoke("task.edit", { input: p, meta: {} }),
      delete: (p) => cli.invoke("task.delete", { input: p, meta: {} }),
      star: (p) => cli.invoke("task.star", { input: p, meta: {} }),
      unstar: (p) => cli.invoke("task.unstar", { input: p, meta: {} }),
    },

    // Subject
    subject: {
      add: (p) => cli.invoke("subject.add", { input: p, meta: {} }),
      list: () => cli.invoke("subject.list", { input: {}, meta: {} }),
      remove: (p) => cli.invoke("subject.remove", { input: p, meta: {} }),
    },

    // UI
    ui: {
      tree: (p?) => cli.invoke("ui.tree", { input: p ?? {}, meta: {} }),
      status: () => cli.invoke("ui.status", { input: {}, meta: {} }),
      navigate: (p) => cli.invoke("ui.navigate", { input: p, meta: {} }),
      focus: (p) => cli.invoke("ui.focus", { input: p, meta: {} }),
      toast: (p) => cli.invoke("ui.toast", { input: p, meta: {} }),
    },

    // Doctor
    doctor: () => cli.invoke("doctor", { input: {}, meta: {} }),

    // 任务树 / 任务数据
    loadTaskTree: (p?) => cli.invoke("loadTaskTree", { input: p ?? {}, meta: {} }),
    getTask: (p) => cli.invoke("getTask", { input: p, meta: {} }),

    // Agent
    agent: {
      chat: (p) => cli.invoke("agent.chat", { input: p, meta: {} }),
      chatStream: s("agent.chatStream"),
      listModels: () => cli.invoke("agent.listModels", { input: {}, meta: {} }),
      status: (p) => cli.invoke("agent.status", { input: p, meta: {} }),
    },

    // LLM 代理
    llmProxy: {
      status: () => cli.invoke("llmProxy.status", { input: {}, meta: {} }),
      start: () => cli.invoke("llmProxy.start", { input: {}, meta: {} }),
      stop: () => cli.invoke("llmProxy.stop", { input: {}, meta: {} }),
    },

    // 日志
    log: {
      read: (p?) => cli.invoke("log.read", { input: p ?? {}, meta: {} }),
    },
  };
}

export const diyService: ClientApi = makeClient();

import { create } from "zustand";
import { diyService } from "../lib/rpc";

export interface ChatMessage {
  role: "user" | "assistant";
  content: string;
}

interface AgentState {
  models: Array<{ id: string; name: string }>;
  activeModel: string | null;
  messages: ChatMessage[];
  sending: boolean;
  error: string | null;
  streamingContent: string;
  autoApprove: boolean;

  loadModels: () => Promise<void>;
  /** 向主进程查询该 task 会话的真实模型；无会话则清空选择 */
  syncStatus: (taskUri: string) => Promise<void>;
  setModel: (id: string) => void;
  sendMessage: (taskUri: string, content: string) => Promise<void>;
  clearChat: () => void;
  loadAutoApprove: () => Promise<void>;
  setAutoApprove: (enabled: boolean) => Promise<void>;
  closeSession: (taskUri: string) => Promise<void>;
  switchModel: (taskUri: string, modelId: string) => Promise<void>;
}

export const useAgentStore = create<AgentState>((set, get) => ({
  models: [],
  activeModel: null,
  messages: [],
  sending: false,
  error: null,
  streamingContent: "",
  autoApprove: true,

  loadModels: async () => {
    try {
      // React 遗留面板（仅参考）：新 RPC 按任务读快照，无任务传空串回空列表
      const result = await diyService.diy.agent.listModels({ taskUri: "" });
      // 不再拿 result[0] 伪造「当前模型」：那不是真实状态，且发消息时会把这个假默认值
      // 真的切换过去。activeModel 只能来自 syncStatus 或用户显式选择。
      const stillValid = get().activeModel && result.some((m) => m.id === get().activeModel);
      set({ models: result, activeModel: stillValid ? get().activeModel : null });
    } catch (e) {
      set({ error: e instanceof Error ? e.message : "加载模型失败" });
    }
  },

  syncStatus: async (taskUri: string) => {
    try {
      const st = await diyService.diy.agent.status({ taskUri });
      // no_session：还没对话过，没有「当前模型」可言 → 让 UI 显示占位项
      set({ activeModel: st.state === "ready" ? (st.model ?? null) : null });
    } catch {
      /* 查不到就维持现状，不弹错误打扰用户 */
    }
  },

  setModel: (id) => set({ activeModel: id }),

  loadAutoApprove: async () => {
    try {
      const result = await diyService.diy.agent.getAutoApprove({});
      set({ autoApprove: result.enabled });
    } catch {
      // 静默失败
    }
  },

  setAutoApprove: async (enabled: boolean) => {
    try {
      await diyService.diy.agent.setAutoApprove({ enabled });
      set({ autoApprove: enabled });
    } catch (e) {
      set({ error: e instanceof Error ? e.message : "设置失败" });
    }
  },

  closeSession: async (taskUri: string) => {
    try {
      await diyService.diy.agent.closeSession({ taskUri });
      // 会话已销毁 → 当前模型不再存在，必须清空，否则界面会挂着个无意义的选择
      set({ messages: [], error: null, streamingContent: "", activeModel: null });
    } catch (e) {
      set({ error: e instanceof Error ? e.message : "关闭会话失败" });
    }
  },

  switchModel: async (taskUri: string, modelId: string) => {
    try {
      await diyService.diy.agent.setModel({ taskUri, model: modelId });
      set({ activeModel: modelId });
      // 以主进程回报为准复核（agent 可能接受但未真正生效）
      await get().syncStatus(taskUri);
    } catch (e) {
      // 失败后回落到服务端真实值，避免界面显示一个没切成功的模型
      await get().syncStatus(taskUri);
      set({ error: e instanceof Error ? e.message : "切换模型失败" });
    }
  },

  sendMessage: async (taskUri: string, content: string) => {
    const { activeModel, messages } = get();
    // activeModel 允许为空：留空即「不指定，用 agent 自己的默认模型」，
    // 主进程 streamChat 对空 model 会跳过 setModel。

    const userMsg: ChatMessage = { role: "user", content };
    const updated = [...messages, userMsg];
    set({ messages: updated, sending: true, error: null, streamingContent: "" });

    try {
      const handle = await diyService.diy.agent.chatStream({
        taskUri,
        model: activeModel ?? "",
        messages: updated.map((m) => ({ role: m.role, content: m.content })),
      });

      set((s) => ({ messages: [...s.messages, { role: "assistant", content: "" }] }));

      let fullContent = "";
      for await (const delta of handle) {
        fullContent += delta;
        set((s) => {
          const msgs = [...s.messages];
          msgs[msgs.length - 1] = { role: "assistant", content: fullContent };
          return { messages: msgs, streamingContent: fullContent };
        });
      }
      set({ sending: false, streamingContent: "" });
      // 首轮对话会建出会话，此时才查得到真实模型
      void get().syncStatus(taskUri);
    } catch (e) {
      set({
        error: e instanceof Error ? e.message : "发送失败",
        sending: false,
        streamingContent: "",
      });
      void get().syncStatus(taskUri);
    }
  },

  clearChat: () => set({ messages: [], error: null, streamingContent: "" }),
}));

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

  loadModels: () => Promise<void>;
  setModel: (id: string) => void;
  sendMessage: (taskUri: string, content: string) => Promise<void>;
  clearChat: () => void;
}

export const useAgentStore = create<AgentState>((set, get) => ({
  models: [],
  activeModel: null,
  messages: [],
  sending: false,
  error: null,
  streamingContent: "",

  loadModels: async () => {
    try {
      const result = await diyService.diy.agent.listModels({});
      set({ models: result, activeModel: result[0]?.id ?? null });
    } catch (e) {
      set({ error: e instanceof Error ? e.message : "加载模型失败" });
    }
  },

  setModel: (id) => set({ activeModel: id }),

  sendMessage: async (taskUri: string, content: string) => {
    const { activeModel, messages } = get();
    if (!activeModel) return;

    const userMsg: ChatMessage = { role: "user", content };
    const updated = [...messages, userMsg];
    set({ messages: updated, sending: true, error: null, streamingContent: "" });

    try {
      const handle = await diyService.diy.agent.chatStream({
        taskUri,
        model: activeModel,
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
    } catch (e) {
      set({
        error: e instanceof Error ? e.message : "发送失败",
        sending: false,
        streamingContent: "",
      });
    }
  },

  clearChat: () => set({ messages: [], error: null, streamingContent: "" }),
}));

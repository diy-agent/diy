// @ts-nocheck
import { createSignal } from "solid-js";
import { diyService } from "../lib/rpc";

export interface ChatMessage { role: "user" | "assistant"; content: string; }

const [models, setModels] = createSignal<Array<{ id: string; name: string }>>([]);
const [activeModel, setActiveModel] = createSignal<string | null>(null);
const [messages, setMessages] = createSignal<ChatMessage[]>([]);
const [sending, setSending] = createSignal(false);
const [error, setError] = createSignal<string | null>(null);

export const agentStore = {
  get models() { return models(); },
  get activeModel() { return activeModel(); },
  get messages() { return messages(); },
  get sending() { return sending(); },
  get error() { return error(); },
  loadModels: async () => {
    try {
      const r: any = await diyService.diy.agent.listModels({});
      setModels(r);
      setActiveModel(r?.[0]?.id ?? null);
    } catch (e) { setError(e instanceof Error ? e.message : "加载模型失败"); }
  },
  setModel: (id: string) => setActiveModel(id),
  sendMessage: async (content: string) => {
    const m = activeModel();
    if (!m) return;
    const userMsg: ChatMessage = { role: "user", content };
    setMessages((p) => [...p, userMsg]);
    setSending(true); setError(null);
    try {
      const handle: any = await diyService.diy.agent.chatStream({ model: m, messages: [...messages()].map((x) => ({ role: x.role, content: x.content })) });
      setMessages((p) => [...p, { role: "assistant", content: "" }]);
      let full = "";
      for await (const delta of handle) {
        full += delta;
        setMessages((p) => { const a = [...p]; a[a.length - 1] = { role: "assistant", content: full }; return a; });
      }
      setSending(false);
    } catch (e) { setError(e instanceof Error ? e.message : "发送失败"); setSending(false); }
  },
  clearChat: () => { setMessages([]); setError(null); },
};
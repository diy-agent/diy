import { createSignal } from "solid-js";
import { diyService } from "../lib/rpc";

export interface ChatMessage { role: "user" | "assistant"; content: string; }

const [models, setModels] = createSignal<Array<{ id: string; name: string }>>([]);
const [activeModel, setActiveModel] = createSignal<string | null>(null);
const [messages, setMessages] = createSignal<ChatMessage[]>([]);
const [sending, setSending] = createSignal(false);
const [error, setError] = createSignal<string | null>(null);
const [autoApprove, setAutoApproveSignal] = createSignal(true);

export const agentStore = {
  get models() { return models(); },
  get activeModel() { return activeModel(); },
  get messages() { return messages(); },
  get sending() { return sending(); },
  get error() { return error(); },
  get autoApprove() { return autoApprove(); },
  loadModels: async (refresh = false) => {
    try {
      const r = await diyService.diy.agent.listModels({ refresh });
      setModels(r);
      // 不再拿 result[0] 伪造「当前模型」：那不是真实状态，且发消息时会把这个假默认值
      // 真的切换过去。activeModel 只能来自 syncStatus 或用户显式选择。
      const stillValid = activeModel() && r.some((m) => m.id === activeModel());
      if (!stillValid) setActiveModel(null);
    } catch (e) { setError(e instanceof Error ? e.message : "加载模型失败"); }
  },

  /** 向主进程查询该 task 会话的真实模型；无会话则清空选择 */
  syncStatus: async (taskUri: string) => {
    try {
      const st = await diyService.diy.agent.status({ taskUri });
      setActiveModel(st.state === "ready" ? (st.model ?? null) : null);
    } catch { /* 查不到就维持现状 */ }
  },

  setModel: (id: string) => setActiveModel(id),

  switchModel: async (taskUri: string, modelId: string) => {
    try {
      await diyService.diy.agent.setModel({ taskUri, model: modelId });
      setActiveModel(modelId);
      await agentStore.syncStatus(taskUri);
    } catch (e) {
      await agentStore.syncStatus(taskUri);
      setError(e instanceof Error ? e.message : "切换模型失败");
    }
  },

  sendMessage: async (taskUri: string, content: string) => {
    const m = activeModel();
    // activeModel 允许为空：留空即「不指定，用 agent 自己的默认模型」，
    // 主进程 streamChat 对空 model 会跳过 setModel。
    const userMsg: ChatMessage = { role: "user", content };
    setMessages((p) => [...p, userMsg]);
    setSending(true); setError(null);
    try {
      const handle = await diyService.diy.agent.chatStream({
        taskUri,
        model: m ?? "",
        messages: [...messages()].map((x) => ({ role: x.role, content: x.content })),
      });
      setMessages((p) => [...p, { role: "assistant", content: "" }]);
      let full = "";
      for await (const delta of handle) {
        full += delta;
        setMessages((p) => { const a = [...p]; a[a.length - 1] = { role: "assistant", content: full }; return a; });
      }
      setSending(false);
      void agentStore.syncStatus(taskUri);
    } catch (e) { setError(e instanceof Error ? e.message : "发送失败"); setSending(false); }
  },

  loadAutoApprove: async () => {
    try {
      const r = await diyService.diy.agent.getAutoApprove({});
      setAutoApproveSignal(r.enabled);
    } catch { /* 静默 */ }
  },

  setAutoApprove: async (enabled: boolean) => {
    try {
      await diyService.diy.agent.setAutoApprove({ enabled });
      setAutoApproveSignal(enabled);
    } catch (e) { setError(e instanceof Error ? e.message : "设置失败"); }
  },

  closeSession: async (taskUri: string) => {
    try {
      await diyService.diy.agent.closeSession({ taskUri });
      // 会话已销毁 → 当前模型不再存在，必须清空
      setMessages([]); setError(null); setActiveModel(null);
    } catch (e) { setError(e instanceof Error ? e.message : "关闭会话失败"); }
  },

  clearChat: () => { setMessages([]); setError(null); },
};
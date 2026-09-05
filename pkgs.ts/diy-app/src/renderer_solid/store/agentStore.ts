/**
 * agentStore — Agent 全局设置（模型列表 / 自动审批）
 *
 * 与 chatStore 的分工：agentStore 只放 agent 级、与具体会话无关的设置；
 * 会话级状态（消息/发送中/当前模型）全部在 chatStore，避免双轨分裂。
 * 以前 agentStore 还重复维护 messages/sending/error/activeModel，
 * 与 chatStore 各写各的：ChatPage 的模型下拉写的是 agentStore.activeModel，
 * 而 chatStore.sendMessage 读的是 chatStore.activeModel —— 切换模型根本无效。
 * 现在 activeModel 唯一真相源在 chatStore。
 */

import { createSignal } from "solid-js";
import { diyService } from "../lib/rpc";

const [models, setModels] = createSignal<Array<{ id: string; name: string }>>([]);
const [autoApprove, setAutoApproveSignal] = createSignal(true);

export const agentStore = {
  get models() { return models(); },
  get autoApprove() { return autoApprove(); },

  /**
   * 加载模型列表（读任务会话快照；进入详情即建会话，无 probe）。
   * 会话尚未建好时回空列表，调用方（ensureSession 之后调）保证顺序。
   */
  loadModels: async (taskUri: string) => {
    try {
      const r = await diyService.diy.agent.listModels({ taskUri });
      setModels(r);
    } catch (e) {
      console.warn("[agentStore] 加载模型失败:", e);
    }
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
    } catch (e) {
      console.warn("[agentStore] 设置自动审批失败:", e);
    }
  },
};
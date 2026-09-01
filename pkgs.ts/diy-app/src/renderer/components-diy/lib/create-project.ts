// src/renderer/components-diy/lib/create-project.ts
// renderer 侧创建项目：反向调 main 写数据 + 刷新任务树 + toast。
// UI 的「创建项目」按钮和 ui.project.create RPC 共用此入口 ——
// 保证"app 里点创建"与"CLI 驱动创建"走同一套逻辑，便于 cli→ui 意图测试。
import { diyService } from "./rpc";
import { useTaskStore } from "../store/taskStore";
import { useNotificationStore } from "../store/notificationStore";

/**
 * 创建项目并让 UI 反映结果。
 * 返回 main 生成的项目 id；失败时抛错（由调用方 toast）。
 */
export async function createProjectViaUi(
  path: string,
  label?: string,
  desc?: string,
): Promise<string> {
  const r = await diyService.diy.project.create({ path, label, desc, state: undefined });
  const id = r.data.id;
  await useTaskStore.getState().loadTree();
  useNotificationStore.getState().addToast("success", `已创建项目 #${id}`);
  return id;
}
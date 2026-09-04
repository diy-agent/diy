// src/renderer/components-diy/lib/create-task.ts
// renderer 侧创建任务：反向调 main 写数据 + 刷新任务树 + toast。
// UI 的「新增任务」按钮（CreateTaskSheet）和 ui.task.create RPC 共用此入口 ——
// 保证"app 里点新增"与"CLI 驱动新增"走同一套逻辑，便于 cli→ui 意图测试。
import { diyService } from "./rpc";
import { useTaskStore } from "../store/taskStore";
import { useNotificationStore } from "../store/notificationStore";

/**
 * 创建任务并让 UI 反映结果。
 * 返回 main 生成的任务 URI；失败时抛错（由调用方 toast）。
 */
export async function createTaskViaUi(
  title: string,
  project: string,
  parent?: string,
): Promise<string> {
  const r = await diyService.diy.task.create({ title, project, parent: parent ?? undefined, detail: undefined, body: undefined });
  const uri = r.data.uri;
  await useTaskStore.getState().loadTree();
  useNotificationStore.getState().addToast("success", parent ? "子任务已创建" : "任务已创建");
  return uri;
}

// @ts-nocheck
import { diyService } from "./rpc";
import { taskStore } from "../store/taskStore";
import { notificationStore } from "../store/notificationStore";

export interface CreateTaskViaUiInput {
  title: string;
  project?: string;
  parent?: string;
  detail?: string;
  body?: string;
}

/** 创建任务（UI 入口）：与「项目行 ＋ 添加任务」按钮共用同一套逻辑。
 *  反向调 main 写数据 + 刷新任务树 + toast。 */
export async function createTaskViaUi(input: CreateTaskViaUiInput): Promise<string> {
  const r: any = await diyService.diy.task.create({
    title: input.title,
    project: input.project,
    parent: input.parent,
    detail: input.detail,
    body: input.body,
  });
  const uri: string = r?.data?.uri;
  await taskStore.loadTree();
  notificationStore.addToast("success", input.parent ? "子任务已创建" : "任务已创建");
  return uri;
}

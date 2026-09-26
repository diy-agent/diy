import { diyService } from "./rpc";
import { taskStore } from "../store/taskStore";
import { notificationStore } from "../store/notificationStore";

export interface CreateTaskViaUiInput {
  title: string;
  project: string;
  parent?: string;
  body?: string;
  /** 结构化字段：可在创建时就指定（不传 = 未设置，之后再在详情面板填） */
  change_type?: string;
  module?: string;
  priority?: string;
}

/** 创建任务（UI 入口）：与「项目行 ＋ 添加任务」按钮共用同一套逻辑。
 *  反向调 main 写数据 + 刷新任务树 + toast。 */
export async function createTaskViaUi(input: CreateTaskViaUiInput): Promise<string> {
  const r = await diyService.diy.task.create({
    title: input.title,
    project: input.project,
    parent: input.parent,
    body: input.body,
    change_type: input.change_type as never,
    module: input.module,
    priority: input.priority as never,
  });
  const uri: string = r?.data?.uri;
  await taskStore.loadTree();
  notificationStore.addToast("success", input.parent ? "子任务已创建" : "任务已创建");
  return uri;
}

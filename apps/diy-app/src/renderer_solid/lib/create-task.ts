import { diyService } from "./rpc";
import { taskStore } from "../store/taskStore";
import { taskCreatedNotice } from "./notice-entity";
import { notificationStore } from "../store/notificationStore";

export interface CreateTaskViaUiInput {
  title: string;
  project: string;
  parent?: string;
  body?: string;
  /** agent 人物名：不传 = 当前缺省人物（人物决定模型/参数/行为指令，见 shared/persona.ts） */
  persona?: string;
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
    // 正文的"传文件"形态是 CLI 侧能力（##376）；契约为「键必须出现」，故显式给 undefined
    bodyText: undefined,
    bodyFile: undefined,
    persona: input.persona,
    change_type: input.change_type as never,
    module: input.module,
    priority: input.priority as never,
    // CLI 专属字段（##430）：cwd 由 parser 自动注入、force 是归属拦截的逃生口。
    // UI 侧本来就看得见「项目」，不参与归属检测，故显式给 undefined（契约要求键出现）。
    cwd: undefined,
    force: undefined,
  });
  const uri: string = r?.data?.uri;
  await taskStore.loadTree();
  notificationStore.addToast(
    "success",
    input.parent ? "子任务已创建" : "任务已创建",
    taskCreatedNotice({ uri, parent: input.parent, project: input.project }),
  );
  return uri;
}

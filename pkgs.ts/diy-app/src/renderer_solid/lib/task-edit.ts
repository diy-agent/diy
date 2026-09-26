// src/renderer_solid/lib/task-edit.ts
// 🎯 编辑任务的**唯一入口**：补全 RPC 契约要求的字段。
//
// 为什么需要这一层：`diy.task.edit` 的 input schema 里每个字段都是「可选的，但键必须出现」
// （zod .optional() 生成 `T | undefined` 的必填键）。于是每个调用点都得写满
// `title: undefined, state: undefined, body: undefined, parent: undefined, …`，
// 加一个字段要在 N 处补 N 个 undefined —— 漏一处就是编译错误，改起来纯噪音。
// 收敛到这里后：新增字段只改本文件的 EMPTY_EDIT。
//
// 语义提醒：**未指定 = 保持原值**，空字符串 = 清除该字段（见 core/task.ts 的 triState）。

import { diyService } from "./rpc";

type TaskEditInput = Parameters<typeof diyService.diy.task.edit>[0];
/** 只传要改的字段：契约里每个键都是必填（值可为 undefined），这里全改可选（见文件头说明） */
export type TaskEditPatch = { [K in keyof Omit<TaskEditInput, "uri">]?: TaskEditInput[K] };

/**
 * 编辑任务（只传要改的字段；未传的字段保持原值）。
 * 注意入参是**逐字段列出**而不是 `{...patch}` 展开：RPC input 是「可选的、但键必须出现」，
 * 展开写法在类型上无法保证所有键都在（TS 会报缺键）。新增字段时这里补一行。
 */
export async function editTask(uri: string, patch: TaskEditPatch): Promise<void> {
  await diyService.diy.task.edit({
    uri,
    title: patch.title,
    state: patch.state,
    body: patch.body,
    parent: patch.parent,
    change_type: patch.change_type,
    module: patch.module,
    priority: patch.priority,
  });
}

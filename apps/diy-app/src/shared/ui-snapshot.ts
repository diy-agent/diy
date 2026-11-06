/**
 * shared/ui-snapshot.ts — UI 快照（`ui.state` 单读 / `ui.watch.uiState` 流共用）
 */
import { z } from "zod";
import { TaskNodeSchema } from "./task-node";

export const UiSnapshotData = z.object({
  rev: z.number().describe("UI 快照序号（每次渲染提交递增；通用屏障）"),
  uiRev: z.number().describe("本地 UI 状态版本（tab/页面/选中 变化递增）"),
  dataRev: z.number().describe("数据版本（任务树等来自 main 的数据变化递增；跨进程链的终点）"),
  active: z.string().describe('当前激活 tab key；"" = 任务管理页'),
  tabs: z.array(z.object({
    key: z.string(),
    pageId: z.string(),
    ctx: z.string().nullable(),
    indent: z.number().describe("任务层次缩进（祖先链长度）"),
  })),
  selectedUri: z.string().nullable().describe("任务树当前选中任务 uri"),
  tree: z.object({
    count: z.number().describe("任务数（递归展开任务节点后的数量）"),
    sig: z.string().describe("任务 uri+状态+标题 排序签名（消费端可比对，不需解析 DOM）"),
    loading: z.boolean(),
  }),
});

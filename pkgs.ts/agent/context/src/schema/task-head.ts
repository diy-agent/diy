// src/shared/task-head.ts
// 🎯 任务头字段清单的**单一真源**（##322 review R3）。
//
// 为什么要单一真源：同一份清单此前在**三处**手抄（系统上下文变量 `task.*` / 上下文变量 schema /
// 投递候选名单）。漏一处就是三种病之一 —— 「上下文里没有该字段」/「schema 校验失败」/
// 「投递名单漏项（两份容器都不投）」，而漏的地方不一样、症状各不相同、都难查。故收成一份：
//   · 值     → `main/services/prompt-registry.ts::taskOf`
//   · schema → `shared/prompt-schema.ts`（本清单 → zod 形状）
//   · 投递   → `shared/context/delivery.ts::PLACE_CANDIDATES`（reason 逐键必填）
// 新增一个头字段：改本文件一处（外加写入侧真正落盘的 setOrClear）。
//
// ⚠️ 本文件**必须零依赖**（不 import zod / node / 本包任何模块）—— 不是洁癖，是构建的硬要求：
//   main 的产物按 chunk 切分，**被多个 chunk 共用的模块会提升成独立 chunk，先于入口模块体求值**；
//   而 `_cli-meta.ts` 的 `z.ZodType.prototype.cliArg/cliOption` 补丁**必须在任何 schema 创建之前执行**
//   （zod v4 的 schema 实例在创建时就把原型链定死，事后打补丁看不见 —— 见 `pit.zod-cli-meta-order`）。
//   本文件若带 zod 或牵进 `main/core/task-state.ts`，就会把后者拖成共享 chunk → 启动即
//   `TypeError: TaskStateSchema.cliArg is not a function`。
// 判据：清单归本文件，**zod 形状归消费方**（prompt-schema 自己把清单映射成 z.string()）。

/** 任务头字段（key = 文件 frontmatter 里的键；desc = 上下文变量 schema 的描述） */
export const TASK_HEAD_FIELDS = [
  { key: "title", desc: "标题" },
  { key: "state", desc: "状态" },
  { key: "parent", desc: "父任务 URI（空 = 无父）" },
  { key: "created", desc: "创建时间（ISO）" },
  { key: "updated", desc: "最后编辑时间（ISO）——任何一次编辑都会刷新" },
  { key: "change_type", desc: "变更性质（feat/fix/…；空 = 未设置）" },
  { key: "module", desc: "模块（可 `/` 分层；空 = 未设置）" },
  { key: "priority", desc: "优先级 P0-P3（空 = 未定级）" },
  { key: "persona", desc: "绑定的人物 id（空 = 跟随缺省人物）" },
] as const;
export type TaskHeadField = (typeof TASK_HEAD_FIELDS)[number]["key"];

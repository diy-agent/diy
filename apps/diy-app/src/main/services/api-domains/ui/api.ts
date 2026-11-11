/**
 * api-domains/ui/api.ts —— 从 services/api-def.ts 拆出。
 */
import { z } from "zod";
import { RpcSchema, defineService } from "@diy-agent/rpc";
import { StatusDataUri, StatusDataId } from "../../../../shared/status";
import { TaskStateSchema } from "../../../core/task-state";
import { TaskNodeSchema } from "../../../../shared/task-node";
import { UiSnapshotData } from "../../../../shared/ui-snapshot";

export const uiRoutes = RpcSchema.group({desc: `Renderer 进程域`,
        children: {
          /** 列出当前页面所有可用 UI 组件 */
          component: RpcSchema.group({
            desc: `组件`,
            children: {
              list: RpcSchema.unary({
                desc: `列出 UI 组件`,
                input: {},
                output: z.object({
                  status: z.string(),
                  data: z.object({
                    components: z.array(z.object({
                      name: z.string(),
                      label: z.string(),
                      description: z.string().optional(),
                    })),
                  }),
                }),
              }),

              /** 查询组件当前状态（参数因组件而异） */
              status: RpcSchema.unary({
                desc: `查询组件状态`,
                input: { name: z.string().describe('组件名称') },
                output: z.object({
                  status: z.string(),
                  data: z.object({
                    visible: z.boolean(),
                    state: z.string().optional(),
                  }),
                }),
              }),
            },
          }),

          /**
           * 布局（layout）的读 / 写。
           *
           * 为什么要这个出口：布局的用户态（区段尺寸 / 哪些 area 收起 / 哪个最大化 /
           * 哪些 view 隐藏）原本只活在 renderer 的 localStorage 里，CLI 读不到也改不了 ——
           * 于是「设成某种布局再验证」只能手点，意图测试也只能去数 DOM 像素。
           *
           * 写入的是**偏离默认的那部分**（patch 语义），不是整份文档：
           * 调用方只说自己关心的字段，其余保持用户现值。`reset` 才回到开发者默认。
           *
           * ⚠️ 分层：**几何**（track 尺寸 / area 开合 / 最大化）按 page 共享 —— 所有任务
           * 的 task-run tab 用同一套；**view 的显隐**（hiddenViews）按 page 实例（带 ctx）。
           * 故 get 收 ctx 只为过滤 hiddenViews，set 不收 ctx。
           */
          layout: RpcSchema.group({
            desc: `布局`,
            children: {
              get: RpcSchema.unary({
                desc: `读某 page 实例的布局态（有效值：默认已合并用户覆盖）`,
                input: {
                  page: z.string().cliArg({ desc: "page id（如 task-run / lab / settings）" }),
                  ctx: z.string().optional().cliOption({ desc: "上下文键：把 hiddenViews 过滤到该实例（几何本身按 page 共享）" }),
                },
                output: z.object({
                  status: z.string(),
                  data: z.object({
                    /** 有效布局（开发者默认 + 用户覆盖 + 隐藏 area 的 track 归零） */
                    layout: z.any(),
                    /** 用户态：隐藏的 area / 隐藏的 view / 最大化的 area */
                    hidden: z.array(z.string()),
                    hiddenViews: z.array(z.string()),
                    maximized: z.string().nullable(),
                  }),
                }),
              }),
              set: RpcSchema.unary({
                desc: `改布局（只改指定项，其余保持；track 尺寸传 px 数字，如 --cols 240,*,320）`,
                input: {
                  page: z.string().cliArg({ desc: "page id" }),
                  cols: z.string().optional().cliOption({ desc: "列尺寸，逗号分隔：数字=px，* = fr(1)，如 240,*,320" }),
                  rows: z.string().optional().cliOption({ desc: "行尺寸，同 cols" }),
                  hide: z.string().optional().cliOption({ desc: "要收起的 area，逗号分隔" }),
                  show: z.string().optional().cliOption({ desc: "要展开的 area，逗号分隔" }),
                  maximize: z.string().optional().cliOption({ desc: "最大化的 area id（空字符串=取消）" }),
                },
                output: z.object({ status: z.string() }),
              }),
              reset: RpcSchema.unary({
                desc: `回到开发者默认布局（尺寸 + 开合 + 最大化 + view 隐藏）`,
                input: { page: z.string().cliArg({ desc: "page id" }) },
                output: z.object({ status: z.string() }),
              }),
            },
          }),

          /**
           * view 的**内部**展开/折叠（折叠框）。
           * ⚠️ 与 `viewarea.set`（view 所在面板的开合）是两件事，别混：
           *    - expand 改的是 view 内部的折叠框（模板树 / 变量定义…）
           *    - viewarea 改的是承载 view 的面板几何（实验场面板整体开合）
           */
          view: RpcSchema.group({
            desc: `视图`,
            children: {
              expand: RpcSchema.unary({
                desc: `展开/折叠 view 内部的折叠框`,
                input: {
                  key: z.string().cliArg({ desc: "折叠框名（左栏 tree/trace/vars/vals；右栏 sysctx/reqbody/ctxpreview）" }),
                  open: z.string().cliArg({ desc: "open 或 closed" }),
                },
                output: z.object({ status: z.string() }),
              }),
              /**
               * view 级**隐藏/显示**（把某个 view 实例从 area 里拿掉 / 放回）。
               * 与 expand / viewarea.set 是三件事，别混：
               *   expand    view 内部的折叠框（模板树 / 变量定义…）
               *   viewarea  承载 view 的 area 整体开合
               *   set       单个 view 实例在 area 里的去留（实例状态保留）
               */
              set: RpcSchema.unary({
                desc: `隐藏/显示 view（view 级别，保留实例状态）`,
                input: {
                  view: z.string().cliArg({ desc: "view id（如 chat.local / task.detail / lab.editor，见 ui view list）" }),
                  open: z.string().cliArg({ desc: "open 或 closed" }),
                  page: z.string().optional().cliOption({ desc: "page id（缺省 task-run）" }),
                  ctx: z.string().optional().cliOption({ desc: "上下文键（context 型 view 必填，如任务 URI）" }),
                },
                output: z.object({ status: z.string() }),
              }),
            },
          }),

          /**
           * viewarea（承载 view 的面板）的开合。
           * 有几何语义、无身份语义：不区分 devtools 与普通面板，只是位置不同。
           */
          viewarea: RpcSchema.group({
            desc: `视图区域（面板）`,
            children: {
              set: RpcSchema.unary({
                desc: `开合 viewarea`,
                input: {
                  area: z.string().cliArg({ desc: "area id（如 left/center/right/bottom）" }),
                  open: z.string().cliArg({ desc: "open 或 closed" }),
                  page: z.string().optional().cliOption({ desc: "page id（缺省 task-run；同一 area 名在不同 page 上是不同的东西）" }),
                },
                output: z.object({ status: z.string() }),
              }),
            },
          }),

          /**
           * 任务执行页的 tab（打开的任务）。等同浏览器/编辑器开 tab：
           * 打开 = 我现在要做它；关闭 = 暂时不理会（**与任务状态无关**）。
           */
          /**
           * 人物编辑抽屉（SidebarRoom 里点名片的半截页）。
           *
           * 为什么做成 rpc（##518）：它原先只是 renderer 的 local signal ⇒ `diy.ui.*` 这套
           * 「rpc 操纵 UI 状态」的能力够不到它，意图测试只能起真窗口用 CDP 点鼠标。
           * 现在开关与选中项都落到 `personaDrawerStore`，main 只转发。
           */
          persona: RpcSchema.group({
            desc: `人物编辑抽屉`,
            children: {
              open: RpcSchema.unary({
                desc: `打开人物编辑抽屉（可指定人物 id）`,
                input: { id: z.string().optional().cliOption({ desc: "人物 id（缺省 = 保持当前选中）" }) },
                output: z.object({ status: z.string() }),
              }),
              close: RpcSchema.unary({
                desc: `关闭人物编辑抽屉`,
                input: {},
                output: z.object({ status: z.string() }),
              }),
              state: RpcSchema.unary({
                desc: `读抽屉状态（open / 选中的人物 id）—— 意图测试断言 UI 状态用，不必翻 a11y 树`,
                input: {},
                output: z.object({ status: z.string(), data: z.object({ open: z.boolean(), id: z.string().nullable() }) }),
              }),
            },
          }),

          tab: RpcSchema.group({
            desc: `任务 tab`,
            children: {
              open: RpcSchema.unary({
                desc: `打开（或聚焦）页面 tab`,
                input: {
                  uri: z.string().cliArg({
                    desc: "任务 URI，或 <pageId>:<任务 URI>（如 lab:projects/1/tasks/1 打开提示词子页面）",
                  }),
                },
                output: StatusDataUri,
              }),
              close: RpcSchema.unary({
                desc: `关闭页面 tab（关父连带关子；不改任务状态）`,
                input: { uri: z.string().cliArg({ desc: "tab key，如 task-run:projects/1/tasks/1" }) },
                output: StatusDataUri,
              }),
              active: RpcSchema.unary({
                desc: `切换到已打开的 tab`,
                input: { uri: z.string().cliArg({ desc: "tab key，如 task-run:projects/1/tasks/1" }) },
                output: StatusDataUri,
              }),
              list: RpcSchema.unary({
                desc: `已打开的任务 tab`,
                input: {},
                output: z.object({
                  status: z.string(),
                  data: z.object({
                    opened: z.array(z.string()),
                    active: z.string(),
                  }),
                }),
              }),
            },
          }),

          /** 页面级服务 */
          page: RpcSchema.group({
            desc: `页面`,
            children: {
              info: RpcSchema.unary({
                desc: `获取页面信息`,
                input: {},
                output: z.object({
                  status: z.string(),
                  data: z.object({
                    title: z.string(),
                    url: z.string(),
                    ready: z.boolean(),
                  }),
                }),
              }),

              /** 导航到指定页面（通过回调触发 React state 变更） */
              navigate: RpcSchema.unary({
                desc: `导航到页面`,
                input: { page: z.string().cliArg({ desc: "目标页面名称" }) },
                output: z.object({ status: z.string() }),
              }),

              /** 聚焦指定任务 */
              focus: RpcSchema.unary({
                desc: `聚焦任务`,
                input: { uri: z.string().cliArg({ desc: "任务 URI" }) },
                output: z.object({ status: z.string() }),
              }),

              /** 显示 Toast 通知 */
              toast: RpcSchema.unary({
                desc: `显示 Toast 通知`,
                input: { message: z.string().cliArg({ desc: "消息内容" }), level: z.string().optional().cliOption({ desc: "级别" }) },
                output: z.object({ status: z.string() }),
              }),
            },
          }),

          /** 任务树数据（结构化 JSON，供 CLI 和 UI 共用） */
          tree: RpcSchema.unary({
            desc: `加载任务树（结构化 JSON）`,
            input: {
              all: z.boolean().optional().describe('显示全部任务'),
            },
            output: z.object({
              status: z.string(),
              data: z.array(TaskNodeSchema),
            }),
          }),

          /** Renderer UI 状态（进程信息反向调 diy.getAppStatus） */
          status: RpcSchema.unary({
            desc: `Renderer 进程状态`,
            input: {},
            output: z.object({
              status: z.string(),
              data: z.object({
                pid: z.number(),
                uptime: z.number(),
                memory: z.number(),
              }),
            }),
          }),

          /** UI 侧项目操作（反向调 diy.project.* + 刷新树 + toast） */
          project: RpcSchema.group({
            desc: `项目`,
            children: {
              create: RpcSchema.unary({
                desc: `创建项目（UI 入口，反向调 main + 刷新任务树 + toast）`,
                input: {
                  path: z.string().min(1, "path 不能为空").cliArg({ desc: "项目路径" }),
                  label: z.string().optional().cliOption({ short: "l", desc: "显示名称" }),
                  desc: z.string().optional().cliOption({ desc: "描述" }),
                },
                output: StatusDataId,
              }),
              remove: RpcSchema.unary({
                desc: `删除项目（UI 入口；连带其下全部任务，不可恢复 —— 回收站见 ##138）`,
                input: {
                  id: z.string().cliArg({ desc: "project id" }),
                },
                output: StatusDataId,
              }),
            },
          }),

          /** UI 侧任务操作（反向调 diy.task.* + 刷新树 + toast） */
          task: RpcSchema.group({
            desc: `任务`,
            children: {
              create: RpcSchema.unary({
                desc: `创建任务（UI 入口，反向调 main + 刷新任务树 + toast）`,
                input: {
                  title: z.string().min(1, "标题不能为空").max(200).cliArg({ desc: "任务标题" }),
                  project: z.string().cliArg({ desc: "所属 project id" }),
                  parent: z.string().optional().cliOption({ short: "p", desc: "父任务 URI" }),
                },
                output: StatusDataUri,
              }),
              update: RpcSchema.unary({
                desc: `编辑任务（UI 入口，反向调 main + 刷新任务树 + toast）`,
                input: {
                  uri: z.string().cliArg({ desc: "任务 URI" }),
                  title: z.string().optional().cliOption({ desc: "新标题" }),
                  body: z.string().optional().cliOption({ desc: "新内容" }),
                  change_type: z.string().optional().cliOption({ desc: "变更性质（空字符串=清除）" }),
                  module: z.string().optional().cliOption({ desc: "模块（空字符串=清除）" }),
                  priority: z.string().optional().cliOption({ desc: "优先级（空字符串=清除）" }),
                },
                output: StatusDataUri,
              }),
              setState: RpcSchema.unary({
                desc: `修改任务状态（UI 入口，反向调 main + 刷新任务树 + toast）`,
                input: {
                  uri: z.string().cliArg({ desc: "任务 URI" }),
                  state: TaskStateSchema.cliArg({ desc: "新状态" }),
                },
                output: StatusDataUri,
              }),
              delete: RpcSchema.unary({
                desc: `删除任务（UI 入口；仅删本条，子任务失父升为一级任务，不可恢复 —— 回收站见 ##138）`,
                input: {
                  uri: z.string().cliArg({ desc: "任务 URI" }),
                },
                output: StatusDataUri,
              }),
            },
          }),

          /** UI 可见性诊断 — 遍历渲染器 DOM 生成无障碍树（agent 了解 UI 全貌的入口） */
          inspect: RpcSchema.unary({
            desc: `UI 诊断：生成当前页面的无障碍树（可见元素 + 角色 + 文本 + 层级）`,
            input: {},
            output: z.object({
              status: z.string(),
              data: z.object({
                tree: z.any(),
                stats: z.object({
                  totalNodes: z.number(),
                  visibleNodes: z.number(),
                }),
              }),
            }),
          }),

          /**
           * UI 状态单读（unary）—— 与 ui.watch.uiState 同一形状。
           * 用于「先读现状（拿 rev/uiRev/dataRev）→ 操作 → 再读/比对」的一次性调用；
           * 事件驱动等待用 ui.watch.uiState 流。
           */
          state: RpcSchema.unary({
            desc: `UI 状态快照（单读；含 rev/uiRev/dataRev 版本号）`,
            input: {},
            output: z.object({ status: z.string(), data: UiSnapshotData }),
          }),

          /**
           * UI 状态变化流（业务语义快照）—— renderer 侧事件源，createEffect 后推送。
           *
           * 为什么放 diy.ui.*：状态活在 renderer，事件源也在 renderer（createEffect 读 store），
           * 经 rpc-port 的 RendererForwarder 转发给 CLI/测试订阅；与 diy.watch.fileChange（main 侧）
           * 对称，只是事件源换到渲染进程的"渲染提交后"边界。
           *
           * 语义：**订阅即刻 yield 当前快照**（防丢唤醒），此后每次渲染提交（DOM 已更新）再 yield 全量快照。
           * 消费者不用轮询、不猜时机：`for await (snap) { if (ok(snap)) break }`。
           */
          watch: RpcSchema.group({
            desc: `UI 状态变化流（业务语义，渲染提交后快照）`,
            children: {
              uiState: RpcSchema.serverStream({
                desc: `UI 快照流 — 订阅即得当前态，之后每次 UI 变更（渲染提交后）推送全量快照`,
                input: {},
                output: z.object({ status: z.string(), data: UiSnapshotData }),
              }),
            },
          }),
        },});

export const uiService = defineService({ name: "diy.ui", api: uiRoutes });

/**
 * 新模型（##87）：模块自带模块层，app 前缀由宿主给。
 * `server.use({ prefix: "diy", api: uiApi, handlers: { ui: … } })`
 * 与上面的 `uiService` 完全等价（后者 = prefix "diy" + 模块层 "ui"）。
 */
export const uiApi = RpcSchema.group({ children: { ui: uiRoutes } });

/**
 * api-def.ts — RPC 纯定义（meta，无 call）
 *
 * 只含 zod schema，供 server 端绑定 handler（api-impl.ts）和
 * 客户端 createTypedClient 推导强类型。
 * 命名与 py 侧 `diy <域> <命令>` 对齐。
 *
 * 命名体系：
 *   diy.*      — Main 进程域（本地处理）
 *   diy.ui.*   — Renderer 进程域（Main 经 onForward 转发，Renderer 本地处理）
 *
 * 结构不变量：RPC 树的每个可见命令节点必须是 RpcSchema.group / unary / serverStream /
 * clientStream / bidiStream 之一——父命令用 group（承载 desc），叶子命令用四种流工厂
 * （承载 desc），保证 CLI help 每一层（含根 `diy`）都有说明。`app` 是进程域前缀
 * （cliRootPath 摊平、非可见命令），作为裸 _Router 容器。
 * 所有 desc 用反引号模板字符串，便于扩展成多行（help 第一行作命令列表摘要）。
 */

import { RpcSchema } from "@diy/rpc";
import { z } from "zod";
import { PromptEntrySchema, RequestPreviewSchema } from "../../shared/prompt-schema";

// 任务状态枚举 — 单一真相源 task-state.ts（纯 zod，无 Node 依赖，浏览器安全） */
import { TaskStateSchema } from "../core/task-state";

const StatusDataUri = z.object({ status: z.string(), data: z.object({ uri: z.string() }) });
const StatusDataId = z.object({ status: z.string(), data: z.object({ id: z.string() }) });
const StatusOk = z.object({ status: z.string() });

/** 任务树节点 schema（递归，供 ui.tree 输出强类型） */
export interface TaskNodeShape {
  kind: "project" | "task";
  uri?: string;
  title?: string;
  state?: string;
  project?: string;
  parentUri?: string;
  body?: string;
  created?: string;
  updated?: string;
  children: TaskNodeShape[];
}
const TaskNodeSchema: z.ZodType<TaskNodeShape> = z.lazy(() =>
  z.object({
    kind: z.enum(["project", "task"]),
    uri: z.string().optional(),
    title: z.string().optional(),
    state: TaskStateSchema.optional(),
    project: z.string().optional(),
    parentUri: z.string().optional(),
    body: z.string().optional(),
    created: z.string().optional(),
    updated: z.string().optional(),
    children: z.array(TaskNodeSchema),
  }),
);

/** 草稿字段名白名单 — 单一真相源 core/drafts.ts 的 DRAFT_FIELDS */
export const DraftFieldSchema = z.enum(["title", "body", "agent_input"]);
/** 草稿字段映射（值一律字符串，原样保存不 trim；partial：未编辑的字段不出现） */
export const DraftFieldsSchema = z.partialRecord(DraftFieldSchema, z.string());

/** 草稿数据（含 meta，供 renderer 判定过期 / CLI 观察） */
export const DraftsData = z.object({
  base_updated: z.string().optional(),
  saved: z.string().optional(),
  fields: DraftFieldsSchema,
});

export const apiDef = RpcSchema.router({
  diy: RpcSchema.group({
    desc: `
    diy 管控台 CLI
    管控台命令行工具，提供任务管理、主题管理、Agent 对话、LLM 代理、日志查看等功能。
    `,
    children: {
      task: RpcSchema.group({
        desc: `任务管理`,
        children: {
          create: RpcSchema.unary({
            desc: `创建任务`,
            input: {
              title: z.string().min(1, "标题不能为空").max(200).cliArg({ desc: "任务标题" }),
              project: z.string().cliArg({ desc: "所属 project id" }),
              parent: z.string().optional().cliOption({ short: "p", desc: "父任务 URI" }),
              body: z.string().optional().cliOption({ desc: "任务内容" }),
            },
            output: StatusDataUri,
          }),
          list: RpcSchema.unary({
            desc: `列出任务`,
            input: {
              project: z.string().optional().cliOption({ short: "p", desc: "按 project 筛选" }),
            },
            output: z.object({ status: z.string(), data: z.object({ tasks: z.any() }) }),
          }),
          show: RpcSchema.unary({
            desc: `查看任务详情（含未提交草稿 ui_drafts）`,
            input: {
              uri: z.string().cliArg({ desc: "任务 URI" }),
            },
            output: z.object({ status: z.string(), data: z.any() }).or(z.object({ status: z.string(), msg: z.string() })),
          }),

          /** 半编辑草稿：用户未提交的输入（agent 输入框 / 任务编辑框），落任务目录 .diy/drafts.yaml */
          drafts: RpcSchema.group({
            desc: `未提交草稿（agent 输入 / 任务编辑框；落任务目录 .diy/drafts.yaml）`,
            children: {
              show: RpcSchema.unary({
                desc: `读取任务的未提交草稿（无草稿时 data 为 null）`,
                input: {
                  uri: z.string().cliArg({ desc: "任务 URI" }),
                },
                output: z.object({ status: z.string(), data: DraftsData.nullable() }),
              }),
              set: RpcSchema.unary({
                desc: `
                写入草稿（合并语义：只覆盖传入的字段）

                字段按白名单平铺，不用 JSON 参数：白名单固定且短，平铺后 --help 逐字段可见，
                也免去 shell 里 JSON 引号的层层转义。传空字符串（如 --title ""）= 清除该字段；
                不传 = 保持原值。已提交（保存/取消）后应显式清除，否则草稿会盖住新数据。
                `,
                input: {
                  uri: z.string().cliArg({ desc: "任务 URI" }),
                  title: z.string().optional().cliOption({ desc: "标题草稿（空串=清除）" }),
                  body: z.string().optional().cliOption({ desc: "内容草稿（空串=清除）" }),
                  agent_input: z.string().optional().cliOption({ desc: "agent 输入框草稿（空串=清除）" }),
                  base_updated: z.string().optional().cliOption({ desc: "草稿基点：任务当前 updated（用于检测过期）" }),
                },
                output: z.object({ status: z.string(), data: DraftsData }),
              }),
              clear: RpcSchema.unary({
                desc: `清除草稿（不传 fields 清空全部；清空后文件删除）`,
                input: {
                  uri: z.string().cliArg({ desc: "任务 URI" }),
                  // CLI 数组统一走 JSON 形式（parser 只对 ZodArray 做 JSON.parse）：
                  // 必须写 --fields '["title"]'，写 --fields title 会得到 "expected array"。renderer 侧传数组。
                  fields: z.array(DraftFieldSchema).optional().cliOption({ desc: `只清指定字段（JSON 数组，如 '[\"title\"]'）` }),
                },
                output: StatusOk,
              }),
            },
          }),
          edit: RpcSchema.unary({
            desc: `编辑任务`,
            input: {
              uri: z.string().cliArg({ desc: "任务 URI" }),
              title: z.string().optional().cliOption({ short: "t", desc: "新标题" }),
              state: TaskStateSchema.optional().cliOption({ desc: "新状态" }),
              body: z.string().optional().cliOption({ desc: "新内容（至少 10 字符，拒绝空/过短以免误清空正文）" }),
              parent: z.string().optional().cliOption({ desc: "父任务 URI（空字符串=取消父子关系）" }),
            },
            output: StatusDataUri,
          }),
          move: RpcSchema.unary({
            desc: `移动任务（改变父级）`,
            input: {
              uri: z.string().cliArg({ desc: "任务 URI" }),
              parent: z.string().cliArg({ desc: "新父任务 URI（空字符串=取消父子关系）" }),
            },
            output: StatusDataUri,
          }),
          delete: RpcSchema.unary({
            desc: `删除任务`,
            input: {
              uri: z.string().cliArg({ desc: "任务 URI" }),
            },
            output: StatusDataUri,
          }),
        },
      }),

      project: RpcSchema.group({
        desc: `项目管理`,
        children: {
          create: RpcSchema.unary({
            desc: `创建项目（path 必填，id 自动生成并返回 {id}）`,
            input: {
              path: z.string().min(1, "path 不能为空").cliArg({ desc: "项目路径（映射到该目录下的 diy.yaml）" }),
              label: z.string().optional().cliOption({ short: "l", desc: "显示名称" }),
              desc: z.string().optional().cliOption({ desc: "描述" }),
              state: z.string().optional().cliOption({ desc: "状态" }),
            },
            output: StatusDataId,
          }),
          list: RpcSchema.unary({
            desc: `列出项目`,
            input: {},
            output: z.object({
              status: z.string(),
              data: z.object({
                projects: z.array(
                  z.object({
                    id: z.string(),
                    info: z.object({
                      label: z.string().optional(),
                      path: z.string().optional(),
                      desc: z.string().optional(),
                      state: z.string().optional(),
                    }),
                  }),
                ),
              }),
            }),
          }),
          remove: RpcSchema.unary({
            desc: `删除项目`,
            input: {
              id: z.string().cliArg({ desc: "project id" }),
            },
            output: StatusDataId,
          }),
        },
      }),

      /** Main 进程运行状态（供 renderer diy.ui.status 反向调用） */
      getAppStatus: RpcSchema.unary({
        desc: `主进程运行状态（pid/uptime/memory）`,
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

      // 运行环境详情：设置页「状态」标签用，同时天然可被 CLI 调用。
      // 历史上它只是一条 ipcMain.handle("getAppInfo")，preload 没桥接、api-def 也没登记，
      // 于是 Electron 里 window.diy 为 undefined（可选链短路，永远卡在「加载中…」）、
      // serve 里方法不存在。走 RPC 后三种入口共用同一实现。
      getAppInfo: RpcSchema.unary({
        desc: `查询运行环境详情（端口/目录/版本/系统）`,
        input: {},
        output: z.object({
          port: z.number(),
          diyHome: z.string(),
          cache: z.string(),
          userData: z.string(),
          electron: z.string(),
          node: z.string(),
          chrome: z.string(),
          platform: z.string(),
          pid: z.number(),
          memory: z.string(),
        }),
      }),

      doctor: RpcSchema.unary({
        desc: `系统健康自检`,
        input: {},
        output: z.object({
          status: z.string(),
          data: z.object({
            pid: z.number(),
            home: z.string(),
            state_exists: z.boolean(),
            issues: z.array(z.string()),
            healthy: z.boolean(),
          }),
        }),
      }),

      loadTaskTree: RpcSchema.unary({
        desc: `加载任务树（供 renderer 反向调用）`,
        input: {},
        output: z.object({ status: z.string(), data: z.array(TaskNodeSchema) }),
      }),

      getTask: RpcSchema.unary({
        desc: `按 URI 获取任务（供 renderer 反向调用；未找到时 data 为 null）`,
        input: { uri: z.string() },
        output: z.object({
          status: z.string(),
          // 未找到 → data: null，renderer 侧 `if (r.data)` 守卫才能生效
          data: z.object({
            uri: z.string(),
            title: z.string().optional(),
            state: TaskStateSchema.optional(),
            project: z.string().optional(),
            parent: z.string().optional(),
            body: z.string().optional(),
            created: z.string().optional(),
            updated: z.string().optional(),
            // 未提交草稿：renderer 用它恢复编辑态与输入框（见 core/drafts.ts）
            ui_drafts: DraftsData.nullable().optional(),
          }).nullable(),
        }),
      }),

      /** 弹出原生目录选择器（供 renderer「选择目录」按钮反向调用；Web/serve 模式无 Electron dialog 时返回 canceled） */
      pickProjectDirectory: RpcSchema.unary({
        desc: `弹出原生目录选择器，返回所选路径`,
        input: {},
        output: z.object({
          status: z.string(),
          data: z.object({
            canceled: z.boolean(),
            path: z.string().optional(),
          }),
        }),
      }),

      agent: RpcSchema.group({
        desc: `Agent 管理`,
        children: {

          // —— 本地自定义 agent（ai-sdk 块协议，独立于 ACP 通道）——
          local: RpcSchema.group({
            desc: `本地自定义 agent（ai-sdk，独立于 ACP 通道）`,
            children: {
              chat: RpcSchema.serverStream({
                desc: `本地 agent 对话 — 实时逐行输出块协议 Op（JSONL）`,
                input: {
                  taskUri: z.string().cliArg({ desc: "任务 URI" }),
                  message: z.string().cliArg({ desc: "用户消息" }),
                  model: z.string().optional().cliOption({ desc: `模型（默认 mimo-v2.5，zen/go 子集见 agent local models）` }),
                },
                output: z.string(),
              }),
              cancel: RpcSchema.unary({
                desc: `中断本地 agent 当前生成`,
                input: {
                  taskUri: z.string().cliArg({ desc: "任务 URI" }),
                },
                output: z.object({ cancelled: z.boolean() }),
              }),
              history: RpcSchema.unary({
                desc: `读取本地 agent 会话的块协议 Op 日志（UI 重放用）`,
                input: {
                  taskUri: z.string().cliArg({ desc: "任务 URI" }),
                },
                output: z.array(z.any()),
              }),
              clear: RpcSchema.unary({
                desc: `清空本地 agent 会话（中断生成并删除 Op/LLM 日志）`,
                input: {
                  taskUri: z.string().cliArg({ desc: "任务 URI" }),
                },
                output: z.object({ cleared: z.boolean() }),
              }),
              models: RpcSchema.unary({
                desc: `列出本地 agent 可选模型（zen/go OpenAI-completions 子集）`,
                input: {},
                output: z.array(z.object({ id: z.string(), name: z.string() })),
              }),
              limits: RpcSchema.unary({
                desc: `查询生效运行限制（默认值 < $DIY_HOME/local/limits.json < 环境变量 DIY_LOCAL_*）`,
                input: {},
                output: z.object({
                  maxSteps: z.number(),
                  maxOutputTokens: z.number(),
                  bashTimeoutMs: z.number(),
                  outputClipChars: z.number(),
                }),
              }),
            },
          }),
        },
      }),

      // —— 提示词模版试验场（spike）：内置只读 + 项目级同路径覆盖 + dry-run 预览 ——
      template: RpcSchema.group({
        desc: `提示词模版（内置只读，项目级覆盖；仅构造请求，不发 LLM）`,
        children: {
          list: RpcSchema.unary({
            desc: `列出全部模版（含状态/元数据，供树展示）`,
            input: {
              project: z.string().cliArg({ desc: "project id" }),
            },
            output: z.array(PromptEntrySchema),
          }),
          get: RpcSchema.unary({
            desc: `取单份模版（含内置/当前/stale）`,
            input: {
              project: z.string().cliArg({ desc: "project id" }),
              relpath: z.string().cliArg({ desc: "模版相对路径" }),
            },
            output: PromptEntrySchema,
          }),
          save: RpcSchema.unary({
            desc: `保存项目级覆盖（不可覆盖项拒绝）`,
            input: {
              project: z.string().cliArg({ desc: "project id" }),
              relpath: z.string().cliArg({ desc: "模版相对路径" }),
              content: z.string().cliArg({ desc: "覆盖正文" }),
            },
            output: PromptEntrySchema,
          }),
          restore: RpcSchema.unary({
            desc: `一键恢复（删覆盖，回退内置）`,
            input: {
              project: z.string().cliArg({ desc: "project id" }),
              relpath: z.string().cliArg({ desc: "模版相对路径" }),
            },
            output: PromptEntrySchema,
          }),
          preview: RpcSchema.unary({
            desc: `dry-run 预览：装配系统上下文 + 仿真请求体（只组装不发送）`,
            input: {
              project: z.string().cliArg({ desc: "project id" }),
              taskUri: z.string().optional().cliOption({ desc: "任务 URI（任务场景与工作目录从它推，并以其 project 为准）" }),
              model: z.string().optional().cliOption({ desc: `模型 id（缺省 mimo-v2.5；应传会话实际选中的模型才算保真）` }),
              // 无 CLI 注解：CLI 解析器忽略，RPC 照传（未存盘草稿渲染用）
              drafts: z.record(z.string(), z.string()).optional().describe("未存盘草稿 relpath→正文"),
            },
            output: RequestPreviewSchema,
          }),
        },
      }),

      llmProxy: RpcSchema.group({
        desc: `LLM 代理`,
        children: {
          status: RpcSchema.unary({
            desc: `查询 LLM 代理状态`,
            input: {},
            output: z.object({ running: z.boolean(), port: z.number() }),
          }),
          start: RpcSchema.unary({
            desc: `启动 LLM 代理`,
            input: {},
            output: StatusOk,
          }),
          stop: RpcSchema.unary({
            desc: `停止 LLM 代理`,
            input: {},
            output: StatusOk,
          }),
        },
      }),

      log: RpcSchema.group({
        desc: `日志`,
        children: {
          read: RpcSchema.unary({
            desc: `读取日志`,
            input: {
              limit: z.number().optional().cliOption({ desc: "返回条目数" }),
            },
            output: z.array(z.object({
              timestamp: z.string().optional(),
              level: z.string().optional(),
              message: z.string().optional(),
              raw: z.string().optional(),
            })),
          }),
        },
      }),

      ref: RpcSchema.group({
        desc: `仓库引用管理`,
        children: {
          sync: RpcSchema.unary({
            desc: `同步镜像引用`,
            input: {
              all: z.boolean().optional().cliOption({ short: "a", desc: "sync 所有 scope" }),
              scope: z.string().optional().cliOption({ desc: "指定 scope 名称" }),
              concurrency: z.number().default(4).optional().cliOption({ desc: "并发克隆数" }),
            },
            output: z.object({ status: z.string(), data: z.any() }),
          }),
          list: RpcSchema.unary({
            desc: `列出镜像引用`,
            input: {
              all: z.boolean().optional().cliOption({ short: "a", desc: "显示所有 scope" }),
            },
            output: z.object({ status: z.string(), data: z.any() }),
          }),
          status: RpcSchema.unary({
            desc: `查询引用状态`,
            input: {},
            output: z.object({
              status: z.string(),
              data: z.object({
                total: z.number(),
                missing: z.number(),
                paths: z.any(),
              }),
            }),
          }),
          add: RpcSchema.unary({
            desc: `添加仓库引用`,
            input: {
              url: z.string().cliArg({ desc: "Git 仓库 URL" }),
            },
            output: z.object({ status: z.string(), data: z.object({ added: z.any() }) }),
          }),
          remove: RpcSchema.unary({
            desc: `移除仓库引用`,
            input: {
              name: z.string().cliArg({ desc: "仓库标识（diy.yaml 中注册的 URL 或 host/owner/repo）" }),
            },
            output: z.object({ status: z.string(), data: z.object({ removed: z.any() }) }).or(z.object({ status: z.string(), msg: z.string() })),
          }),
        },
      }),

      /**
       * 文件系统变更推送（Main 域）。
       *
       * ⚠️ 必须在 diy.* 而非 diy.ui.*：实现是 main 侧的 FileWatcher（renderer 只是订阅方），
       * 而 rpc-port 会把 `diy.ui` 整棵子树 onForward 给 renderer —— 挂在 ui 下会让同一方法
       * 被注册两次（本地 + 转发），ServerBinding 直接抛「已注册」使 RPC 服务器起不来。
       * 判据：diy.* = Main 本地处理，diy.ui.* = 转发 Renderer（见本文件头注释）。
       */
      watch: RpcSchema.group({
        desc: `文件系统监控（projects/ 增删改 → 实时推送）`,
        children: {
          fileChange: RpcSchema.serverStream({
            desc: `文件变更事件流 — 持续订阅，FileWatcher 检测到 projects/ 下文件变更后 yield`,
            input: {},
            output: z.object({
              event: z.string().describe("变更类型：task-change（projects/ 下任务树相关变更）"),
              ts: z.number().describe("变更发生时间戳（ms）"),
            }),
          }),
        },
      }),

      // ═══════════════════════════════════════════
      //  diy.ui.* — Renderer 进程域
      //  这些服务只在 Renderer 进程（浏览器）中运行。Main 侧经
      //  Main 侧 onForward 转发到 Renderer；Renderer 侧直接本地处理。
      // ═══════════════════════════════════════════
      ui: RpcSchema.group({
        desc: `Renderer 进程域`,
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

          /** 试验场 view 的展开/折叠（默认只展开「模板」；自动化要看折叠 view 的内容时用） */
          view: RpcSchema.group({
            desc: `视图`,
            children: {
              set: RpcSchema.unary({
                desc: `展开/折叠试验场 view`,
                input: {
                  key: z.string().cliArg({ desc: "view 名（tree/trace/vars/vals）" }),
                  open: z.string().cliArg({ desc: "open 或 closed" }),
                },
                output: z.object({ status: z.string() }),
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
        },
      }),
    },
  }),
});
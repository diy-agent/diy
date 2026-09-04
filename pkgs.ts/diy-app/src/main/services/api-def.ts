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

// 任务状态枚举（内联，保持 api-def 无 Node 依赖、浏览器安全）
const TaskStateSchema = z.enum([
  "pending",
  "active",
  "done",
  "cancelled",
  "blocked",
  "shelved",
  "new",
  "open",
  "closed",
]);

const StatusDataUri = z.object({ status: z.string(), data: z.object({ uri: z.string() }) });
const StatusDataId = z.object({ status: z.string(), data: z.object({ id: z.string() }) });
const StatusOk = z.object({ status: z.string() });

const MessageParam = z.object({ role: z.string(), content: z.string() });

/** 任务树节点 schema（递归，供 ui.tree 输出强类型） */
export interface TaskNodeShape {
  kind: "project" | "task";
  uri?: string;
  title?: string;
  state?: string;
  project?: string;
  parentUri?: string;
  detail?: string;
  body?: string;
  created?: string;
  updated?: string;
  starred: boolean;
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
    detail: z.string().optional(),
    body: z.string().optional(),
    created: z.string().optional(),
    updated: z.string().optional(),
    starred: z.boolean(),
    children: z.array(TaskNodeSchema),
  }),
);

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
              detail: z.string().optional().cliOption({ desc: "任务详情" }),
              body: z.string().optional().cliOption({ desc: "任务正文" }),
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
            desc: `查看任务详情`,
            input: {
              uri: z.string().cliArg({ desc: "任务 URI" }),
            },
            output: z.object({ status: z.string(), data: z.any() }).or(z.object({ status: z.string(), msg: z.string() })),
          }),
          edit: RpcSchema.unary({
            desc: `编辑任务`,
            input: {
              uri: z.string().cliArg({ desc: "任务 URI" }),
              title: z.string().optional().cliOption({ short: "t", desc: "新标题" }),
              state: TaskStateSchema.optional().cliOption({ desc: "新状态" }),
              detail: z.string().optional().cliOption({ desc: "新详情" }),
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
          star: RpcSchema.unary({
            desc: `收藏任务`,
            input: {
              uri: z.string().cliArg({ desc: "任务 URI" }),
            },
            output: z.object({ status: z.string(), data: z.object({ uri: z.string(), starred: z.boolean() }) }),
          }),
          unstar: RpcSchema.unary({
            desc: `取消收藏任务`,
            input: {
              uri: z.string().cliArg({ desc: "任务 URI" }),
            },
            output: z.object({ status: z.string(), data: z.object({ uri: z.string(), starred: z.boolean() }) }),
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
        input: { allTasks: z.boolean().optional() },
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
            detail: z.string().optional(),
            body: z.string().optional(),
            created: z.string().optional(),
            updated: z.string().optional(),
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
          chat: RpcSchema.unary({
            desc: `与模型对话（task 级：每 task 独立 ACP session）`,
            input: {
              taskUri: z.string().cliArg({ desc: "任务 URI（决定所属 project/session）" }),
              model: z.string().cliArg({ desc: "模型名称" }),
              messages: z.array(MessageParam).cliOption({ desc: "消息数组 JSON" }),
            },
            output: z.object({ role: z.string(), content: z.string() }),
          }),
          chatStream: RpcSchema.serverStream({
            desc: `流式对话（task 级：每 task 独立 ACP session）`,
            input: {
              taskUri: z.string().cliArg({ desc: "任务 URI" }),
              model: z.string().cliArg({ desc: "模型名称" }),
              messages: z.array(MessageParam).cliOption({ desc: "消息数组 JSON" }),
            },
            output: z.string(),
          }),
          chatStreamEvents: RpcSchema.serverStream({
            desc: `流式对话 — 完整 ACP 事件流（JSON 序列化的 session/update 通知）`,
            input: {
              taskUri: z.string().cliArg({ desc: "任务 URI" }),
              model: z.string().cliArg({ desc: "模型名称" }),
              messages: z.array(MessageParam).cliOption({ desc: "消息数组 JSON" }),
            },
            output: z.string(),
          }),
          listModels: RpcSchema.unary({
            desc: `列出可用模型`,
            input: {},
            output: z.array(z.object({ id: z.string(), name: z.string() })),
          }),
          status: RpcSchema.unary({
            desc: `查询任务会话状态（只读，不会创建会话）`,
            input: {
              taskUri: z.string().cliArg({ desc: "任务 URI" }),
            },
            // model 可选：state=no_session 时无会话，也就没有模型
            output: z.object({ taskUri: z.string(), state: z.string(), model: z.string().optional() }),
          }),
          getAutoApprove: RpcSchema.unary({
            desc: `获取自动审批权限设置`,
            input: {},
            output: z.object({ enabled: z.boolean() }),
          }),
          setAutoApprove: RpcSchema.unary({
            desc: `设置自动审批权限`,
            input: {
              enabled: z.boolean().cliArg({ desc: "是否自动审批" }),
            },
            output: z.object({ enabled: z.boolean() }),
          }),
          closeSession: RpcSchema.unary({
            desc: `关闭任务会话`,
            input: {
              taskUri: z.string().cliArg({ desc: "任务 URI" }),
            },
            output: z.object({ closed: z.boolean() }),
          }),
          setModel: RpcSchema.unary({
            desc: `切换任务会话的模型`,
            input: {
              taskUri: z.string().cliArg({ desc: "任务 URI" }),
              model: z.string().cliArg({ desc: "模型 ID" }),
            },
            output: z.object({ success: z.boolean() }),
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
export type ApiDef = typeof apiDef;

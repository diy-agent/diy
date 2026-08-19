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
const StatusDataPath = z.object({ status: z.string(), data: z.object({ path: z.string() }) });
const StatusOk = z.object({ status: z.string() });

const MessageParam = z.object({ role: z.string(), content: z.string() });

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
              subject: z.string().cliArg({ desc: "所属 subject 路径" }),
              parent: z.string().optional().cliOption({ short: "p", desc: "父任务 URI" }),
              detail: z.string().optional().cliOption({ desc: "任务详情" }),
              body: z.string().optional().cliOption({ desc: "任务正文" }),
            },
            output: StatusDataUri,
          }),
          list: RpcSchema.unary({
            desc: `列出任务`,
            input: {
              subject: z.string().optional().cliOption({ short: "s", desc: "按 subject 筛选" }),
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

      subject: RpcSchema.group({
        desc: `主题管理`,
        children: {
          add: RpcSchema.unary({
            desc: `添加主题`,
            input: {
              path: z.string().min(1, "路径不能为空").cliArg({ desc: "subject 路径" }),
              label: z.string().optional().cliOption({ short: "l", desc: "显示名称" }),
            },
            output: StatusDataPath,
          }),
          list: RpcSchema.unary({
            desc: `列出主题`,
            input: {},
            output: z.object({ status: z.string(), data: z.object({ subjects: z.any() }) }),
          }),
          remove: RpcSchema.unary({
            desc: `删除主题`,
            input: {
              path: z.string().cliArg({ desc: "subject 路径" }),
            },
            output: StatusDataPath,
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
        output: z.any(),
      }),

      getTask: RpcSchema.unary({
        desc: `按 URI 获取任务（供 renderer 反向调用）`,
        input: { uri: z.string() },
        output: z.any(),
      }),

      agent: RpcSchema.group({
        desc: `Agent 管理`,
        children: {
          chat: RpcSchema.unary({
            desc: `与模型对话`,
            input: {
              model: z.string().cliArg({ desc: "模型名称" }),
              messages: z.array(MessageParam).cliOption({ desc: "消息数组 JSON" }),
            },
            output: z.object({ role: z.string(), content: z.string() }),
          }),
          chatStream: RpcSchema.serverStream({
            desc: `流式对话`,
            input: {
              model: z.string(),
              messages: z.array(MessageParam),
            },
            output: z.any(),
          }),
          listModels: RpcSchema.unary({
            desc: `列出可用模型`,
            input: {},
            output: z.array(z.object({ id: z.string(), name: z.string() })),
          }),
          status: RpcSchema.unary({
            desc: `查询 Agent 状态`,
            input: {
              agentId: z.string().cliArg({ desc: "Agent ID" }),
            },
            output: z.object({ agentId: z.string(), state: z.string(), model: z.string() }),
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
            output: z.array(z.any()),
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

          /** 渲染任务树文本（反向调 diy.loadTaskTree 取数据） */
          tree: RpcSchema.unary({
            desc: `渲染任务树文本`,
            input: {
              all: z.boolean().optional().describe('显示全部任务'),
            },
            output: z.object({
              status: z.string(),
              data: z.string(),
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
        },
      }),
    },
  }),
});
export type ApiDef = typeof apiDef;

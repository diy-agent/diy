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
import { ContextDiffSchema, StatsSchema, StepsSchema } from "../../shared/context/schema";
import { ContextLabSchema, ContextPlaceCandidateSchema } from "../../shared/context/schema";
// agent 人物契约（纯 zod，renderer 同源）——模型/参数/行为指令的配置实体
import { PersonaSchema } from "../../shared/persona";
// 草稿与任务详情载荷的契约（纯 zod，renderer 同源）
import { DraftFieldSchema, DraftFieldsSchema, DraftsData, TaskDetailSchema } from "../../shared/task-detail";

// 任务状态枚举 — 单一真相源 task-state.ts（纯 zod，无 Node 依赖，浏览器安全） */
import { TaskStateSchema } from "../core/task-state";
import { ChangeTypeSchema, PrioritySchema } from "../core/task-fields";

const StatusDataUri = z.object({ status: z.string(), data: z.object({ uri: z.string() }) });
const StatusDataId = z.object({ status: z.string(), data: z.object({ id: z.string() }) });
const StatusOk = z.object({ status: z.string() });

/** 任务树节点 schema（递归，供 ui.tree 输出强类型） */
export interface TaskNodeShape {
  kind: "project" | "task";
  uri?: string;
  /** 任务号 = uri 末段（项目内自增）。列表默认按它对同级排序，故必须在契约里 */
  num?: string;
  title?: string;
  state?: string;
  project?: string;
  /** 项目路径/显示名（main 的 task-tree 回填；运行时输出一直有，类型此前漏了） */
  project_path?: string;
  project_label?: string;
  parentUri?: string;
  body?: string;
  created?: string;
  updated?: string;
  change_type?: string;
  module?: string;
  priority?: string;
  children: TaskNodeShape[];
}
const TaskNodeSchema: z.ZodType<TaskNodeShape> = z.lazy(() =>
  z.object({
    kind: z.enum(["project", "task"]),
    uri: z.string().optional(),
    num: z.string().optional(),
    title: z.string().optional(),
    state: TaskStateSchema.optional(),
    project: z.string().optional(),
    project_path: z.string().optional(),
    project_label: z.string().optional(),
    parentUri: z.string().optional(),
    body: z.string().optional(),
    created: z.string().optional(),
    updated: z.string().optional(),
    // 刻意用 z.string() 而非 task-fields 的枚举：读侧一律宽容（历史手写值如 priority: high
    // 不在词表内也要能显示出来），枚举校验只发生在写入侧（task.create / task.edit 的 input）。
    change_type: z.string().optional(),
    module: z.string().optional(),
    priority: z.string().optional(),
    children: z.array(TaskNodeSchema),
  }),
);

// 草稿契约在 shared/task-detail.ts（单一真源，renderer 同源）；re-export 保持既有引用路径不变
export { DraftFieldSchema, DraftFieldsSchema, DraftsData, TaskDetailSchema };

/**
 * 插话项（对话中「插嘴」的待投递消息）。
 * 与草稿同文件同生命周期（任务目录 .diy/drafts.yaml 的 steers 字段），
 * 但语义是**队列**：FIFO，提交后等模型取走。两种模式**都是整批取走**（多条合并成同一批），
 * 差别只在投递点：next-step = 下一个模型步边界之前（本轮内生效）；next-turn = 本轮收尾后的下一轮开场。
 */
export const SteerItemSchema = z.object({
  id: z.string(),
  mode: z.enum(["next-step", "next-turn"]),
  text: z.string(),
  created: z.string(),
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
              persona: z.string().optional().cliOption({ desc: "agent 人物 id（不传 = 跟随缺省；传值 = 固定绑定，人物决定模型/参数/行为指令）" }),
              change_type: ChangeTypeSchema.optional().cliOption({ desc: "变更性质（feat/fix/docs/…，见 conventional commits）" }),
              module: z.string().optional().cliOption({ desc: "模块（可 `/` 分层，如 agent/ui）" }),
              priority: PrioritySchema.optional().cliOption({ desc: "优先级 P0-P3（不传=未定级）" }),
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
                desc: `清除草稿字段（不传 fields 清空全部字段；传 [] 什么都不清。只动草稿字段，不动待投递的插话队列；文件在字段与队列都空时才删除）`,
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
              // 三态：不传=保持原绑定 / `default`（或空串）=**跟随缺省**（取消固定绑定）/ 值=换绑到该人物。
              // 换绑是续聊（会话与上下文不动），新模型**下一轮**生效。
              persona: z
                .string()
                .optional()
                .cliOption({ desc: "agent 人物 id（不传=保持；default=跟随缺省；值=固定绑定，模型下一轮生效）" }),
              change_type: z.string().optional().cliOption({ desc: "变更性质（feat/fix/…；空字符串=清除）" }),
              module: z.string().optional().cliOption({ desc: "模块（空字符串=清除）" }),
              priority: z.string().optional().cliOption({ desc: "优先级 P0-P3（空字符串=清除回未定级）" }),
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
          /** 数据根的展示形式（相对**真实家目录**缩 `~`；隔离/临时根保持绝对路径）。
           *  窗口标题与界面展示用 —— renderer 拿不到真实家目录，缩写规则只能由 main 侧算
           *  （见 shared/instance-title 的 abbrevHome + main/core/instance-identity.ts）。 */
          diyHomeDisplay: z.string(),
          /** 当前代码仓库/ worktree 的展示路径（窗口标题用） */
          repoDisplay: z.string(),
          /** 运行环境（production/development/test）。dev/test 的界面与生产几乎一样，
           *  必须能看出来，否则容易误改生产数据。 */
          env: z.string(),
          /** 当前运行代码所在 git 分支（打包/非仓库为空串）。窗口标题用它区分
           *  「哪个 worktree 的构建」—— 数据根是 /tmp 或 build/home 时这是唯一来源线索。 */
          branch: z.string(),
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
        // cliArg：不给它的话 `diy getTask <uri>` 完全没法从命令行调（"Unknown option"），
        // 于是这条 RPC 的载荷**只能靠跑 Electron 才能验证** —— 契约漏字段的 bug 就更容易溜过。
        input: { uri: z.string().cliArg({ desc: "任务 URI" }) },
        // 字段清单**不在此处手抄**：契约是 shared/task-detail.ts 的 TaskDetailSchema（单一真源，
        // renderer 的 TaskDetail 类型也从它推导）—— 加字段只改那一处。
        // 背景（此前的真实缺陷）：这里与 api-impl 的 handler **两处各抄一份**，漏一处就静默丢字段
        // （zod .object() 默认 strip 未声明键，实测漏过 change_type / module / priority / persona：
        //  renderer 拿到 undefined、详情面板显示"未设置"，而数据其实好好的）。那份手抄已被 167 取代。
        output: z.object({
          status: z.string(),
          // 未找到 → data: null，renderer 侧 `if (r.data)` 守卫才能生效
          data: TaskDetailSchema.nullable(),
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
          // —— agent 人物（persona）——
          // 人物是**配置实体**：模型/参数/行为指令挂在这里，会话只持有引用（任务 frontmatter 的 persona）。
          // 于是「改人物」= 所有引用它的任务下一轮统一生效；「换人物」= 只改本任务的绑定，不碰别人。
          persona: RpcSchema.group({
            desc: `agent 人物（模型 + 参数 + 行为指令）；任务持**引用（id）**，改人物对使用它的会话下一轮生效`,
            children: {
              list: RpcSchema.unary({
                desc: `列出全部人物与缺省人物（含各人物被多少任务引用）`,
                input: {},
                output: z.object({
                  default: z.string().describe("缺省人物 id（跟随缺省的任务用它）"),
                  // taskCount = 引用面：改人物前必须先看见"会影响多少任务"（否则"统一修改"是盲改）
                  personas: z.array(PersonaSchema.extend({ taskCount: z.number() })),
                  // followCount = **跟随缺省**的任务数（不写 persona 键，故不计入任何人的 taskCount）。
                  // 改缺省影响的就是这批任务 —— 不给这个数，缺省人物在面板上会显示"暂无任务在用"。
                  followCount: z.number().describe("跟随缺省的任务数（改缺省会影响它们）"),
                }),
              }),
              set: RpcSchema.unary({
                desc: `新建人物（不传 id）或更新人物（传 id）；未给的字段保持原值`,
                input: {
                  // 位置参数（可省略）：`diy agent persona set p3 --model …` 更新，不传 = 新建。
                  // 位置参数给 id 而不是名字：脚本/自动化要的是稳定键；人按名字用 --name。
                  id: z.string().optional().cliArg({ desc: "人物 id（更新时给；不传 = 新建人物）" }),
                  name: z.string().optional().cliOption({ desc: "显示名（可改，引用不受影响）" }),
                  model: z.string().optional().cliOption({ desc: "模型 id（见 agent local models；新建时必填）" }),
                  reasoningEffort: z
                    .string()
                    .optional()
                    .cliOption({ desc: "推理强度档位（按该模型支持集，见 agent local models）" }),
                  instructions: z.string().optional().cliOption({ desc: `行为指令（注入身份节；空串=不注入）` }),
                },
                output: PersonaSchema,
              }),
              setDefault: RpcSchema.unary({
                desc: `设置缺省人物（只影响之后**新建**的任务，已有任务的绑定不变）`,
                input: {
                  id: z.string().cliArg({ desc: "人物 id（或显示名）" }),
                },
                output: z.object({ default: z.string() }),
              }),
              // 暂不提供 remove：人物的价值是"可复用的配置实体"，删掉它所有引用者会静默回落缺省
              // （换模型不打招呼）。要下线一个人物，改它的模型/行为指令即可（引用者原地跟随）；
              // 真需要删除时再设计"引用迁移"（改绑 N 个任务）一起做，不做半截的删除。
            },
          }),

          local: RpcSchema.group({
            desc: `本地自定义 agent（ai-sdk，独立于 ACP 通道）`,
            children: {
              chat: RpcSchema.serverStream({
                desc: `本地 agent 对话 — 实时逐行输出块协议 Op（JSONL）`,
                input: {
                  taskUri: z.string().cliArg({ desc: "任务 URI" }),
                  message: z.string().cliArg({ desc: "用户消息" }),
                  mode: z
                    .enum(["next-step", "next-turn"])
                    .optional()
                    .cliOption({
                      desc: "给出则把消息入队（next-step=下一个模型步前生效；next-turn=本轮收尾后的下一轮开场；两者都整批投）；省略则立即开一轮",
                    }),
                  // 下面两项是**临时覆盖**，不写配置：模型/参数的真源是任务绑定的人物
                  // （diy agent persona …）。UI 不传，留着是给 CLI/调试临时试模型用。
                  model: z.string().optional().cliOption({ desc: `临时覆盖模型（缺省 = 任务当前人物的模型）` }),
                  reasoningEffort: z.string().optional().cliOption({ desc: "临时覆盖推理强度（缺省 = 人物配置）" }),
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
              /**
               * 运行态真值查询：renderer 的私有 `running` 只表示"我这轮在等自己的流"，
               * 回答不了「别人（CLI/另一窗口）是否正在这个任务上跑」。
               * 真相在主进程内存里（runtime-context 的 activeTurns —— LocalAgentManager 的 running 会话）：
               * 把它查出来，UI 才不会把别人正在跑的轮次误判成「流中断」，也才谈得上给它一个停止入口。
               */
              running: RpcSchema.unary({
                desc: `列出此刻真正在跑的本地 agent 轮次（主进程内存权威；UI 判「直播中/可停止」用它，不靠日志猜）`,
                input: {},
                output: z.object({
                  active: z.array(
                    z.object({
                      taskUri: z.string(),
                      model: z.string().optional(),
                      cwd: z.string().optional(),
                      since: z.string().describe("轮次起始 ISO 时间"),
                    }),
                  ),
                }),
              }),
              history: RpcSchema.unary({
                desc: `读取本地 agent 会话的块协议 Op 日志（UI 重放用）`,
                input: {
                  taskUri: z.string().cliArg({ desc: "任务 URI" }),
                },
                output: z.array(z.any()),
              }),
              clear: RpcSchema.unary({
                desc: `清空本地 agent 会话（中断生成、删除 Op/LLM 日志，并清空待投递的插话队列）`,
                input: {
                  taskUri: z.string().cliArg({ desc: "任务 URI" }),
                },
                output: z.object({ cleared: z.boolean() }),
              }),
              /** 插话队列管理（入队走 `chat --mode`）。step=下一个模型步前；turn=本轮结束后的下一轮。 */
              steer: RpcSchema.group({
                desc: `插话队列：对话中追加的发言（入队走 chat --mode），落任务目录 .diy/drafts.yaml`,
                children: {
                  list: RpcSchema.unary({
                    desc: `列出待投递的插话（FIFO，顺序即投递顺序）`,
                    input: {
                      taskUri: z.string().cliArg({ desc: "任务 URI" }),
                    },
                    output: z.array(SteerItemSchema),
                  }),
                  cancel: RpcSchema.unary({
                    desc: `取消一条待投递插话（幂等：id 不存在返回原队列）`,
                    input: {
                      taskUri: z.string().cliArg({ desc: "任务 URI" }),
                      id: z.string().cliArg({ desc: "插话 id（见 steer list）" }),
                    },
                    output: z.array(SteerItemSchema),
                  }),
                  toggleMode: RpcSchema.unary({
                    desc: `切换一条插话的投递时机（next-step ⇄ next-turn）`,
                    input: {
                      taskUri: z.string().cliArg({ desc: "任务 URI" }),
                      id: z.string().cliArg({ desc: "插话 id（见 steer list）" }),
                    },
                    output: z.array(SteerItemSchema),
                  }),
                  reorder: RpcSchema.unary({
                    desc: `重排待投递插话的顺序（顺序即投递顺序；入参是期望的完整 id 顺序）`,
                    input: {
                      taskUri: z.string().cliArg({ desc: "任务 URI" }),
                      ids: z
                        .array(z.string())
                        .cliArg({ desc: `期望顺序（JSON 数组，如 '["steer/2","steer/1"]'）` }),
                    },
                    output: z.array(SteerItemSchema),
                  }),
                },
              }),
              models: RpcSchema.unary({
                desc: `列出本地 agent 可选模型（zen/go；api 面逐个标注，见 local-agent.ts apiOf）`,
                input: {},
                output: z.array(
                  z.object({
                    id: z.string(),
                    name: z.string(),
                    api: z.enum(["chat", "responses"]),
                    contextLimit: z.number(),
                    maxOutputTokens: z.number(),
                    reasoning: z.object({
                      supported: z.array(z.string()),
                      default: z.string(),
                    }),
                  }),
                ),
              }),
              limits: RpcSchema.unary({
                desc: `查询生效运行限制（默认值 < $DIY_HOME/local/limits.json < 环境变量 DIY_LOCAL_*）`,
                input: {},
                output: z.object({
                  maxSteps: z.number(),
                  maxOutputTokens: z.number(),
                  bashTimeoutMs: z.number(),
                  outputClipChars: z.number(),
                  readMaxBytes: z.number(),
                }),
              }),
              /**
               * 逐步用量账本（`<key>.usage.jsonl`）：结构化返回，UI 的明细/看板与 CLI 走**同一份数据**。
               * 不做服务端预聚合 —— 分组/汇总在 shared/usage.ts 里（纯函数），两端同一套口径。
               */
              usage: RpcSchema.unary({
                desc: `读取本地 agent 的逐步用量账本（每步四桶 + raw + 身份 + 单价快照 + 金额）`,
                input: {
                  taskUri: z.string().cliArg({ desc: "任务 URI" }),
                },
                output: z.array(z.any()),
              }),
            },
          }),

          /**
           * 会话用量报表（人看的口径）：CLI 直出的等宽表格。
           *
           * 为什么不复用 agent.local.usage：那条给 UI 结构化数据；这条是**人读**的渲染
           * （对齐、单位、n/a 表达都在 main 里做一次）。两者共用同一份账（usage.jsonl）
           * 与同一套聚合（shared/usage），不是两套统计。
           */
          usage: RpcSchema.unary({
            desc: `查看任务会话的 token 用量与金额（逐步明细 / --by-agent 按人物+模型+面+档位汇总）`,
            input: {
              task: z.string().cliArg({ desc: "任务 URI" }),
              last: z.number().optional().cliOption({ desc: "只看最近 N 步" }),
              cost: z.boolean().optional().cliOption({ desc: "展开金额细分列（非缓存/缓存读/缓存写/文本/思考）" }),
              byAgent: z.boolean().optional().cliOption({ desc: "按人物+模型+面+档位汇总（多 agent 多行）" }),
            },
            output: z.string(),
          }),
        },
      }),

      /**
       * 文件读取工具（行窗口 + 续读）。
       *
       * 为什么不复用内置 read 工具：内置 read 是**模型工具调用**，只在 agent 会话里可达；
       * CLI 侧需要一份等价能力 —— agent 可经 bash 调它（绕开工具输出的截断），人也能直接看。
       * 两侧共用 core/file-read.ts 的同一实现（窗口语义只有一份，见该文件头注释）。
       */
      tool: RpcSchema.group({
        desc: `工具（文件读取：行窗口 + 续读）`,
        children: {
          read: RpcSchema.unary({
            desc: `
            读取文本文件（行窗口，可续读）

            与整文件截断的关键差别：超出上限时尾部给出 --offset 续读入口，
            可精确跳到没读过的部分，不会像「取头尾、丢中间」那样永久丢失中段。
            行/字节双限（缺省 2000 行 / 50KB，谁先到算谁）。
            不设单行字符数上限 —— 单行只受同一份字节预算约束（jsonl 这类「一行一条记录」
            的文件不会被砍半行）。
            `,
            input: {
              // resolvePath：相对路径按**敲命令的 shell 的 cwd** 解析成绝对路径（见 rpc cli/_parser.ts）。
              // 不能靠 handler 侧的 process.cwd() —— 那是 app 进程的应用目录，不是用户的目录。
              path: z.string().cliArg({ desc: "文件路径（相对路径按当前目录解析）", resolvePath: true }),
              offset: z.number().optional().cliOption({ desc: "起始行，1-based（缺省 1）" }),
              limit: z.number().optional().cliOption({ desc: "最大行数（缺省 2000）" }),
            },
            output: z.string(),
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
              model: z.string().optional().cliOption({ desc: `模型 id（缺省 gpt-5.6-luna；应传会话实际选中的模型才算保真）` }),
              // 无 CLI 注解：CLI 解析器忽略，RPC 照传（未存盘草稿渲染用）
              drafts: z.record(z.string(), z.string()).optional().describe("未存盘草稿 relpath→正文"),
            },
            output: RequestPreviewSchema,
          }),
        },
      }),

      context: RpcSchema.group({
        desc: `上下文树（当前任务的真实系统上下文；只组装不发送）`,
        children: {
          config: RpcSchema.unary({
            desc: `读划分规则（$DIY_HOME/context.yaml；真发与页面共用这一份）`,
            input: {},
            output: z.object({
              systemPlaces: z.array(z.string()).describe("当前生效的 system 单元（其余自动 runtime）"),
              defaults: z.array(z.string()).describe("推荐名单（文件缺失/清空时用它）"),
              fromFile: z.boolean().describe("是否来自 context.yaml（false = 用推荐名单）"),
            }),
          }),
          setConfig: RpcSchema.unary({
            desc: `写划分规则（非法路径或互为祖先/后代一律拒绝；下一轮真发生效）`,
            input: {
              systemPlaces: z.array(z.string()).cliOption({ desc: "进 system 的单元（JSON 数组）" }),
            },
            output: z.object({ systemPlaces: z.array(z.string()) }),
          }),
          candidates: RpcSchema.unary({
            desc: `列出候选投递单元与默认 system 名单`,
            input: {},
            output: z.object({
              candidates: ContextPlaceCandidateSchema,
              defaultSystem: z.array(z.string()),
            }),
          }),
          lab: RpcSchema.unary({
            desc: `上下文树数据：变量树 + 划分规则 + system/runtime 两份 + 合成消息`,
            input: {
              project: z.string().cliArg({ desc: "project id" }),
              taskUri: z.string().optional().cliOption({ desc: "任务 URI（缺省则只有项目级上下文）" }),
              systemPlaces: z
                .array(z.string())
                .optional()
                .cliOption({ desc: "划入 system 的投递单元（JSON 数组；缺省用推荐名单，其余自动 runtime）" }),
              model: z.string().optional().cliOption({ desc: "模型 id（请求体预览用；缺省取默认模型）" }),
            },
            output: ContextLabSchema,
          }),
          steps: RpcSchema.unary({
            desc: `每轮真发的投递快照（step）：值变化 + 两份容器的 diff（默认只给统计，--diff 给行内容）`,
            input: {
              taskUri: z.string().cliArg({ desc: "任务 URI" }),
              limit: z.number().optional().cliOption({ desc: "只看最近 N 步（缺省全部）" }),
              diff: z
                .boolean()
                .optional()
                .cliOption({ desc: "带上行级 diff 内容（默认只有增删统计，避免下发整份文本）" }),
            },
            output: StepsSchema,
          }),
          stats: RpcSchema.unary({
            desc: `节点变更统计（按项目累计；回答"用了几天，某节点变了几次"）`,
            input: {
              project: z.string().cliArg({ desc: "project id" }),
              taskUri: z.string().optional().cliOption({ desc: "只算某个任务（缺省：整个项目累计）" }),
              limit: z.number().optional().cliOption({ desc: "只看最近 N 轮（缺省全部）" }),
            },
            output: StatsSchema,
          }),
          diff: RpcSchema.unary({
            desc: `某步 vs 上一步的 diff；不给 --step 则是「当前变量树 vs 最后一步」（main 侧算完）`,
            input: {
              project: z.string().cliArg({ desc: "project id" }),
              taskUri: z.string().cliArg({ desc: "任务 URI" }),
              step: z.number().optional().cliOption({ desc: "第几步（1 基）；缺省 = 当前 vs 最后一步" }),
              systemPlaces: z
                .array(z.string())
                .optional()
                .cliOption({ desc: "当前投递的 system 名单（缺省用推荐名单）" }),
            },
            output: ContextDiffSchema.nullable(),
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
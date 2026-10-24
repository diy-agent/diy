// src/shared/prompt-schema.ts
// 🎯 提示词模版域的**唯一契约源**（纯 zod，无 node 依赖）。
//
// 为什么单独一个文件：
//   - api-def.ts（main + renderer 双向共用）在这里取 output schema；
//   - prompt-registry.ts（main 实现）从这里取 TS 类型；
//   - renderer 的 promptLabCommon 也从这里取类型。
//   三处共用一份定义，才不会有「手抄第二份 PromptEntry」的漂移（历史问题）。
//
// 约定：本文件只放 schema/类型，禁止 import node:fs 等 main 专属模块 —— renderer 会打进包。

import { z } from "zod";
import { ReqlogSchema } from "./context/reqlog";
import { TASK_HEAD_FIELDS, type TaskHeadField } from "./task-head";

/** 头字段的 zod 形状：从 TASK_HEAD_FIELDS 派生（清单在 ./task-head，见该文件头注）*/
const TASK_HEAD_SHAPE = Object.fromEntries(
  TASK_HEAD_FIELDS.map((f) => [f.key, z.string().describe(f.desc)] as const),
) as { [K in TaskHeadField]: z.ZodString };

/** 模版条目（含生效正文与覆盖状态） */
export const PromptEntrySchema = z.object({
  relpath: z.string(),
  title: z.string(),
  desc: z.string(),
  version: z.number(),
  /** 是否锁定（不可覆盖）；命名约定：`_` 前缀 = 锁定，由 lint 保证一致 */
  locked: z.boolean(),
  /** 锁定时展示给用户的理由 */
  lockTip: z.string(),
  /**
   * 角色：入口（_system.md）/ 节（被入口 include）/ 片段（独立模版，不在 system 装配里）。
   * 由入口的 include 列表**推导**，不手工维护。
   */
  role: z.enum(["entry", "section", "fragment"]),
  status: z.enum(["builtin", "overridden"]),
  current: z.string(),
  builtin: z.string(),
  baseVersion: z.number().nullable(),
  stale: z.boolean(),
});
export type PromptEntry = z.infer<typeof PromptEntrySchema>;

/** 技能条目（skills 的元素类型；命名供变量树显示为 [Skill]） */
export const SkillSchema = z
  .object({
    name: z.string().describe("技能名"),
    desc: z.string().describe("说明"),
  })
  .meta({ id: "Skill" });

/** AGENTS.md 链的一层（chain 的元素类型） */
export const ChainItemSchema = z
  .object({
    path: z.string().describe("AGENTS.md 路径"),
    scope: z.string().describe("生效目录"),
    content: z.string().describe("正文"),
  })
  .meta({ id: "ChainEntry" });


/** 事实投影的一个值（见 AssembleGlobalsSchema.facts 的说明） */
export const FactsCellSchema = z
  .object({
    value: z.string().describe("已解析的值"),
    resolvedBy: z
      .string()
      .optional()
      .describe("按什么解析出这个值的（`env=development` / `paths=pkgs.ts/...`）。**缺省不输出** = 全局唯一（无变体歧义）"),
    variants: z
      .number()
      .optional()
      .describe("同 claim 的可用变体总数。**缺省不输出** = 1（没有别的值存在）"),
  })
  .meta({ id: "FactsCell" });
export type FactsCell = z.infer<typeof FactsCellSchema>;

/**
 * 注入 globals 的**契约（单一真源）**：
 *   · `flattenVars()` 派生出引擎静态校验用的扁平 VarSpec[]
 *   · `buildVarTree()` 派生出试验场「变量定义」view 的二维树（名字/类型 + 说明）
 *   · 装配时 `safeParse` 校验注入与契约是否漂移（漂移 → 上屏告警，不静默）
 * 注意：只放 schema/类型，禁止 import node:fs（renderer 会打进包）。
 */
export const AssembleGlobalsSchema = z.object({
  persona: z
    .object({
      name: z.string().describe("当前人物名"),
      instructions: z.string().describe("人物行为指令（空则不注入）"),
    })
    .describe("agent 人物"),
  diy: z
    .object({
      cli: z.string().describe("CLI 入口"),
      home: z.string().describe("数据根"),
    })
    .describe("diy 本体"),
  project: z
    .object({ path: z.string().describe("项目工作目录") })
    .describe("项目"),
  task: z
    .object({
      uri: z.string().describe("任务 URI"),
      // 任务头字段（含 title/state）：**清单不在此手抄**，从 shared/task-detail.ts 的
      // TASK_HEAD_FIELDS 派生（##322 review R3）—— 三处手抄必漏一处。它们是任务文件
      // frontmatter 的同一份；空串 = 文件头里没有这个键。
      ...TASK_HEAD_SHAPE,
      body: z.string().describe("正文（文件里 frontmatter 之后的部分，首尾空白已去）"),
      dir: z.string().describe("任务目录"),
    })
    .describe("当前任务"),
  cwd: z
    .object({
      path: z.string().describe("工具执行目录"),
      note: z.string().describe("回退原因"),
      isFallback: z.boolean().describe("是否已回退"),
      isTaskDir: z.boolean().describe("是否任务目录"),
      isAppDir: z.boolean().describe("是否 diy 仓库"),
    })
    .describe("工作目录与回退"),
  chain: z.array(ChainItemSchema).describe("AGENTS.md 链（逐层，用 :for 迭代）"),
  skills: z.array(SkillSchema).describe("技能清单（空则整节跳过）"),
  /**
   * 模版节的**渲染结果**（144「模版即节点」方向的第一步）。
   *
   * 为什么放进 globals：真发（Context Tree 投递）要的不只是 `persona` 的**值**，
   * 而是模版渲染出来的**整节文本** —— identity.md 里有身份行 + 人物行为指令，
   * rules.md 是行为规范，_guard.md 是保命契约（禁止自杀式命令）。它们不在这里，
   * 真发就一样不投（209 review P0-1：真发 system 里 persona/身份/<rules>/<guard> 全 false）。
   * 渲染结果进 globals 而不是在投递处另拼一段：投递构造保持**单一入口**（buildDelivery），
   * 页面结构树/规则表也能看见这三个节点（否则页面上会多出一段"无来源"的文本）。
   */
  identity: z.string().describe("身份节（identity.md 渲染结果：身份行 + 人物行为指令）"),
  rules: z.string().describe("规范节（rules.md 渲染结果）"),
  guard: z.string().describe("保命契约（_guard.md 渲染结果，模版锁定）"),
  /**
   * 真发请求的**流量日志**（用户 2026-10-15）。
   *
   * 为什么进变量树：「我自己的东西在哪、怎么找」是**稳定**信息（只在换天时变文件名），
   * 模型才能自查"我上一步到底发出去了什么"——上下文树主要是给模型**定位**信息用的。
   * **值只有 `file` 一个字段**；路径规则 / 定位命令 / 字段表全在 `.describe()` 里，
   * 派生进信封的 `help.reqlog`（值节点里禁出现解释性字段：一条信息只在一处，见 envelope.ts）。
   * 行号给不出来：那条记录是请求发出**之后**才落盘的（UI 侧由流量日志反查）。
   */
  reqlog: ReqlogSchema,
  /**
   * **房间上下文**（##377 第 26 刀）：这一轮该看到的房间成员 + 近期别人的发言。
   *
   * 为什么拆成 `members` / `recent` **两个原子单元**：runtime 的增量判定是
   * `renderedHash` **按 place 逐条比**（`shared/context/projection.ts`）—— 合成一个单元时，
   * 成员改个名就会把整段 recent 重发一遍 diff（白烧 token、把上下文变成高频消息流）。
   *
   * 为什么不是一段拼好的中文：值是**结构化数据**，拼装归模版层（信封由通用渲染器出 YAML）。
   * 拼好的话既没法裁、也没法 diff，还会退化成"与正文不可区分的机制文本"（压缩会当人话改写）。
   *
   * 缺席（`undefined`）= 这个任务没有房间（从没开过任务页、也没被投递过）⇒ 单人任务逐字不变。
   */
  /**
   * **事实库投影**（##404 待办 4）：任务库 + 项目库已解析后的值。
   *
   * 为什么进变量树而不是在投递处拼一段文本：与 identity / rules 同理 ——
   * 拼好的文本既看不见（上下文树页无节点）、也没法 diff（改一条 = 整段重发），
   * 还会退化成"与正文不可区分的机制文本"（压缩会当人话改写）。
   *
   * 为什么给**已解析值**而不是变体列表：让 agent 读到 `18888` 却不知道自己在哪个
   * 环境，就会把 production 的端口当成 lab 的。故条目带 `resolvedBy` / `variants`，
   * 由它自己判断要不要追问（`diy facts get <claim> --in task:<uri>`）。
   *
   * 为什么 claim 作 map 的 key 而不是数组里的 id 字段：`id` 可派生（= `subject#aspect`），
   * 数组形式每个元素都要重复一遍 subject 与 aspect，且引用起来要遍历。
   *
   * 缺席（`undefined`）= 这个任务既没有任务级库、也没有项目级库 ⇒ 与未接入前逐字不变。
   */
  facts: z
    .object({
      algorithm: z
        .enum(["yaml-nested", "flat-gid", "md-list"])
        .describe(
          "投影算法（与 `@diy/facts` 的 `PROJECTION_ALGORITHMS` 同名，别在此另起一套）：" +
            "`yaml-nested` = claim 分组的 map（缺省）；`flat-gid` = gid 扁平 map；`md-list` = 一段 markdown 表",
        ),
      env: z.string().describe("解析变体用的环境（`DIY_ENV`）：production / development / test"),
      task: z
        .record(z.string(), FactsCellSchema)
        .optional()
        .describe("**任务级库**的已解析值（claim → 值）。本任务自己的结论，优先级最高"),
      global: z
        .record(z.string(), FactsCellSchema)
        .optional()
        .describe("**设备级库**（`~/.diy/knowledge/`）的已解析值（claim → 值）。跨项目的用户规则；同名 claim 时**项目库优先于它**（task > project > global）"),
      project: z
        .record(z.string(), FactsCellSchema)
        .optional()
        .describe("**项目级库**的已解析值（claim → 值）。跨任务共享的结论"),
      text: z
        .string()
        .optional()
        .describe("**仅 `md` 算法**：整份投影的 markdown 表（此时 task/project 缺席 —— 同一种内容不给两种形状）"),
      omitted: z.number().describe("因预算被裁掉的条目数（>0 ⇒ 还有没带进来的，用 `diy facts status` 看）"),
      omittedClaims: z
        .array(z.string())
        .optional()
        .describe(
          "被裁掉的 claim（采样，最多 5 个）：`diy facts get <其一>` 就能把它捞回来。" +
            "数目看 `omitted`，这里只给「叫什么」—— 没有名字就没有动作",
        ),
      overhead: z
        .number()
        .optional()
        .describe(
          "包装开销（字节，不进预算）：`<claim>: {value,resolvedBy,variants}` 外壳本身。" +
            "预算按**值字节**算（与 `diy facts submit` 的校验同口径），故实际文本 ≈ 预算 + 本字段 —— " +
            "`omitted > 0` 才是「装不下」，这里大只是外壳多",
        ),
      problems: z
        .array(z.object({ gid: z.string().describe("哪一条（`<ns>:<claim>`）"), code: z.string().describe("机器码（`facts/*`）") }))
        .describe("**真问题**：冲突 / 库内缺 claim。空数组 = 正常"),
    })
    .optional()
    .describe("事实库投影（没有库时缺席）"),
  /**
   * **知识库索引**（##404）：知识库里**有什么**，正文不进上下文。
   *
   * 为什么必须有这一段：AGENTS.md 链占 system 81%（28.3 KB）且全量常驻，其中一大半是
   * 「不查也行、查了才用得上」的说明性内容（三方源码位置、术语表、异常三档判据…）。
   * 把那些迁进知识库、链上只留指针后，agent 仍要知道**有库、库里有什么**才谈得上"按需查"
   * —— 这一段就是那个索引，也是迁移的**前提**（先给索引、再删正文，否则能力直接丢失）。
   *
   * 为什么只给 subject + description：字节量与**条目数无关**，只随主题数增长（26 主题 ≈ 1.5 KB），
   * 拿它换掉 25 KB 常驻正文是唯一划算的量级。条目全文归 `facts` 投影（runtime，有 4 KB 硬预算）。
   */
  kb: z
    .object({
      claims: z
        .number()
        .describe(
          "全库条目总数，**claim 口径**（subject#aspect；跨库同 claim 只算一条，与 `facts brief` / `status` 同口径 —— 不是 facts 数：同一 claim 的多个 env 变体算一条）。与索引里各主题的条数之和对不上 ⇒ 有主题缺 description 没进索引",
        ),
      entries: z
        .array(
          z.object({
            subject: z.string().describe("主题（`diy facts get <主题>#<方面>` 的前半）"),
            desc: z.string().describe("一句话说清这个对象（直接取自 subject 词表的 description）"),
            claims: z.number().describe("该主题下的条目数（claim 口径，= `facts brief <主题>` 的 claims；跨库同 claim 只算一条）"),
            ns: z
              .array(z.string())
              .describe(
                "在哪些库：project（仓库 knowledge/）/ global（设备级）。两个都在 = 项目库覆盖设备库那份；查的时候带 `--in` 指定",
              ),
          }),
        )
        .describe("可查主题索引（按主题名排序）"),
    })
    .optional()
    .describe("知识库索引（没有库时整节缺席）"),
  /**
   * **仓库文档索引（摘要）**（##404 / ##5 第 11 轮 B）：`docs/` 是设计的活真源，但它不在任何
   * AGENTS.md 链上 —— 只给一句"有这些、怎么查"，agent 才知道去 `diy docs index` 看全表。
   *
   * 为什么变量树里**只有摘要**、逐篇条目归 CLI：实测逐篇 18 行 ≈ 2 KB/轮，全仓所有任务都付；
   * 而"有哪些文档"是一次性好奇，不是每轮必需。按需 query 一次比每轮常驻更划算
   * （判据与账在 `shared/docs.ts` 头注）。这也是它与 `kb` 的差别：kb 主题数有限且稳定，
   * docs 的篇数随开发线性增长 —— 常驻那份必然越活越贵。
   *
   * 缺席（`undefined`）= 这个仓库没有可索引的文档 ⇒ 与未接入前逐字不变。
   */
  docs: z
    .object({
      roots: z.array(z.string()).describe("扫描根（仓库相对）：缺省只有 `docs/plans`（设计稿正区），可 `--roots` 扩到 `docs`"),
      count: z.number().describe("可索引篇数"),
      newest: z.string().optional().describe("全部文档里最新的 git 改动日（`YY-MM-DD`）；非 git / 未提交则缺席"),
    })
    .optional()
    .describe("仓库文档索引**摘要**（没有文档时整节缺席）。逐篇索引（路径 / 标题 / 字节 / 状态词 / 两日期）按需取：`diy docs index`"),
  room: z
    .object({
      members: z
        .object({
          roomId: z.string().describe("房间 id（本任务自己的房间 = 任务 URI；投递轮 = 来源房间）"),
          name: z.string().describe("房间显示名（任务房间 = #任务号；侧边栏房间 = 实例短名）"),
          list: z
            .array(
              z.object({
                id: z.string().describe("成员 id（可 @ 寻址的全式）"),
                name: z.string().describe("显示名（人物名 / 人名）"),
                key: z.string().describe("此刻真能打中的 @ 键（提示与解析同一份判据）"),
                main: z.boolean().describe("是否本任务自己的会话主人"),
              }),
            )
            .describe("房间成员（按人先 agent 后排序）"),
        })
        .describe("房间成员：低频单元（谁在房里 / 别名 / 是否主人格；改成员才变）"),
      recent: z
        .object({
          items: z
            .array(
              z.object({
                from: z.string().describe("发言者的 @ 键"),
                at: z.string().describe("发言时刻（ISO）"),
                text: z.string().describe("发言正文"),
              }),
            )
            .describe("自上次以来**别人**的发言（时间正序；不含自己说的、不含正文里这一条）"),
          omitted: z.number().describe("因上限被省略的更早条数（>0 ⇒ 更早的没带进来）"),
        })
        .describe("房间近期发言：高频单元（有人说话就变；没有新发言时**整个单元缺席**）")
        .optional(),
    })
    .optional()
    .describe("房间上下文（没有房间时缺席）"),
  /**
   * **自量**（##404 / ##9 提案）：agent 自己的钱与窗口 —— 三个**能改变行为**的数。
   *
   * 为什么进 runtime 而不是 system：这些数**每步都变**（`window` 随本步 token、`last` 随上一步、
   * `turn` 随本轮累计），进 system ⇒ 前缀缓存每步作废（实测 cacheRead 占 92~99%，一改就是几十倍
   * 输入成本）。故 `PLACE_CANDIDATES` 里 `system: false`。
   *
   * 为什么只这三个：别的（tok/s、per-tool 耗时、chunk 间隔）看得到但无法据此改变决定 ——
   * 纯占字节且稀释注意力（判据在 `shared/context/self.ts` 头注）。
   *
   * 缺席（`undefined`）= 一条数都给不出（新进程首轮首步）⇒ 与未接入前逐字不变。
   * 子项缺席 = **量不到**（不是 0）：`window` 要窗口上限、`last.cost` 要价目表。
   */
  self: z
    .object({
      window: z
        .object({
          used: z.number().describe("上一步请求的总 token（输入 + 输出）；窗口占用的分子"),
          limit: z.number().describe("模型窗口上限（tokens）"),
          ratio: z.number().describe("`used / limit` 的**百分数**（0~100，1 位小数）：>60 就该收尾 / 少堆长输出"),
        })
        .optional()
        .describe("上下文窗口占用（取**上一步**：本步发出去之前就已经知道用了多少）；窗口上限未知则缺席"),
      last: z
        .object({
          cacheHit: z.number().optional().describe("上一步的缓存命中率**百分数**（0~100）。从 90+ 掉到 <50 ⇒ 前缀缓存被打断（多半是刚动了 system 段），输入成本会翻数倍"),
          output: z.number().describe("上一步的输出 token（文本 + 思考）"),
          cost: z.number().optional().describe("上一步金额（USD）；无价目则缺席（**不是 0**）"),
        })
        .optional()
        .describe("上一步的实际消耗"),
      turn: z
        .object({
          steps: z.number().describe("本轮已走步数"),
          cost: z.number().optional().describe("本轮累计金额（USD）；一步都没价目则缺席"),
          unpriced: z.number().optional().describe("本轮无价目的步数（>0 ⇒ `cost` 是部分和，不是完整花费）"),
        })
        .optional()
        .describe("本轮累计（进程重启不影响它：来自本轮现场）"),
    })
    .optional()
    .describe("自量：窗口占用 / 上一步消耗 / 本轮累计（每步都变，故归 runtime；量不到的子项缺席，不写 0）"),
});
export type AssembleGlobals = z.infer<typeof AssembleGlobalsSchema>;

/** 变量契约的扁平条目（引擎静态校验用；由 AssembleGlobalsSchema 派生）。
 *  定义在 `@diy/template`：**引擎与宿主共用一份**（引擎校验读它、宿主 fork 出注入值产它）——
 *  在这里再声明一份，引擎新加的字段（如 `dynamicKeys`）宿主侧就看不见。 */
export type { VarSpec } from "@diy/template";

/** 渲染结构 trace 节点（试验场「模版结构树」：每个节点的产出字节 + :if 真假原因 + 迭代次数） */
export type TraceNode = {
  kind: string;
  /** 节点显示名：:if / :for / include / 标签 / 插值 / 文本 / 迭代项 */
  name?: string;
  /** 参数 = 模版里写的（表达式、relpath、字面文本片段） */
  arg?: string;
  /** 值 = 参数求值后的单行紧凑文本 */
  value?: string;
  bytes: number;
  /** 所属模版 body 里的源码区间（点模版结构树 → 高亮模版） */
  src?: { from: number; to: number };
  /** 渲染结果里的字符区间（点模版结构树 → 高亮预览） */
  out?: { from: number; to: number };
  result?: boolean;
  reason?: string;
  children?: TraceNode[];
};
export const TraceNodeSchema: z.ZodType<TraceNode> = z.lazy(() =>
  z.object({
    kind: z.string(),
    name: z.string().optional(),
    arg: z.string().optional(),
    value: z.string().optional(),
    bytes: z.number(),
    src: z.object({ from: z.number(), to: z.number() }).optional(),
    out: z.object({ from: z.number(), to: z.number() }).optional(),
    result: z.boolean().optional(),
    reason: z.string().optional(),
    children: z.array(TraceNodeSchema).optional(),
  }),
);

/** 系统上下文装配结果（真发与预览共用） */
export const AssembledSystemSchema = z.object({
  system: z.string(),
  overBudget: z.object({ used: z.number(), budget: z.number() }).nullable(),
  /** 环境级告警（如未注入 DIY_CLI）：提示词会失真，但不算用户操作错误 */
  warnings: z.array(z.string()),
  /** 结构 trace：仅预览请求时提供（真发不传，省一次分配） */
  trace: z.array(TraceNodeSchema).nullable(),
  /** 本次**实际注入**的 globals 值（「变量值」view 的数据源；随任务/草稿变化） */
  values: z.record(z.string(), z.unknown()),
  /** 变量契约：宿主注入的变量清单（模版作者可用的"输入面"） */
  // 变量契约不再随载荷下发：renderer 直接从 AssembleGlobalsSchema 派生（单一真源，零漂移）
});
export type AssembledSystem = z.infer<typeof AssembledSystemSchema>;

/** 试验场预览响应 = 装配结果 + 仿真请求体 */
export const RequestPreviewSchema = AssembledSystemSchema.extend({
  requestBody: z.record(z.string(), z.unknown()).nullable(),
  requestNote: z.string(),
});
export type RequestPreview = z.infer<typeof RequestPreviewSchema>;

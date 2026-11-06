/**
 * api-domains/agent/persona.ts —— 从 api-def.ts 的 `agent.persona` 拆出。
 */
import { z } from "zod";
import { RpcSchema } from "@diy-agent/rpc";
import { PersonaSchema } from "../../../../shared/persona";

export const personaRoutes = RpcSchema.group({desc: `agent 人物（模型 + 参数 + 行为指令）；任务持**引用（id）**，改人物对使用它的会话下一轮生效`,
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
            },});

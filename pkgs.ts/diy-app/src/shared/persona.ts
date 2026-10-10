// src/shared/persona.ts
// 🎯 agent 人物（persona）的**唯一契约源**：纯 zod，无 node 依赖（renderer 也引用）。
//
// 为什么需要「人物」这层（本设计的核心判断）：
//   model 属于"会话"时，两个需求直接互斥 —— 想统一改（所有会话跟着变）就必然串台
//   （改一个会话另一个也变），想隔离就必然无法统一改。解法是把**配置挂到可复用的具名实体**
//   上：会话只持有「用哪个人物」的引用，改人物 = 所有引用者统一变（下一轮生效），
//   换人物 = 只改本会话的引用、完全不碰别人。旧实现把 activeModel 放在 renderer 的
//   模块级全局信号里，两个病症同源（串台 + 重启回落硬编码默认模型）。
//
// **引用用 id，名字只是标签**（可改）：
//   任务的 `persona` 存 id 而不是名字。名字是给人看的（"大副"随时可改成"赫敏"），
//   一旦拿它当引用键，改名就等于把所有引用打断（引用者静默回落缺省人物 = 换模型不打招呼）。
//   标识与展示分离是这类"可改名的配置实体"的通用要求，不是洁癖。
//
// 约定：本文件只放 schema/类型/内置默认值，禁止 import node:*（renderer 会打进包）。

import { z } from "zod";

/**
 * 人物定义：agent 的**默认工作方式**。
 * 没有 desc 字段 —— 名字本身就是说明，而模型与档位在界面上始终可见（不必再抄一遍）。
 */
export const PersonaDefSchema = z.object({
  /** 显示名（可变；引用用 id，见文件头） */
  name: z.string().describe("显示名（可改，引用不受影响）"),
  model: z.string().describe("模型 id（须在模型清单内）"),
  reasoningEffort: z.string().describe("推理强度档位（须在该模型支持集内）"),
  /**
   * 行为指令：给这个人物的固定行为要求（说话方式、回答结构、专业程度、输出约束……），
   * 注入系统提示词的**身份节**；空串 = 不注入。
   *
   * 字段名用 `instructions` 而不是 `style`/`tone`/`prompt`：
   *   · `style`/`tone` 太窄（只像"措辞语气"），而这里能写"先给结论再给依据"这类**行为**要求
   *   · `prompt` 太宽（会被理解成整个系统提示词），`context` 是另一回事（任务资料/历史消息）
   *   · `instructions` 是业界对"给 agent 的固定指令"的通用叫法（OpenAI Assistants/Responses 同词）
   */
  instructions: z.string().describe("行为指令（注入身份节；空=不注入）"),
});
export type PersonaDef = z.infer<typeof PersonaDefSchema>;

/** 人物 = 稳定 id + 定义（下发形状；id 是文件里的 key，物化成字段便于界面/CLI 使用） */
export const PersonaSchema = PersonaDefSchema.extend({ id: z.string() });
export type Persona = z.infer<typeof PersonaSchema>;

/**
 * 下发用的人物视图 = 人物 + **引用面**（多少任务在用它）。
 * taskCount 不是存储的一部分，是 main 每次 list 时算的投影 —— 但界面必须有它：
 * 改人物是"统一影响所有引用者"的动作，看不见影响面就等于盲改。
 */
export type PersonaView = Persona & { taskCount: number };

/**
 * 人物清单下发形状 = 人物列表 + **跟随缺省的任务数**。
 *
 * 为什么必须单独给这个数：跟随缺省的任务**不写 persona 键**，因此不会计入任何人的 taskCount。
 * 但它恰恰是"改缺省会影响谁"的那批任务 —— 面板上写着"缺省人物：0 个任务在用"而实际有 30 个
 * 任务跟着它跑，就是**假的影响面**，比不显示更糟。
 */
export type PersonaList = { default: string; personas: PersonaView[]; followCount: number };

/**
 * personas.yaml 的结构（全局一份）。
 * key = 人物 id（稳定）；`default` 也是 id（新建任务物化它）。
 */
export const PersonasFileSchema = z.object({
  default: z.string(),
  personas: z.record(z.string(), PersonaDefSchema),
});
export type PersonasFile = z.infer<typeof PersonasFileSchema>;

/**
 * id 格式：`persona/<n>`（实体名 + 序号）。
 *
 * 为什么带 `persona/` 前缀而不是裸 `p1`：
 *   · 光看 `persona: persona/3` 就知道它是"某类实体的第 3 号"，裸 `p1` 要回去查才知道是什么实体
 *   · 将来若出现别的可引用实体（project/agent/…），引用键在同一份 frontmatter 里不会撞形
 *   · 与任务 URI `projects/4/tasks/182` 是同一种"路径式标识"读法，人一眼能对上
 * 名字仍然是**纯标签**（可改）：引用一律用 id，见文件头。
 */
export const PERSONA_ID_PREFIX = "persona/";

/** 内置缺省人物的 id 与名字（personas.yaml 不存在时系统可用的唯一人物） */
export const BUILTIN_PERSONA_ID = "persona/1";
export const BUILTIN_PERSONA_NAME = "大副";

/**
 * 内置缺省人物定义（personas.yaml 不存在时系统可用的唯一人物）。
 * **无内置缺省模型**：应用首次启动没有任何 provider（没有 key 就没有可用模型），
 * 模型必须等用户添加 provider 后自建/指定 —— 不写死一个代码内模型（那正是旧
 * 默认模型的病灶：重启回落到一个与用户配置无关的值）。
 */
export const BUILTIN_PERSONA_DEF: PersonaDef = {
  name: BUILTIN_PERSONA_NAME,
  model: "",
  reasoningEffort: "",
  instructions: "每次回答前先称一声「sir」。",
};

export const BUILTIN_PERSONAS: PersonasFile = {
  default: BUILTIN_PERSONA_ID,
  personas: { [BUILTIN_PERSONA_ID]: BUILTIN_PERSONA_DEF },
};

/** 自动生成新人物 id：`persona/<n>`，n = 现有 `persona/<数字>` id 的最大值 + 1（与任务号同思路，人可读） */
export function nextPersonaId(existing: Iterable<string>): string {
  let max = 0;
  for (const id of existing) {
    const m = /^persona\/(\d+)$/.exec(id);
    if (m) max = Math.max(max, Number(m[1]));
  }
  return `${PERSONA_ID_PREFIX}${max + 1}`;
}

/**
 * 「跟随缺省」的 CLI 关键字。
 *
 * 任务不固定人物时，frontmatter 里**不写 `persona` 键**（而不是写一个空值）——
 * 与 `priority`/`change_type` 同一套「缺省 = 不写键」的约定，文件里不堆噪音。
 * CLI 侧 `--persona default`（或空串）与 RPC 侧的空串都翻成"删键"这同一个动作。
 */
export const PERSONA_FOLLOW_KEYWORD = "default";

/** 该入参是否表示「跟随缺省」（= 删掉 persona 键）。空串与关键字等价，省得调用方记两套写法。 */
export function isPersonaFollow(v: string): boolean {
  return v.trim() === "" || v.trim() === PERSONA_FOLLOW_KEYWORD;
}

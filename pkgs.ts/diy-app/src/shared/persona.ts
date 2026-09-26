// src/shared/persona.ts
// 🎯 agent 人物（persona）的**唯一契约源**：纯 zod，无 node 依赖（renderer 也引用）。
//
// 为什么需要「人物」这层（本设计的核心判断）：
//   model 属于"会话"时，两个需求直接互斥 —— 想统一改（所有会话跟着变）就必然串台
//   （改一个会话另一个也变），想隔离就必然无法统一改。解法是把**配置挂到可复用的具名实体**
//   上：会话只持有「用哪个人物」的引用，改人物 = 所有引用者统一变（下一轮生效），
//   换人物 = 只改本会话的引用、完全不碰别人。旧实现把 activeModel 放在 renderer 的
//   模块级全局信号里，两个病症同源（串台 + 重启回落硬编码 DEFAULT_MODEL）。
//
// 约定：本文件只放 schema/类型/内置默认值，禁止 import node:*（renderer 会打进包）。

import { z } from "zod";
import { DEFAULT_MODEL } from "./models";

/** 人物定义：agent 的**默认工作方式**（身份、模型、模型参数） */
export const PersonaDefSchema = z.object({
  model: z.string().describe("模型 id（须在模型清单内）"),
  reasoningEffort: z.string().describe("推理强度档位"),
  /** 口气/说话方式：注入系统提示词的身份节；空串 = 不注入 */
  style: z.string().describe("口气（注入身份节；空=不注入）"),
  desc: z.string().describe("一句话说明（选择器展示用）"),
});
export type PersonaDef = z.infer<typeof PersonaDefSchema>;

/** 人物 = 定义 + 名字（名字在文件里是 map 的 key，下发时物化成字段） */
export const PersonaSchema = PersonaDefSchema.extend({ name: z.string() });
export type Persona = z.infer<typeof PersonaSchema>;

/** personas.yaml 的结构（全局一份；default = 新建任务的缺省人物名） */
export const PersonasFileSchema = z.object({
  default: z.string(),
  personas: z.record(z.string(), PersonaDefSchema),
});
export type PersonasFile = z.infer<typeof PersonasFileSchema>;

/** 内置缺省人物名（personas.yaml 不存在时的唯一人物） */
export const BUILTIN_PERSONA_NAME = "大副";

/**
 * 内置缺省人物：人格化 + 默认模型。
 * 用户要的"缺省口气"就落在这里 —— 想改直接改 personas.yaml（或 CLI），不必改代码。
 */
export const BUILTIN_PERSONAS: Record<string, PersonaDef> = {
  [BUILTIN_PERSONA_NAME]: {
    model: DEFAULT_MODEL,
    reasoningEffort: "medium",
    style: "每次回答前先称一声「sir」。",
    desc: "内置缺省人物：默认模型 + 称 sir 的口气",
  },
};

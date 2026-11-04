// fixtures/llm/index.ts — 场景清单
//
// 目录约定（2026-11-04 用户定）：
//   gen/         **自动生成**，文件名一律 *.gen.ts —— 这个组合就是「别手改」的唯一标记
//   本文件       手写，只负责汇总导出（gen/ 里增减场景时改这里）
//
// 为什么 gen/ 也进版本库：fixture 是测试资产，要保证任何机器上回放结果一致。
// 但它与手写代码分开住 —— review 时看 gen/ 的 diff 就知道「模型行为变了」，
// 不会和业务改动混在一起。

export { textOnly } from "./gen/text-only.gen.js";
export { think } from "./gen/think.gen.js";
export { toolOk } from "./gen/tool-ok.gen.js";
export { toolError } from "./gen/tool-error.gen.js";
export { toolMultiStep } from "./gen/tool-multi-step.gen.js";
export { abort } from "./gen/abort.gen.js";
export { modelUnavailable } from "./gen/model-unavailable.gen.js";
export { rateLimit } from "./gen/rate-limit.gen.js";
export { contextOverflow } from "./gen/context-overflow.gen.js";
export { empty } from "./gen/empty.gen.js";

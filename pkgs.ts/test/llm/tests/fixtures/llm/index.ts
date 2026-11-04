// fixtures/llm/index.ts — 场景清单
//
// 目录约定：gen/ 里全是自动生成（*.gen.ts），本文件手写、只汇总导出。
//
// 错误场景的来源是**真实历史**（~/.diy/log/network/ 全量 32478 条 LLM 请求）：
// 只有 200 / 400 / 429 三种状态码，真实错误就三类，见下方分组注释。
// 没有凭空合成了 —— 编造的 context_length_exceeded / model_coming_soon 在真实数据里
// 一次都没发生过，已删除（编造场景比没有场景更坏：会让下游为不存在的情况写防御代码）。

// ── 正常路径（真模型录制）──
export { textOnly } from "./gen/text-only.gen.js";
export { think } from "./gen/think.gen.js";
export { toolOk } from "./gen/tool-ok.gen.js";
export { toolError } from "./gen/tool-error.gen.js";
export { toolMultiStep } from "./gen/tool-multi-step.gen.js";
export { abort } from "./gen/abort.gen.js";

// ── 错误路径（真实样本，按出现次数排序）──
export { endpointUnavailable } from "./gen/endpoint-unavailable.gen.js"; // 429 server_error × 21
export { reasoningNotPassed } from "./gen/reasoning-not-passed.gen.js";   // 400 invalid_request_error × 15（真 bug）
export { rateLimit } from "./gen/rate-limit.gen.js";                      // 429 rate_limit_error × 3

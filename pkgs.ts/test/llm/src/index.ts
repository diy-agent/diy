// index.ts — 测试用 LLM 的全部出口
//
// 两个方向：
//   装配真模型  →  testLlm() / testLlmConfig()（只认 DIY_TEST_LLM_*，不读数据根）
//   回放录制流  →  replay(parts)（fixture 是源码常量，见 tests/fixtures/llm/*.ts）

export { testLlm, testLlmConfig, missingEnvText, type TestLlmConfig } from "./env.js";
export { replay, type Replay } from "./replay.js";

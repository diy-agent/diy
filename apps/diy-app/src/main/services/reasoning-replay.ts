// src/main/services/reasoning-replay.ts
// ⚠️ 实现已迁到 `@diy-agent/llm-provider`（pkgs.ts/model/provider/src/reasoning-replay.ts）。
// 这里只做转发，保住 diy-app 里 4 处调用点（local-agent.ts）不改。
//
// 为什么迁：这份逻辑是**协议约束**（上游逐条校验 reasoning_content），不是 diy-app 的业务；
// 留在要废弃的 app 里 ⇒ 新架构（apps/chat）接真模型时会踩同一个坑，而那里没有这层兜底。
// 详见 docs/testing.md 与 fixture `reasoning-not-passed.gen.ts`（真实 15 次 400）。
export { ensureReasoningReplay, isDeepSeekWire, type ReasoningReplayOpts, type WireIdentity } from "@diy-agent/llm-provider";

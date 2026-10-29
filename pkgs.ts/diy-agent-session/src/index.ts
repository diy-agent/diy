// @diy/agent-session — diy 单会话内核：消息列表 + 一次 LLM 调用 + 流式增量
//
// 边界一句话：**一个会话 = 一条消息线 + 一次 LLM 调用**。多成员投递归 @diy/room，
// 任务状态 / 文件系统归宿主适配器 —— 所以本包 import 清单里绝不允许出现
// 文件系统模块 / electron / 应用数据根 / 任务标识（##456 硬判据，意图测试 S7 静态扫）。
//
//   import { createSession, systemClock, type LlmPort } from '@diy/agent-session';
//
//   const llm: LlmPort = {
//       async *chat(messages, { signal } = {}) {     // 适配器负责翻译自家 SDK 的流
//           yield { type: 'text', text: '你好' };
//           yield { type: 'usage', inputTokens: 12, outputTokens: 3 };
//           yield { type: 'done', stopReason: 'stop' };
//       },
//   };
//   const session = createSession({ id: 's1', llm });
//   for await (const delta of session.send('在吗')) { /* text 增量 */ }
//   session.messages; // [user, assistant]
//
// 可选注入（都不传 = 纯内存、真时间、不压缩）：
//   clock   —— 假 Clock 让 `at` 确定
//   compact —— 每轮调用前的压缩策略（保留边界 / 摘要归 @diy/compact）
//   store   —— 快照落盘（jsonl / sqlite 由独立适配器包实现）
//
// LLM 形状 / 流式增量 / 边界的细节见 ./types.ts 与 ./session.ts 头注。

export { SessionError } from './errors.js';
export type { SessionErrorCode } from './errors.js';

export {
    MESSAGE_ROLES,
    MESSAGE_TYPES,
    assertDelta,
    parseMessage,
    parseMessages,
    toolArgsFromInput,
} from './message.js';

export { systemClock } from './types.js';
export type {
    AgentSession,
    ChatMessage,
    ChatMessageInit,
    ChatToolCall,
    ChatOptions,
    Clock,
    Compactor,
    LlmPort,
    MessageType,
    MessageRole,
    SessionDelta,
    SessionPeer,
    SessionSnapshot,
    SessionStore,
    TokenUsage,
} from './types.js';

export { createSession } from './session.js';
export type { CreateSessionOptions } from './session.js';

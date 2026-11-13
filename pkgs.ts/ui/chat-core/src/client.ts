// client.ts —— ChatClient 契约（纯接口）。
//
// 这一层不认识 HTTP / SSE / WebSocket / ipc：传输实现放在独立的 transport 包里。
//   现在：@diy-agent/chat-transport-http
//   将来：@diy-agent/chat-transport-rpc（diy-rpc 落地后直接换实现，core 不动）

import type { Command, Snapshot, StreamEvent } from './types';

export interface ChatClient {
    /** 拉历史快照（首屏 / 重载 / 重放） */
    load(entityId: string): Promise<Snapshot>;

    /** 提交命令；事件通过 onEvent 回推。signal 取消只影响本地订阅。 */
    post(entityId: string, command: Command, onEvent: (event: StreamEvent) => void, signal?: AbortSignal): Promise<void>;
}

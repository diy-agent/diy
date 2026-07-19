// src/main/services/acp-agent.ts
// 🎯 ACP (Agent Communication Protocol) 客户端
//    Hermes agent 通过 HTTP API 通信

export interface AcpMessage {
  role: "user" | "assistant" | "tool";
  content: string;
  tool_calls?: Array<{ name: string; arguments: string }>;
  tool_call_id?: string;
}

export interface AgentStatus {
  agentId: string;
  state: string;
  taskUri: string;
  model?: string;
  error?: string;
}

/** ACP Agent 客户端 */
export class AcpAgentClient {
  private baseUrl: string;

  constructor(baseUrl = "http://localhost:11434") {
    this.baseUrl = baseUrl;
  }

  /** 发送聊天消息（非流式） */
  async chat(model: string, messages: AcpMessage[]): Promise<AcpMessage> {
    const resp = await fetch(`${this.baseUrl}/v1/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model,
        messages: messages.map((m) => ({
          role: m.role,
          content: m.content,
          tool_calls: m.tool_calls,
          tool_call_id: m.tool_call_id,
        })),
      }),
    });
    const data = (await resp.json()) as { choices: Array<{ message: AcpMessage }> };
    return data.choices[0]!.message;
  }

  /** 流式聊天 */
  async *streamChat(model: string, messages: AcpMessage[]): AsyncGenerator<string> {
    const resp = await fetch(`${this.baseUrl}/v1/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model, messages, stream: true }),
    });
    const reader = resp.body!.getReader();
    const decoder = new TextDecoder();
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      const lines = decoder.decode(value).split("\n");
      for (const line of lines) {
        if (line.startsWith("data: ")) {
          const data = JSON.parse(line.slice(6)) as {
            choices: Array<{ delta: { content?: string } }>;
          };
          const content = data.choices[0]?.delta.content;
          if (content) yield content;
        }
      }
    }
  }

  /** 获取 agent 状态 */
  async getAgentStatus(agentId: string): Promise<AgentStatus> {
    try {
      const resp = await fetch(`${this.baseUrl}/v1/agents/${agentId}`);
      return (await resp.json()) as AgentStatus;
    } catch {
      return { agentId, state: "unknown", taskUri: "" };
    }
  }
}

/**
 * Common interface for all AI coding agents.
 * Provides a unified abstraction over different agent implementations.
 */
export interface CodingAgent {
  /**
   * Initialize the agent and its underlying resources.
   * Must be called before using ask/send methods.
   */
  initialize(): Promise<void>;

  /**
   * Send a prompt to the agent and receive events.
   * Note: Different agents may return streaming or batch results.
   * @param prompt - The user prompt or instruction
   * @param signal - Optional abort signal for cancellation
   * @returns Promise resolving to agent events
   */
  ask(
    prompt: string,
    signal?: AbortSignal,
  ): Promise<AgentStreamEvent[]>;

  /**
   * Clean up resources and dispose the agent.
   */
  dispose(): Promise<void>;

  /**
   * Get the session ID for this agent instance.
   */
  getSessionId(): string;
}

/**
 * Configuration options common to all coding agents.
 */
export interface AgentOptions {
  /** System instructions or user memory for the agent */
  instructions: string;
  /** Model identifier (optional, agent-specific) */
  model?: string;
  /** Working directory (defaults to process.cwd()) */
  cwd?: string;
  /** Enable debug mode (optional) */
  debug?: boolean;
}

/**
 * Base event type for agent streaming responses.
 * Different agents may have additional event types.
 */
export type AgentStreamEvent = ContentEvent | ToolCallRequestEvent | ToolCallResponseEvent | ErrorEvent;

/** Event containing text content from the agent */
export interface ContentEvent {
  type: 'content';
  value: string;
}

/** Event requesting tool execution */
export interface ToolCallRequestEvent {
  type: 'tool_call_request';
  value: ToolCallInfo;
}

/** Event with tool execution result */
export interface ToolCallResponseEvent {
  type: 'tool_call_response';
  value: ToolCallResult;
}

/** Event indicating an error occurred */
export interface ErrorEvent {
  type: 'error';
  value: string | Error;
}

/**
 * Information about a tool call request.
 */
export interface ToolCallInfo {
  /** Tool name */
  name: string;
  /** Tool input arguments */
  args?: Record<string, unknown>;
}

/**
 * Result from a tool execution.
 */
export interface ToolCallResult {
  /** Tool name that was called */
  name: string;
  /** Tool execution result (format varies by tool) */
  result: unknown;
  /** Whether the tool call succeeded */
  success: boolean;
}

/**
 * Utility type for agent disposal via using declaration.
 */
export interface AsyncDisposable {
  [Symbol.asyncDispose](): Promise<void>;
}

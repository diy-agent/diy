/**
 * PI Coding Agent implementation wrapping @mariozechner/pi-coding-agent.
 */
import {
  createAgentSession,
  AuthStorage,
  ModelRegistry,
  SessionManager,
  SettingsManager,
  DefaultResourceLoader,
  codingTools,
  type AgentSession,
} from '@mariozechner/pi-coding-agent';
import type { CodingAgent, AgentStreamEvent, AgentOptions } from './agent.js';

/**
 * Options specific to PI Coding Agent
 */
export interface PiAgentOptions extends AgentOptions {
  /** Thinking level: "off", "low", "medium", "high" */
  thinkingLevel?: 'off' | 'low' | 'medium' | 'high';
  /** Agent config directory (default: ~/.pi/agent) */
  agentDir?: string;
}

/**
 * PI Coding Agent implementation wrapping @mariozechner/pi-coding-agent.
 */
export class PiCodingAgent implements CodingAgent {
  private session: AgentSession | null = null;
  private sessionId: string = '';
  private initialized = false;
  private readonly options: PiAgentOptions;

  constructor(options: PiAgentOptions) {
    this.options = options;
  }

  async initialize(): Promise<void> {
    if (this.initialized) return;

    const cwd = this.options.cwd || process.cwd();
    const agentDir = this.options.agentDir || '~/.pi/agent';

    // Setup auth and model registry
    const authStorage = AuthStorage.create();
    const modelRegistry = new ModelRegistry(authStorage);

    // Setup resource loader with custom system prompt
    const resourceLoader = new DefaultResourceLoader({
      systemPromptOverride: (base) => {
        // Prepend custom instructions to base prompt
        return `${this.options.instructions}\n\n${base}`;
      },
    });
    await resourceLoader.reload();

    // Create session with coding tools
    const { session } = await createAgentSession({
      cwd,
      agentDir,
      authStorage,
      modelRegistry,
      resourceLoader,
      tools: codingTools,
      sessionManager: SessionManager.inMemory(),
      settingsManager: SettingsManager.inMemory(),
      thinkingLevel: this.options.thinkingLevel || 'off',
    });

    this.session = session;
    this.sessionId = session.sessionId;
    this.initialized = true;
  }

  /**
   * Send a prompt and get all events (PI agent uses event subscription, not streaming).
   * Returns array of events after completion.
   */
  async ask(
    prompt: string,
    _signal?: AbortSignal,
  ): Promise<AgentStreamEvent[]> {
    if (!this.session) {
      throw new Error('Agent not initialized. Call initialize() first.');
    }

    // Subscribe to events
    const events: AgentStreamEvent[] = [];
    const unsubscribe = this.session.subscribe((event) => {
      const mapped = this.mapEvent(event);
      if (mapped) {
        events.push(mapped);
      }
    });

    try {
      // Send prompt and wait for completion
      await this.session.prompt(prompt);
    } finally {
      unsubscribe();
    }

    return events;
  }

  /**
   * Map PI events to common agent events
   */
  private mapEvent(event: any): AgentStreamEvent | null {
    // Text content
    if (event.type === 'message_update') {
      if (event.assistantMessageEvent?.type === 'text_delta') {
        return {
          type: 'content',
          value: event.assistantMessageEvent.delta,
        };
      }
      if (event.assistantMessageEvent?.type === 'tool_call_delta') {
        return {
          type: 'tool_call_request',
          value: {
            name: event.assistantMessageEvent.name,
            args: event.assistantMessageEvent.input,
          },
        };
      }
    }

    // Tool execution
    if (event.type === 'tool_execution_start') {
      return {
        type: 'tool_call_request',
        value: {
          name: event.toolName,
        },
      };
    }

    if (event.type === 'tool_execution_end') {
      return {
        type: 'tool_call_response',
        value: {
          name: event.toolName,
          result: event.result,
          success: !event.error,
        },
      };
    }

    // Agent end
    if (event.type === 'agent_end') {
      return {
        type: 'content',
        value: '\n[Agent finished]',
      };
    }

    // Error
    if (event.type === 'error' || event.error) {
      return {
        type: 'error',
        value: event.error?.message || event.message || 'Unknown error',
      };
    }

    return null;
  }

  async dispose(): Promise<void> {
    if (this.session) {
      // PI agent session doesn't have explicit dispose
      this.session = null;
    }
    this.initialized = false;
  }

  async [Symbol.asyncDispose](): Promise<void> {
    await this.dispose();
  }

  getSessionId(): string {
    return this.sessionId;
  }

  /**
   * Get the underlying PI session for advanced usage.
   */
  get session_(): AgentSession | null {
    return this.session;
  }
}

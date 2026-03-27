/**
 * ACP (Agent Client Protocol) Client Adapter
 *
 * Provides a generic adapter for connecting to any ACP-compliant agent
 * via stdin/stdout subprocess communication.
 */

import { spawn, type ChildProcess } from 'node:child_process';
import { Writable, Readable } from 'node:stream';
import {
  WritableStream,
  ReadableStream,
} from 'node:stream/web';
import * as acp from '@agentclientprotocol/sdk';
import type { Client } from '@agentclientprotocol/sdk';
import type {
  CodingAgent,
  AgentStreamEvent,
  ContentEvent,
  ToolCallRequestEvent,
  ToolCallResponseEvent,
  ErrorEvent,
} from './agent.js';

export interface AcpAdapterOptions {
  command: string;
  args?: string[];
  authMethod?: string;
  apiKey?: string;
  cwd?: string;
  mcpServers?: acp.McpServer[];
  fsRead?: (path: string) => Promise<string>;
  fsWrite?: (path: string, content: string) => Promise<void>;
  requestPermission?: (
    title: string,
    options: acp.RequestPermissionRequest,
  ) => Promise<acp.RequestPermissionOutcome>;
  onContent?: (text: string) => void;
  onToolCall?: (toolCallId: string, title: string, rawInput: unknown) => void;
}

export class AcpClientAdapter implements CodingAgent {
  private connection: acp.ClientSideConnection | null = null;
  private sessionId: string | null = null;
  private process: ChildProcess | null = null;
  private initialized = false;
  private eventBuffer: AgentStreamEvent[] = [];
  private opts: {
    command: string;
    args: string[];
    authMethod: string;
    apiKey?: string;
    cwd: string;
    mcpServers: acp.McpServer[];
    fsRead?: (path: string) => Promise<string>;
    fsWrite?: (path: string, content: string) => Promise<void>;
    requestPermission?: (
      title: string,
      options: acp.RequestPermissionRequest,
    ) => Promise<acp.RequestPermissionOutcome>;
    onContent?: (text: string) => void;
    onToolCall?: (toolCallId: string, title: string, rawInput: unknown) => void;
  };

  constructor(options: AcpAdapterOptions) {
    this.opts = {
      command: options.command,
      args: options.args ?? ['--acp'],
      authMethod: options.authMethod ?? 'use-gemini',
      apiKey: options.apiKey,
      cwd: options.cwd ?? process.cwd(),
      mcpServers: options.mcpServers ?? [],
      fsRead: options.fsRead,
      fsWrite: options.fsWrite,
      requestPermission: options.requestPermission,
      onContent: options.onContent,
      onToolCall: options.onToolCall,
    };
  }

  async initialize(): Promise<void> {
    if (this.initialized) return;

    this.process = spawn(this.opts.command, this.opts.args, {
      stdio: ['pipe', 'pipe', 'inherit'],
      cwd: this.opts.cwd,
    });

    const input = Writable.toWeb(this.process.stdin!) as WritableStream<Uint8Array>;
    const output = Readable.toWeb(this.process.stdout!) as ReadableStream<Uint8Array>;

    const client: Client = {
      requestPermission: async (params) => {
        const title = params.toolCall.title ?? 'Tool Call';
        const outcome = await this.opts.requestPermission?.(title, params);
        if (outcome) {
          return outcome;
        }
        return { outcome: 'cancelled' };
      },

      sessionUpdate: async (params) => {
        this.bufferSessionUpdate(params);
      },

      readTextFile: async (params) => {
        if (this.opts.fsRead) {
          const content = await this.opts.fsRead(params.path);
          return { content };
        }
        throw new Error('fsRead not implemented');
      },

      writeTextFile: async (params) => {
        if (this.opts.fsWrite) {
          await this.opts.fsWrite(params.path, params.content);
          return {};
        }
        throw new Error('fsWrite not implemented');
      },
    };

    const stream = acp.ndJsonStream(input, output);
    this.connection = new acp.ClientSideConnection(() => client, stream);

    await this.connection.initialize({
      clientInfo: { name: 'dao', version: '1.0.0' },
      protocolVersion: acp.PROTOCOL_VERSION,
    });

    if (this.opts.apiKey) {
      await this.connection.authenticate({
        methodId: this.opts.authMethod,
        _meta: { 'api-key': this.opts.apiKey },
      });
    }

    const result = await this.connection.newSession({
      cwd: this.opts.cwd,
      mcpServers: this.opts.mcpServers,
    });
    this.sessionId = result.sessionId;

    this.initialized = true;
  }

  private bufferSessionUpdate(params: acp.SessionNotification): void {
    const update = params.update;
    switch (update.sessionUpdate) {
      case 'agent_message_chunk':
      case 'user_message_chunk':
      case 'agent_thought_chunk': {
        const chunk = update as acp.ContentChunk & { sessionUpdate: string };
        if (chunk.content.type === 'text') {
          const event: ContentEvent = { type: 'content', value: chunk.content.text };
          this.eventBuffer.push(event);
          this.opts.onContent?.(chunk.content.text);
        }
        break;
      }
      case 'tool_call': {
        const tool = update as acp.ToolCall;
        const event: ToolCallRequestEvent = {
          type: 'tool_call_request',
          value: {
            name: tool.title,
            args: tool.rawInput as Record<string, unknown>,
          },
        };
        this.eventBuffer.push(event);
        this.opts.onToolCall?.(tool.toolCallId, tool.title, tool.rawInput);
        break;
      }
      case 'tool_call_update': {
        const toolUpdate = update as acp.ToolCallUpdate;
        const event: ToolCallResponseEvent = {
          type: 'tool_call_response',
          value: {
            name: toolUpdate.toolCallId,
            result: toolUpdate.rawOutput ?? null,
            success: toolUpdate.status === 'completed' && !toolUpdate.rawOutput,
          },
        };
        this.eventBuffer.push(event);
        break;
      }
    }
  }

  async ask(
    prompt: string,
    _signal?: AbortSignal,
  ): Promise<AgentStreamEvent[]> {
    if (!this.connection || !this.sessionId) {
      throw new Error('Adapter not initialized');
    }

    this.eventBuffer = [];

    try {
      await this.connection.prompt({
        sessionId: this.sessionId,
        prompt: [{ type: 'text', text: prompt }],
      });

      const events = [...this.eventBuffer];
      this.eventBuffer = [];
      return events;
    } catch (error) {
      const errorEvent: ErrorEvent = { type: 'error', value: String(error) };
      return [errorEvent];
    }
  }

  getSessionId(): string {
    if (!this.sessionId) throw new Error('Not initialized');
    return this.sessionId;
  }

  async dispose(): Promise<void> {
    if (this.process) {
      this.process.kill();
      this.process = null;
    }
    this.connection = null;
    this.sessionId = null;
    this.initialized = false;
    this.eventBuffer = [];
  }

  async [Symbol.asyncDispose](): Promise<void> {
    await this.dispose();
  }
}

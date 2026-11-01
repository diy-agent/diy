// helpers.ts — 测试共用：临时数据根 / 假 LLM / 假静态目录 / ws 客户端（= 浏览器那套，去掉浏览器壳）。

import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ChannelClientBinding, createTypedClient, type TypedClient } from '@diy-agent/rpc';
import { WsTransport } from '@diy-agent/rpc/ws';
import type { LlmPort } from '@diy-agent/session';
import WebSocket from 'ws';
import { webApi } from '../api.js';

/** 临时数据根：一个 custom provider（test/echo-1），key 是假值（llmFor 注入假模型，不会真发请求） */
export function makeHome(): string {
    const home = mkdtempSync(join(tmpdir(), 'app-web-'));
    writeFileSync(
        join(home, 'model.yaml'),
        `customProviders:
  test:
    accounts:
      - type: apiKey
        name: main
        data:
          value: fake-key
`,
        'utf-8',
    );
    writeFileSync(
        join(home, 'providers.custom.yaml'),
        `test:
  id: test
  npm: "@ai-sdk/openai-compatible"
  api: http://127.0.0.1:1/v1
  models:
    echo-1:
      name: Echo 1
`,
        'utf-8',
    );
    return home;
}

/** 假 LLM：回显最后一条 user 消息（判据 5 的链路证据；真模型由 --home 里的 model.yaml 决定） */
export function makeFakeLlm(): { llm: LlmPort; calls: () => number } {
    let count = 0;
    return {
        calls: () => count,
        llm: {
            async *chat(messages) {
                count += 1;
                const last = [...messages].reverse().find((message) => message.role === 'user');
                yield { type: 'text', text: `收到：${last?.text ?? ''}` };
                yield { type: 'usage', inputTokens: 1, outputTokens: 1 };
                yield { type: 'done', stopReason: 'stop' };
            },
        },
    };
}

/** 假静态目录（server.ts 只管托管，页面内容由 esbuild 产物决定，测试只需一个可读文件） */
export function makeStaticDir(): string {
    const dir = mkdtempSync(join(tmpdir(), 'app-web-static-'));
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'index.html'), '<!doctype html><title>diy web</title>\n', 'utf-8');
    writeFileSync(join(dir, 'index.js'), '// renderer bundle\n', 'utf-8');
    return dir;
}

export interface WsClient {
    readonly client: TypedClient<typeof webApi>;
    close(): void;
}

/** 连上去（浏览器侧的等价物：WsTransport + ChannelClientBinding + createTypedClient） */
export async function connectWs(url: string): Promise<WsClient> {
    const socket = new WebSocket(url);
    await new Promise<void>((done, fail) => {
        socket.once('open', () => done());
        socket.once('error', fail);
    });
    const binding = new ChannelClientBinding(new WsTransport(socket));
    return {
        client: createTypedClient(binding, webApi),
        close: () => {
            binding.dispose();
            socket.close();
        },
    };
}

/** 从 RpcError 里取 code（错误可能被包装成普通对象） */
export function codeOf(error: unknown): string {
    const code = (error as { code?: unknown }).code;
    return typeof code === 'string' ? code : `?${String(error)}`;
}

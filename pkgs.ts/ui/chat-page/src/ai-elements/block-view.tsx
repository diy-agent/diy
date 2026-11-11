// block-view.tsx —— 把 diy 的 Block（text / think / tool）映射到 AI Elements 组件。
//
// 这一层是**唯一的适配点**：数据形状（WireMessage.blocks）不变，只是换渲染器。
// text  → MessageResponse（Streamdown：Markdown / 代码块 / 表格 / 公式）
// think → Reasoning（折叠面板，跑动时 shimmer，跑完自动收起）
// tool  → Tool（状态徽章 + 参数/结果两段折叠，参数走 CodeBlock 的 JSON 高亮）
//
// 未知 kind 走最后一段（JSON 原文），与 block-renderers.ts 的 fallback 同一判据：
// 不崩、不白屏，看得见原始数据。

import * as React from 'react';
import type { Block, TextBlockData, ThinkBlockData, ToolBlockData } from '../shared.js';
import { MessageResponse } from './message.js';
import { Reasoning, ReasoningTrigger, ReasoningContent } from './reasoning.js';
import { Tool, ToolHeader, ToolContent, ToolInput, ToolOutput } from './tool.js';

/** diy 的三态 → AI Elements 工具状态 */
const TOOL_STATE: Record<ToolBlockData['state'], 'input-available' | 'output-available' | 'output-error'> = {
    running: 'input-available',
    ok: 'output-available',
    error: 'output-error',
};

/** 参数：能解析成 JSON 就给对象（CodeBlock 排版好看），否则原样字符串 */
function parseArgs(args: string): unknown {
    try {
        return JSON.parse(args) as unknown;
    } catch {
        return args;
    }
}

export function BlockView({ block }: { block: Block }): React.ReactElement {
    if (block.kind === 'text') {
        const data = block.data as Partial<TextBlockData>;
        return <MessageResponse>{data.text ?? ''}</MessageResponse>;
    }
    if (block.kind === 'think') {
        const data = block.data as Partial<ThinkBlockData>;
        return (
            <Reasoning isStreaming={data.done !== true}>
                <ReasoningTrigger />
                <ReasoningContent>{data.text ?? ''}</ReasoningContent>
            </Reasoning>
        );
    }
    if (block.kind === 'tool') {
        const data = block.data as Partial<ToolBlockData>;
        const state = TOOL_STATE[data.state ?? 'running'];
        const input = parseArgs(data.args ?? '');
        const output = data.output ?? data.summary ?? '';
        return (
            <Tool defaultOpen={(data.state ?? 'running') === 'running'}>
                <ToolHeader type={`tool-${data.name ?? 'unknown'}`} state={state} />
                <ToolContent>
                    <ToolInput input={input} />
                    <ToolOutput
                        output={output === '' ? undefined : output}
                        errorText={state === 'output-error' ? (output === '' ? '工具执行失败' : output) : undefined}
                    />
                </ToolContent>
            </Tool>
        );
    }
    return (
        <pre className="overflow-x-auto rounded-md bg-muted p-2 text-xs">{JSON.stringify(block, null, 2)}</pre>
    );
}

/** 一条消息的全部块 */
export function BlocksView({ blocks }: { blocks: readonly Block[] }): React.ReactElement {
    return (
        <>
            {blocks.map((block) => (
                <BlockView key={block.id} block={block} />
            ))}
        </>
    );
}

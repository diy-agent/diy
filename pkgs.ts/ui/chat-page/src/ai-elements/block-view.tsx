// block-view.tsx —— 把 diy 的 Block（text / think / tool）映射到 shadcn 的 AI Elements 组件。
//
// 2026-11-11 第二版（用户指出「和 ui.shadcn.com/docs/ai-elements/base 的范例完全不一样」）：
// 上一版拉的是 elements.ai-sdk.dev 的旧包（conversation/message/reasoning/tool），
// 而 shadcn 官方已把这套迁移成 **base-nova 变体**的原语：Message / Bubble / Trace / CodeBlock。
// 现在照文档（`/docs/ai-elements/base/{message,chain-of-thought,tool,reasoning}.md`）的写法：
//
//   text  → Streamdown（Markdown）
//   think → Trace + TraceCollapsible（一行 "Thinking"/"Thought for …"，点开看全文；running 时 shimmer）
//   tool  → Trace + TraceCollapsible（标题 = 工具名 + 参数摘要；点开是 CodeBlock 里的输出）
//
// 三个都共用一个 Trace 容器时就是 Chain of Thought 的样子（多步串成一条线）。

import * as React from 'react';
import { BrainIcon, TerminalIcon } from 'lucide-react';
import { Streamdown } from 'streamdown';
import { cjk } from '@streamdown/cjk';
import { code } from '@streamdown/code';
import { math } from '@streamdown/math';
import type { Block, TextBlockData, ThinkBlockData, ToolBlockData } from '../shared.js';
import { CodeBlock, CodeBlockContent } from '../ui/code-block.js';
import {
    Trace,
    TraceCollapsible,
    TraceCollapsibleContent,
    TraceCollapsibleTrigger,
    TraceIcon,
    TraceLine,
    TraceTitle,
} from '../ui/trace.js';

const streamdownPlugins = { cjk, code, math };

/** Markdown 正文（表格 / 代码块 / CJK / 公式） */
export function Markdown({ text }: { text: string }): React.ReactElement {
    return (
        <Streamdown className="space-y-3 whitespace-normal text-sm" plugins={streamdownPlugins}>
            {text}
        </Streamdown>
    );
}

/** think 块：一行摘要 + 可展开全文（TraceLine 的 running 态自带 shimmer） */
function ThinkBlock({ data }: { data: Partial<ThinkBlockData> }): React.ReactElement {
    const running = data.done !== true;
    const line = (
        <TraceLine status={running ? 'running' : undefined}>
            <TraceIcon>
                <BrainIcon />
            </TraceIcon>
            <TraceTitle>{running ? 'Thinking…' : 'Thought'}</TraceTitle>
        </TraceLine>
    );
    const text = data.text ?? '';
    if (text === '') return line;
    return (
        <Trace>
            <TraceCollapsible defaultOpen={running}>
                <TraceCollapsibleTrigger>{line}</TraceCollapsibleTrigger>
                <TraceCollapsibleContent className="whitespace-pre-wrap">{text}</TraceCollapsibleContent>
            </TraceCollapsible>
        </Trace>
    );
}

/** tool 块：标题 = 工具名 + 参数摘要，展开是输出（CodeBlock 排版） */
function ToolBlock({ data }: { data: Partial<ToolBlockData> }): React.ReactElement {
    const state = data.state ?? 'running';
    const status = state === 'error' ? 'error' : state === 'running' ? 'running' : undefined;
    const line = (
        <TraceLine status={status}>
            <TraceIcon>
                <TerminalIcon />
            </TraceIcon>
            <TraceTitle>{data.name ?? 'tool'}</TraceTitle>
            {data.args === undefined || data.args === '' ? null : (
                <span className="truncate font-mono text-xs opacity-70">{data.args}</span>
            )}
        </TraceLine>
    );
    const output = data.output ?? data.summary ?? '';
    if (output === '') return line;
    return (
        <Trace>
            <TraceCollapsible defaultOpen={state === 'running'}>
                <TraceCollapsibleTrigger>{line}</TraceCollapsibleTrigger>
                <TraceCollapsibleContent>
                    <CodeBlock size="sm">
                        <CodeBlockContent wrap className="max-h-64">
                            {output}
                        </CodeBlockContent>
                    </CodeBlock>
                </TraceCollapsibleContent>
            </TraceCollapsible>
        </Trace>
    );
}

export function BlockView({ block }: { block: Block }): React.ReactElement {
    if (block.kind === 'text') return <Markdown text={(block.data as Partial<TextBlockData>).text ?? ''} />;
    if (block.kind === 'think') return <ThinkBlock data={block.data as Partial<ThinkBlockData>} />;
    if (block.kind === 'tool') return <ToolBlock data={block.data as Partial<ToolBlockData>} />;
    // 未知 kind：原文可见、不崩（与 block-renderers.ts 的 fallback 同一判据）
    return (
        <CodeBlock size="sm">
            <CodeBlockContent wrap className="max-h-64">
                {JSON.stringify(block, null, 2)}
            </CodeBlockContent>
        </CodeBlock>
    );
}

/** 一条消息的全部块（顺序即渲染顺序） */
export function BlocksView({ blocks }: { blocks: readonly Block[] }): React.ReactElement {
    return (
        <>
            {blocks.map((block) => (
                <BlockView key={block.id} block={block} />
            ))}
        </>
    );
}

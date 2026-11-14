// ToolGroup —— assistant-ui 侧的「工具调用组」。
//
// 官方模板给的是「一次调用一个 ToolFallback」，多轮工具就会变成一长串
// "Used tool: bash"。Astryx 那边（ChatToolCalls）的约定是：单次内联、多次折叠成一个摘要。
// 这里对齐它 —— 组本身可折叠，展开后仍是每个 ToolFallback（各自的参数/结果可再展开）。

import { ChevronDownIcon, WrenchIcon } from 'lucide-react';
import type { FC, ReactNode } from 'react';

import { cn } from '../../../lib/utils';
import { CollapsibleRoot as Collapsible, CollapsibleContent, CollapsibleTrigger } from './collapsible-root';

export const ToolGroup: FC<{ count: number; children: ReactNode }> = ({ count, children }) => (
    <Collapsible data-slot="tool-group" className="group/tool-group my-1">
        <CollapsibleTrigger
            data-slot="tool-group-trigger"
            className={cn(
                'group/trigger text-muted-foreground hover:text-foreground flex w-fit items-center gap-2 py-1.5 text-sm transition-colors',
            )}
        >
            <WrenchIcon className="size-4 shrink-0" />
            <span>
                工具调用 <span className="text-xs tabular-nums">({count})</span>
            </span>
            <ChevronDownIcon className="size-4 shrink-0 -rotate-90 transition-transform group-data-open/trigger:rotate-0 group-data-panel-open/trigger:rotate-0" />
        </CollapsibleTrigger>
        <CollapsibleContent
            data-slot="tool-group-content"
            className="border-muted-foreground/20 ml-2 border-l pl-3"
        >
            {children}
        </CollapsibleContent>
    </Collapsible>
);

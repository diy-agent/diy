// scroll-area.tsx —— shadcn ScrollArea（base-nova 风格 = Base UI 原语，源码引入）。
//
// 用途：长内容滚动区（工具输出、日志、消息流）。视口自带 `overflow` 与滚动条样式，
// 视觉仍由 react.css 的令牌桥决定（bg-border → --md-sys-color-outline-variant）。
//
// 生成方式：`npx shadcn add scroll-area`（CLI 见 components.json）；本机 npm 12 会拦
// CLI 的自动 install 步骤，所以这里是 `--view` 取源码后手工落盘，并把 utils 的 import
// 改回相对路径（tsc 的 paths 只在类型层生效，emit 不重写；dist 要被 Node 直接加载）。

import * as React from 'react';
import { ScrollArea as ScrollAreaPrimitive } from '@base-ui/react/scroll-area';
import { cn } from './cn.js';

function ScrollArea({ className, children, ...props }: ScrollAreaPrimitive.Root.Props) {
    return (
        <ScrollAreaPrimitive.Root data-slot="scroll-area" className={cn('relative', className)} {...props}>
            <ScrollAreaPrimitive.Viewport
                data-slot="scroll-area-viewport"
                className="size-full rounded-[inherit] transition-[color,box-shadow] outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:outline-1"
            >
                {children}
            </ScrollAreaPrimitive.Viewport>
            <ScrollBar />
            <ScrollAreaPrimitive.Corner />
        </ScrollAreaPrimitive.Root>
    );
}

// ⚠️ 与上游 base-nova 模板的差异：模板用 `data-vertical:` / `data-horizontal:`（要求元素带
// `data-vertical` 空属性），但 Base UI 实际只给 `data-orientation="vertical"` —— 实测滚动条宽
// 只有 2px（= border+padding，`w-2.5` 没生效）。这里改成任意变体 `data-[orientation=…]`。
function ScrollBar({ className, orientation = 'vertical', ...props }: ScrollAreaPrimitive.Scrollbar.Props) {
    return (
        <ScrollAreaPrimitive.Scrollbar
            data-slot="scroll-area-scrollbar"
            data-orientation={orientation}
            orientation={orientation}
            className={cn(
                'flex touch-none p-px transition-colors select-none data-[orientation=horizontal]:h-2.5 data-[orientation=horizontal]:flex-col data-[orientation=horizontal]:border-t data-[orientation=horizontal]:border-t-transparent data-[orientation=vertical]:h-full data-[orientation=vertical]:w-2.5 data-[orientation=vertical]:border-l data-[orientation=vertical]:border-l-transparent',
                className,
            )}
            {...props}
        >
            <ScrollAreaPrimitive.Thumb
                data-slot="scroll-area-thumb"
                className="relative flex-1 rounded-full bg-border"
            />
        </ScrollAreaPrimitive.Scrollbar>
    );
}

export { ScrollArea, ScrollBar };

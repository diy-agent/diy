'use client';

import * as React from 'react';
import { ArrowDown as ArrowDownIcon } from 'lucide-react';
import {
    MessageScroller as MessageScrollerPrimitive,
    useMessageScroller,
    useMessageScrollerScrollable,
    useMessageScrollerVisibility,
} from '@shadcn/react/message-scroller';
import { cn } from '../../lib/cn';

import { Button } from './button';

function MessageScrollerProvider(props: React.ComponentProps<typeof MessageScrollerPrimitive.Provider>) {
    return <MessageScrollerPrimitive.Provider {...props} />;
}

function MessageScroller({ className, ...props }: React.ComponentProps<typeof MessageScrollerPrimitive.Root>) {
    return (
        <MessageScrollerPrimitive.Root
            data-slot="message-scroller"
            className={cn(
                'cn-message-scroller group/message-scroller relative flex size-full min-h-0 flex-col overflow-hidden',
                className,
            )}
            {...props}
        />
    );
}

function MessageScrollerViewport({
    className,
    ...props
}: React.ComponentProps<typeof MessageScrollerPrimitive.Viewport>) {
    return (
        <MessageScrollerPrimitive.Viewport
            data-slot="message-scroller-viewport"
            className={cn(
                'cn-message-scroller-viewport size-full min-h-0 min-w-0 scroll-fade-b scrollbar-thin scrollbar-gutter-stable overflow-y-auto overscroll-contain contain-content data-autoscrolling:scrollbar-thumb-transparent data-autoscrolling:scrollbar-track-transparent data-pending-scroll:invisible',
                className,
            )}
            {...props}
        />
    );
}

function MessageScrollerContent({
    className,
    ...props
}: React.ComponentProps<typeof MessageScrollerPrimitive.Content>) {
    return (
        <MessageScrollerPrimitive.Content
            data-slot="message-scroller-content"
            className={cn('cn-message-scroller-content flex h-max min-h-full flex-col', className)}
            {...props}
        />
    );
}

function MessageScrollerItem({
    className,
    scrollAnchor = false,
    ...props
}: React.ComponentProps<typeof MessageScrollerPrimitive.Item>) {
    // 不要给条目上 `content-visibility: auto`（2026-11-28 实测）：它把离屏条目按估计高度
    // 排、滚回视口时再用真实高度重排 —— 上方一长高，滚动位置就往下弹，用户看到的是
    // 「向上翻阅时页面自己乱跳」。条目数受四位数消息分组后只有几十条，布局成本远小于这种跳动。
    return (
        <MessageScrollerPrimitive.Item
            data-slot="message-scroller-item"
            scrollAnchor={scrollAnchor}
            className={cn('cn-message-scroller-item min-w-0 shrink-0', className)}
            {...props}
        />
    );
}

function MessageScrollerButton({
    direction = 'end',
    className,
    children,
    render,
    variant = 'secondary',
    size = 'icon-sm',
    ...props
}: React.ComponentProps<typeof MessageScrollerPrimitive.Button> &
    Pick<React.ComponentProps<typeof Button>, 'variant' | 'size'>) {
    return (
        <MessageScrollerPrimitive.Button
            data-slot="message-scroller-button"
            data-direction={direction}
            data-variant={variant}
            data-size={size}
            direction={direction}
            className={cn(
                'cn-message-scroller-button absolute inset-s-1/2 -translate-x-1/2 border-border bg-background text-foreground transition-[translate,scale,opacity] duration-200 hover:bg-muted hover:text-foreground data-[active=false]:pointer-events-none data-[active=false]:scale-95 data-[active=false]:opacity-0 data-[active=false]:duration-400 data-[active=false]:ease-[cubic-bezier(0.7,0,0.84,0)] data-[active=true]:translate-y-0 data-[active=true]:scale-100 data-[active=true]:opacity-100 data-[active=true]:ease-[cubic-bezier(0.23,1,0.32,1)] data-[direction=end]:bottom-4 data-[direction=end]:data-[active=false]:translate-y-full data-[direction=start]:top-4 data-[direction=start]:data-[active=false]:-translate-y-full rtl:translate-x-1/2 data-[direction=start]:[&_svg]:rotate-180',
                className,
            )}
            render={render ?? <Button variant={variant} size={size} />}
            {...props}
        >
            {children ?? (
                <>
                    <ArrowDownIcon />
                    <span className="sr-only">{direction === 'end' ? 'Scroll to end' : 'Scroll to start'}</span>
                </>
            )}
        </MessageScrollerPrimitive.Button>
    );
}

export {
    MessageScrollerProvider,
    MessageScroller,
    MessageScrollerViewport,
    MessageScrollerContent,
    MessageScrollerItem,
    MessageScrollerButton,
    useMessageScroller,
    useMessageScrollerScrollable,
    useMessageScrollerVisibility,
};

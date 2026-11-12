// devtools.tsx — 「调试」视图（##539 的第一个额外 tab，用来验证插槽链路）。
//
// 它存在的意义有两个：
//   ① 证明 `views` 插槽真的能挂别的实现（而不是只有「标准」一个）；
//   ② 它本身就有用 —— 排查时直接看 `WireMessage[]` 的原始结构，
//      不用再靠猜「这个块到底有没有 id / done 标志」。
//
// 2026-11-11：滚动容器换成 shadcn 的 ScrollArea（第一件真正接上界面的组件）。
// 原来这里是手写 `overflow:auto; height:100%`，滚动条样式在各平台上不一致；
// ScrollArea 把它收敛成薄条 + 令牌色（bg-border → --md-sys-color-outline-variant）。

import * as React from 'react';
import type { ChatViewProps } from '../views.js';
import { ScrollArea } from '../ui/scroll-area.js';

export default function DevtoolsView({ state }: ChatViewProps): React.ReactElement {
    // 空态也套同一个滚动容器（视图外壳只有一种形状，切 tab 时布局不跳）
    if (state.messages.length === 0) {
        return (
            <ScrollArea className="h-full">
                <div className="p-6 text-center text-muted-foreground">还没有消息</div>
            </ScrollArea>
        );
    }
    return (
        <ScrollArea className="h-full font-mono text-[11px] leading-normal">
            <div className="px-3.5 py-2.5">
                {state.messages.map((m, i) => (
                    <div
                        key={i}
                        className="mb-1.5 rounded-md border border-border bg-card px-2 py-1.5 text-foreground"
                    >
                        <div className="mb-1 text-muted-foreground">
                            #{i} role={m.role} blocks={m.blocks.length}
                        </div>
                        <pre className="m-0 whitespace-pre-wrap break-all">{JSON.stringify(m, null, 2)}</pre>
                    </div>
                ))}
            </div>
        </ScrollArea>
    );
}

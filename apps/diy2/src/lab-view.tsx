// lab-view.tsx —— 共用的最小 Astryx 页面内容（不决定是否加载 Tailwind）。

import { LayerProvider } from '@astryxdesign/core/Layer';
import { Theme } from '@astryxdesign/core/theme';
import { neutralTheme } from '@astryxdesign/theme-neutral/built';
import { ChatLayout, ChatMessage, ChatMessageBubble, ChatMessageList, Markdown } from '@astryxdesign/core';

const SAMPLE = `# 一级标题

正文一段，用来对比字号和行高。里面有 \`inline code\` 和 **加粗**。

## 二级标题

1. 有序列表第一项
2. 第二项

| 列 A | 列 B | 列 C |
|---|---|---|
| a1 | b1 | c1 |
| a2 | b2 | c2 |

\`\`\`ts
const x = 1;
\`\`\`
`;

export function Lab() {
    return (
        <Theme theme={neutralTheme} mode="dark">
            <LayerProvider>
                <div style={{ height: '100dvh', display: 'flex' }}>
                    <ChatLayout composer={<div style={{ padding: 16 }}>composer</div>}>
                        <ChatMessageList>
                            <ChatMessage sender="user">
                                <ChatMessageBubble>表格和标题的排版测试</ChatMessageBubble>
                            </ChatMessage>
                            <ChatMessage sender="assistant">
                                <ChatMessageBubble variant="ghost">
                                    <Markdown density="compact">{SAMPLE}</Markdown>
                                </ChatMessageBubble>
                            </ChatMessage>
                        </ChatMessageList>
                    </ChatLayout>
                </div>
            </LayerProvider>
        </Theme>
    );
}

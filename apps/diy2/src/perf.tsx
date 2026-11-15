// perf.tsx —— 对照测每个表面的"单条消息渲染成本"。
// 用法：/perf.html?mode=astryx-md&n=30
// mode: astryx-md | astryx-text | plain-md | plain-text

import { Theme } from '@astryxdesign/core/theme';
import { neutralTheme } from '@astryxdesign/theme-neutral/built';
import { LayerProvider } from '@astryxdesign/core/Layer';
import { ChatMessage, ChatMessageBubble, Markdown } from '@astryxdesign/core';
import { flushSync } from 'react-dom';
import { createRoot } from 'react-dom/client';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';

import '@astryxdesign/core/astryx.css';
import '@astryxdesign/theme-neutral/theme.css';
import './index.css';

const SAMPLE = `### 结论

这个方案是可行的，但要注意三点。第一点是**并发**，第二点是顺序，第三点是回滚。  
具体来说，\`runTurn\` 里必须保证同一 session 串行。

1. 串行执行
2. 失败可重试
3. 结果可观测

| 项 | 状态 | 备注 |
|---|---|---|
| 并发 | 已处理 | 每条 session 一个队列 |
| 顺序 | 已处理 | turn 内按 order 排序 |
| 回滚 | 未处理 | 需要补偿日志 |

\`\`\`ts
const x = 1;
\`\`\`
`;

const params = new URLSearchParams(location.search);
const mode = params.get('mode') ?? 'astryx-md';
const n = Number(params.get('n') ?? '30');

const shape = params.get('shape') ?? 'full';
const NO_CODE = SAMPLE.split('```')[0] ?? SAMPLE;
const PARA = '### 结论\n\n这个方案是可行的，但要注意三点。第一点是并发，第二点是顺序，第三点是回滚。具体来说，runTurn 里必须保证同一 session 串行。\n\n' + '再补一句说明，让段落长度接近真实回答。'.repeat(3);
const source = shape === 'nocode' ? NO_CODE : shape === 'para' ? PARA : SAMPLE;
const items = Array.from({ length: n }, (_, index) => ({ id: index, text: `${source}\n\n第 ${index + 1} 条。` }));

function PlainMarkdown({ text }: { text: string }) {
    return (
        <div>
            <ReactMarkdown remarkPlugins={[remarkGfm]}>{text}</ReactMarkdown>
        </div>
    );
}

function Body() {
    if (mode === 'astryx-md' || mode === 'astryx-text') {
        return (
            <Theme theme={neutralTheme} mode="dark">
                <LayerProvider>
                    <div>
                        {items.map((item) => (
                            <ChatMessage key={item.id} sender="assistant">
                                <ChatMessageBubble variant="ghost" name="diy">
                                    {mode === 'astryx-md' ? <Markdown density="compact">{item.text}</Markdown> : <span>{item.text}</span>}
                                </ChatMessageBubble>
                            </ChatMessage>
                        ))}
                    </div>
                </LayerProvider>
            </Theme>
        );
    }
    return (
        <div>
            {items.map((item) => (
                <div key={item.id}>
                    {mode === 'plain-md' ? <PlainMarkdown text={item.text} /> : <span>{item.text}</span>}
                </div>
            ))}
        </div>
    );
}

const root = createRoot(document.getElementById('root')!);
const t0 = performance.now();
flushSync(() => root.render(<Body />));
const t1 = performance.now();
const out = `mode=${mode} shape=${shape} n=${n} mount=${Math.round(t1 - t0)}ms per-message=${((t1 - t0) / n).toFixed(1)}ms`;
document.title = out;
document.getElementById('out')!.textContent = out;

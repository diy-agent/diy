// devtools.tsx — 「调试」视图（##539 的第一个额外 tab，用来验证插槽链路）。
//
// 它存在的意义有两个：
//   ① 证明 `views` 插槽真的能挂别的实现（而不是只有「标准」一个）；
//   ② 它本身就有用 —— 排查时直接看 `WireMessage[]` 的原始结构，
//      不用再靠猜「这个块到底有没有 id / done 标志」。

import * as React from 'react';
import type { ChatViewProps } from '../views.js';

const S: Record<string, React.CSSProperties> = {
    wrap: { padding: '10px 14px', overflow: 'auto', height: '100%', font: '11px/1.5 ui-monospace, monospace' },
    row: { padding: '6px 8px', marginBottom: '6px', border: '1px solid #e3e5e8', borderRadius: '6px', background: '#fff' },
    head: { color: '#6b7280', marginBottom: '4px' },
    pre: { margin: 0, whiteSpace: 'pre-wrap', wordBreak: 'break-all', color: '#1f2937' },
    empty: { color: '#9ca3af', padding: '24px', textAlign: 'center' },
};

export default function DevtoolsView({ state }: ChatViewProps): React.ReactElement {
    if (state.messages.length === 0) return <div style={S.empty}>还没有消息</div>;
    return (
        <div style={S.wrap}>
            {state.messages.map((m, i) => (
                <div key={i} style={S.row}>
                    <div style={S.head}>
                        #{i} role={m.role} blocks={m.blocks.length}
                    </div>
                    <pre style={S.pre}>{JSON.stringify(m, null, 2)}</pre>
                </div>
            ))}
        </div>
    );
}

// ModelChip —— 房间当前模型（一枚可点的 chip）。
//
// 位置：2026-11-24 起在**输入框底栏**，与上下文 / 作业同一行（用户：「上下文、model 和 job
// 都放到输入框内部大框框的最下面，和其他 agent 类似」）。此前它长在房间头部。
//
// 从 App.tsx 挪出来的原因很实际：底栏是 `ComposerBar`（壳层件），而 App 导入 ComposerBar、
// ComposerBar 又要用 ModelChip —— 留在 App 里就成了环。

import { Cpu } from 'lucide-react';

import { modelLabel } from '../models';
import { useProviders } from '../store';

export function ModelChip({ value, onClick }: { value: string; onClick: () => void }) {
    const providers = useProviders();
    const label = modelLabel(providers, value);
    return (
        <button
            onClick={onClick}
            title={`${label} · 点击切换`}
            className="flex items-center gap-1 rounded-md border px-1.5 py-0.5 font-mono text-xs text-muted-foreground hover:bg-muted"
        >
            <Cpu className="size-3" />
            {label.split(' · ')[0]}
        </button>
    );
}

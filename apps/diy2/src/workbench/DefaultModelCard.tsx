// DefaultModelCard.tsx —— 默认模型卡（在「机器人」页顶部）。
//
// 2026-11-28 用户：默认模型配置 panel 移到 bot 配置去 —— 它管的就是「新建 bot / 房间继承哪个模型」，
// 跟服务商凭据不是一回事，放在模型页里反而让人以为它是价格/规格的一部分。
//
// 只列「真能发出去」的组合（provider 有填 key 的账号、模型是勾选过的）；没配置时是空态。
// 不兜底：没设就是空，`ModelSelectButton` 的 emptyText 直说「未设置」。

import { ModelSelectButton, modelConfig, type ModelConfigSnapshot } from '@diy-agent/entity-chat';
import * as React from 'react';

function messageOf(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

export function DefaultModelCard() {
    const [snapshot, setSnapshot] = React.useState<ModelConfigSnapshot>();
    const [busy, setBusy] = React.useState(false);
    const [error, setError] = React.useState<string>();

    React.useEffect(() => {
        modelConfig
            .read()
            .then(setSnapshot)
            .catch((cause: unknown) => setError(messageOf(cause)));
    }, []);

    const pick = React.useCallback((modelKey: string | null) => {
        setBusy(true);
        setError(undefined);
        modelConfig
            .saveDefaultModel(modelKey)
            .then(setSnapshot)
            .catch((cause: unknown) => setError(messageOf(cause)))
            .finally(() => setBusy(false));
    }, []);

    const value = snapshot?.defaultModelKey ?? '';

    return (
        <div className="rounded-lg border border-border border-l-2 border-l-ring bg-card px-2.5 py-2">
            <div className="flex items-center justify-between gap-2">
                <span className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">默认模型</span>
                {value === '' ? null : (
                    <button
                        type="button"
                        onClick={() => pick(null)}
                        disabled={busy}
                        className="text-[11px] text-muted-foreground hover:text-foreground"
                    >
                        清空
                    </button>
                )}
            </div>
            <div className="mt-1" title={value}>
                <ModelSelectButton value={value} onPick={(key) => pick(key)} emptyText="（未设置 · 点开选择）" />
            </div>
            <p className="mt-1 text-[11px] leading-relaxed text-muted-foreground">
                新建任务 / 项目 / bot 继承它；没设就真的没有，不会拿别的模型顶替。
            </p>
            {error === undefined ? null : <p className="mt-1 text-[11px] text-destructive">{error}</p>}
        </div>
    );
}

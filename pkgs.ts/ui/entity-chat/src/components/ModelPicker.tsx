// ModelPicker —— 三段式选择器：provider → account → model，产物是 `account@provider/model`。
//
// 目录从服务端来（`useProviders()`，真源 model.yaml），本文件**不认识任何具体 provider**：
// 以前这里 import 一张写死的 `PROVIDERS` 表，于是「界面上能选、服务端发不出去」成了常态。

import { findProvider, formatModelKey, parseModelKey } from '../models';
import { useDefaultModelKey, useProviders } from '../store';

export function ModelPicker({ value, onChange }: { value: string; onChange: (key: string) => void }) {
    const providers = useProviders();
    const defaultKey = useDefaultModelKey();
    if (providers.length === 0) {
        return <p className="text-xs text-muted-foreground">模型目录还没加载（看 model.yaml 能不能读到）</p>;
    }

    // 空串 = 没显式选过 ⇒ 显示「会用什么」= 目录的 defaultModel；下拉改一下就变成显式选择。
    const inherited = value.trim() === '';
    const key = parseModelKey(inherited ? (defaultKey ?? '') : value);
    // 当前值可能指向一个已经不存在的 provider / 账号 / 模型（改了 model.yaml、换了机器）：
    // 一律退到目录里的第一个可用项显示，但**不自动改写**上游的值 —— 要不要改由人决定。
    const provider = (key === undefined ? undefined : findProvider(providers, key.provider)) ?? providers[0]!;
    const account =
        provider.accounts.find((item) => item.name === key?.account) ??
        provider.accounts.find((item) => item.configured) ??
        provider.accounts[0];
    const model = provider.models.find((item) => item.id === key?.model) ?? provider.models[0];

    const pick = (next: { provider?: (typeof providers)[number]; account?: string; model?: string }) => {
        const nextProvider = next.provider ?? provider;
        const nextAccount =
            next.account ??
            (nextProvider.accounts.some((item) => item.name === account?.name)
                ? account?.name
                : (nextProvider.accounts.find((item) => item.configured)?.name ?? nextProvider.accounts[0]?.name));
        const nextModel =
            next.model ??
            (nextProvider.models.some((item) => item.id === model?.id) ? model?.id : nextProvider.models[0]?.id);
        if (nextAccount === undefined || nextModel === undefined) return;
        onChange(formatModelKey({ provider: nextProvider.id, account: nextAccount, model: nextModel }));
    };

    return (
        <div className="space-y-2">
            <div className="grid grid-cols-3 gap-2">
                <label className="block text-xs">
                    <span className="mb-1 block text-muted-foreground">provider</span>
                    <select
                        value={provider.id}
                        onChange={(event) => {
                            const next = findProvider(providers, event.target.value);
                            if (next !== undefined) pick({ provider: next });
                        }}
                        className="w-full rounded-lg border bg-card px-2 py-1.5 text-sm outline-none"
                    >
                        {providers.map((item) => (
                            <option key={item.id} value={item.id}>
                                {item.name}
                            </option>
                        ))}
                    </select>
                </label>
                <label className="block text-xs">
                    <span className="mb-1 block text-muted-foreground">account</span>
                    <select
                        value={account?.name ?? ''}
                        onChange={(event) => pick({ account: event.target.value })}
                        className="w-full rounded-lg border bg-card px-2 py-1.5 text-sm outline-none"
                    >
                        {provider.accounts.map((item) => (
                            <option key={item.name} value={item.name}>
                                {item.name}
                                {item.configured ? '' : '（未填 key）'}
                            </option>
                        ))}
                    </select>
                </label>
                <label className="block text-xs">
                    <span className="mb-1 block text-muted-foreground">model</span>
                    <select
                        value={model?.id ?? ''}
                        onChange={(event) => pick({ model: event.target.value })}
                        className="w-full rounded-lg border bg-card px-2 py-1.5 text-sm outline-none"
                    >
                        {provider.models.map((item) => (
                            <option key={item.id} value={item.id}>
                                {item.name}
                            </option>
                        ))}
                    </select>
                </label>
            </div>
            {inherited && (
                <p className="text-[10px] text-muted-foreground">
                    没显式选过 ⇒ 跟随 model.yaml 的 defaultModel（改一下就变成这条的专属选择）
                </p>
            )}
            <p className="text-[10px] text-muted-foreground">
                {model === undefined
                    ? '目录里没有模型'
                    : [model.contextWindow === undefined ? '窗口未知' : `${Math.round(model.contextWindow / 1024)}k 上下文`,
                       model.cost === undefined ? null : `$${model.cost.input}/$${model.cost.output} 每百万 token`,
                       `${provider.api}`,
                      ]
                          .filter((part): part is string => part !== null)
                          .join(' · ')}
            </p>
        </div>
    );
}

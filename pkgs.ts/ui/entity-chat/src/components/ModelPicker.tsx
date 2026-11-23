// ModelPicker —— 三段式选择器：provider → account → model，产物是 `account@provider/model`。
//
// 目录从服务端来（`useProviders()`，真源 model.yaml），本文件**不认识任何具体 provider**：
// 以前这里 import 一张写死的 `PROVIDERS` 表，于是「界面上能选、服务端发不出去」成了常态。
//
// 控件用 shadcn 的 `Select`（Base UI 原语）而不是原生 <select>（2026-11-23）：
// 原生 select 的下拉由操作系统绘制，方向键/Home/End/字母跳转全看平台实现，
// 且在 overflow 容器里会被裁剪。换过来之后键盘行为、aria 与弹层定位都归组件层管。

import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@diy-agent/ui-shadcn';

import { findProvider, formatModelKey, parseModelKey } from '../models';
import { useProviders } from '../store';

export function ModelPicker({ value, onChange }: { value: string; onChange: (key: string) => void }) {
    const providers = useProviders();
    if (providers.length === 0) {
        return <p className="text-xs text-muted-foreground">模型目录还没加载（看 model.yaml 能不能读到）</p>;
    }

    const key = parseModelKey(value);
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
                    <Select
                        value={provider.id}
                        onValueChange={(next) => {
                            const found = findProvider(providers, String(next));
                            if (found !== undefined) pick({ provider: found });
                        }}
                    >
                        <SelectTrigger size="sm" className="w-full">
                            <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                            {providers.map((item) => (
                                <SelectItem key={item.id} value={item.id}>
                                    {item.name}
                                </SelectItem>
                            ))}
                        </SelectContent>
                    </Select>
                </label>
                <label className="block text-xs">
                    <span className="mb-1 block text-muted-foreground">account</span>
                    <Select value={account?.name ?? ''} onValueChange={(next) => pick({ account: String(next) })}>
                        <SelectTrigger size="sm" className="w-full">
                            <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                            {provider.accounts.map((item) => (
                                <SelectItem key={item.name} value={item.name}>
                                    {item.configured ? item.name : `${item.name}（未填 key）`}
                                </SelectItem>
                            ))}
                        </SelectContent>
                    </Select>
                </label>
                <label className="block text-xs">
                    <span className="mb-1 block text-muted-foreground">model</span>
                    <Select value={model?.id ?? ''} onValueChange={(next) => pick({ model: String(next) })}>
                        <SelectTrigger size="sm" className="w-full">
                            <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                            {provider.models.map((item) => (
                                <SelectItem key={item.id} value={item.id}>
                                    {item.name}
                                </SelectItem>
                            ))}
                        </SelectContent>
                    </Select>
                </label>
            </div>
            <p className="text-[10px] text-muted-foreground">
                {model === undefined
                    ? '目录里没有模型'
                    : [
                          model.contextWindow === undefined
                              ? '窗口未知'
                              : `${Math.round(model.contextWindow / 1024)}k 上下文`,
                          model.cost === undefined ? null : `$${model.cost.input}/$${model.cost.output} 每百万 token`,
                          `${provider.api}`,
                      ]
                          .filter((part): part is string => part !== null)
                          .join(' · ')}
            </p>
        </div>
    );
}

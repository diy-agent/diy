import { formatModelKey, modelInfoOf, parseModelKey, providerOf, PROVIDERS } from '../models';

/** 三段式选择器：provider → account → model，产物是 `account@provider/model` */
export function ModelPicker({ value, onChange }: { value: string; onChange: (key: string) => void }) {
    const key = parseModelKey(value);
    const provider = providerOf(key.provider);
    const model = modelInfoOf(key);

    const pick = (next: { provider?: string; account?: string; model?: string }) => {
        const providerId = next.provider ?? key.provider;
        const p = providerOf(providerId);
        const account = next.account ?? p.accounts[0]!.name;
        const modelId = next.model ?? Object.keys(p.models)[0]!;
        onChange(formatModelKey({ provider: providerId, account, model: modelId }));
    };

    return (
        <div className="space-y-2">
            <div className="grid grid-cols-3 gap-2">
                <label className="block text-xs">
                    <span className="mb-1 block text-muted-foreground">provider</span>
                    <select
                        value={key.provider}
                        onChange={(event) => pick({ provider: event.target.value })}
                        className="w-full rounded-lg border bg-card px-2 py-1.5 text-sm outline-none"
                    >
                        {PROVIDERS.map((item) => (
                            <option key={item.id} value={item.id}>
                                {item.name}
                            </option>
                        ))}
                    </select>
                </label>
                <label className="block text-xs">
                    <span className="mb-1 block text-muted-foreground">account</span>
                    <select
                        value={key.account}
                        onChange={(event) => pick({ account: event.target.value })}
                        className="w-full rounded-lg border bg-card px-2 py-1.5 text-sm outline-none"
                    >
                        {provider.accounts.map((item) => (
                            <option key={item.name} value={item.name}>
                                {item.name}
                            </option>
                        ))}
                    </select>
                </label>
                <label className="block text-xs">
                    <span className="mb-1 block text-muted-foreground">model</span>
                    <select
                        value={key.model}
                        onChange={(event) => pick({ model: event.target.value })}
                        className="w-full rounded-lg border bg-card px-2 py-1.5 text-sm outline-none"
                    >
                        {Object.values(provider.models).map((item) => (
                            <option key={item.id} value={item.id}>
                                {item.name}
                            </option>
                        ))}
                    </select>
                </label>
            </div>
            <p className="font-mono text-[11px] text-muted-foreground">
                {formatModelKey(key)}
                {model?.contextWindow !== undefined && <span className="ml-2">{Math.round(model.contextWindow / 1024)}k 上下文</span>}
            </p>
        </div>
    );
}

// ModelConfigView.tsx —— 模型配置页（工作台的「设置」页中心区域）。
//
// 观感照 `2026-11-23` 那版 demo：**左栏是服务商清单**（搜索 + 已连接 / 全部 + 默认模型卡），
// **右栏是选中那家的详情**（凭据 / 模型 / 接口三段）。列表进详情，不做四块表平铺 ——
// 平铺那版被用户判为「太乱」，原因是它把「哪些能选」和「怎么改」摊在同一屏。
//
// 数据全从服务端来（`diy2.models.config`，真源 `<home>/model.yaml`）；本文件**不认识**
// provider 常量、不猜默认模型、也不自带第二份目录 —— 那正是这一轮要消灭的第三份真源。
//
// 三条硬约束：
//   · key 只进不出：填进去就落盘，回来只有字符数（`saved.chars`），界面上永远是 `••••`
//   · 写完即刷新：`modelConfig.*` 每个方法都会让 store 重拉模型面，选模型器与顶部横幅立刻跟上
//   · 失败要看见：错误显示在右栏顶部（服务端的话原样带过来，它比「保存失败」有用得多）
//   · 校验在**这一根**输入下面说：四个表单都走 TanStack Form（`useForm` + 字段级 validator），
//     错误显示在出问题那个输入下面、边框变红。以前是「填错了就静悄悄 return」——
//     按钮按下去什么也没发生，人只能怀疑自己没点到。
//     为什么用库而不是手搓 `useState<string | undefined>`×5：四个表单加起来十几根输入，
//     手搓就得自己管 touched / 提交时全量校验 / 失败后不清空输入，这些正是库白送的那部分。

import { Modal, modelConfig, type ModelConfigProvider, type ModelConfigSnapshot } from '@diy-agent/entity-chat';
import { useForm } from '@tanstack/react-form';
import * as React from 'react';

/** 错误信息：服务端的话原样带出来（catalog 的报错里有 provider id 与原因） */
function messageOf(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

/** provider 的颜色点：由 id 稳定散列（不引主题变量，同一个 id 每次都是同一个颜色） */
function colorOf(id: string): string {
    let hash = 0;
    for (let index = 0; index < id.length; index += 1) hash = (hash * 31 + id.charCodeAt(index)) % 360;
    return `hsl(${hash} 62% 55%)`;
}

function accountsConfigured(provider: ModelConfigProvider): number {
    return provider.accounts.filter((account) => account.configured).length;
}

/** 能真发出去的那几个模型：勾选过、且这家至少有一个填了 key 的账号 */
function usableModels(provider: ModelConfigProvider): ModelConfigProvider['models'] {
    if (accountsConfigured(provider) === 0) return [];
    return provider.models.filter((model) => model.enabled);
}

function contextLabel(contextWindow: number | undefined): string {
    if (contextWindow === undefined) return '—';
    if (contextWindow >= 1_000_000) return `${(contextWindow / 1_000_000).toFixed(contextWindow % 1_000_000 === 0 ? 0 : 1)}M`;
    return `${String(Math.round(contextWindow / 1000))}K`;
}

function costLabel(cost: { input: number; output: number } | undefined): string {
    if (cost === undefined) return '—';
    return `$${cost.input} / $${cost.output}`;
}

// ── 校验 ────────────────────────────────────────────────────────────────────
//
// 每条只回答一件事：「为什么不能写」。返回 `string` = 一句人话，`undefined` = 通过
// （TanStack Form 的字段 validator 就是这个形状，不需要再包一层 zod）。
//
// 原则：**能拦在本地的不留给服务端**。服务端也在校验，但它只能给一句「写失败了」；
// 而「key 里有个换行」这种事在失焦前就能说清楚（那是粘贴时最容易带进来的）。

/** 从 TanStack Form 的 `meta.errors` 里拿第一条能显示的话（错误项可能是字符串或对象） */
function errorOf(errors: readonly unknown[]): string | undefined {
    for (const item of errors) {
        if (typeof item === 'string' && item !== '') return item;
    }
    return undefined;
}

const ACCOUNT_NAME_MAX = 40;

/** 账号名：这家下面唯一（同名就是同一个账号，写下去会把上一个的 key 盖掉） */
function validAccountName(name: string, taken: readonly string[]): string | undefined {
    const value = name.trim();
    if (value === '') return '填个账号名（如 main）';
    if (/\s/.test(value)) return '不能有空格';
    if (value.length > ACCOUNT_NAME_MAX) return `太长了（${String(value.length)} 字，最多 ${String(ACCOUNT_NAME_MAX)}）`;
    if (taken.includes(value)) return '这家已经有同名账号了 —— 换个名字，或用上面那只账号的「换钥」';
    return undefined;
}

/** 密钥：只查形状，不联网试（试打要花一次请求，还可能被限流） */
function validSecret(secret: string): string | undefined {
    const value = secret.trim();
    if (value === '') return '粘一下 key（只写不回显，保存后界面上只有字符数）';
    if (/\s/.test(value)) return 'key 里不该有空格 / 换行 —— 常见于复制时多带了一行';
    if (value.length < 8) return `太短了（${String(value.length)} 字）—— 确认没粘漏`;
    return undefined;
}

/** 模型 id：写进 `model.yaml` 的就是它，会直接拿去发请求，形状错了发不出去 */
function validModelId(id: string, existing: readonly string[]): string | undefined {
    const value = id.trim();
    if (value === '') return '模型 id 是必填（发送时用它）';
    if (/\s/.test(value)) return '不能有空格';
    if (!/^[A-Za-z0-9][A-Za-z0-9._:/-]*$/.test(value)) return '只能用字母数字与 . _ : / -';
    if (existing.includes(value)) return '这家已经有这个 id 了 —— 直接在上面勾它';
    return undefined;
}

/** 自定义服务商的 id：它会成为 `model.yaml` 里的键，所以形状要死一点（也是文件名/配置段的习惯） */
function validProviderId(id: string, known: readonly string[]): string | undefined {
    const value = id.trim();
    if (value === '') return 'id 是必填（model.yaml 里用它）';
    if (!/^[a-z0-9][a-z0-9._-]*$/.test(value)) return '小写字母数字 + . _ -（不要空格、不要中文）';
    if (known.includes(value)) return '目录里已经有这家了 —— 在左边搜它，不用新建';
    return undefined;
}

function validBaseUrl(api: string): string | undefined {
    const value = api.trim();
    if (value === '') return '接口基址是必填（ai-sdk 靠它拼请求）';
    return /^https?:\/\/[^\s]+$/.test(value) ? undefined : '要 http(s):// 开头的完整地址';
}

/** 「可选数字」：空 = 不填（不算错）；填了就必须读得出数字且落在区间里 */
function validOptionalNumber(
    text: string,
    hint: string,
    range: { integer?: boolean; min?: number } = {},
): string | undefined {
    const value = text.trim();
    if (value === '') return undefined;
    const number = Number(value);
    if (!Number.isFinite(number)) return `${hint}要数字（「${value}」读不出来）`;
    if (range.integer === true && !Number.isInteger(number)) return `${hint}要整数`;
    if (range.min !== undefined && number < range.min) return `${hint}不能小于 ${String(range.min)}`;
    return undefined;
}

function validNpm(npm: string): string | undefined {
    const value = npm.trim();
    if (value === '') return undefined;
    return /^(@[a-z0-9-~][a-z0-9-._~]*\/)?[a-z0-9-~][a-z0-9-._~]*$/i.test(value)
        ? undefined
        : '看着不像 npm 包名（例：@ai-sdk/openai-compatible）';
}

// ── 页 ────────────────────────────────────────────────────────────────────────

export function ModelConfigView() {
    const [snapshot, setSnapshot] = React.useState<ModelConfigSnapshot>();
    const [error, setError] = React.useState<string>();
    const [busy, setBusy] = React.useState(false);
    const [query, setQuery] = React.useState('');
    const [selected, setSelected] = React.useState('');

    const load = React.useCallback(() => {
        modelConfig
            .read()
            .then((next) => {
                setSnapshot(next);
                setError(undefined);
            })
            .catch((cause: unknown) => setError(messageOf(cause)));
    }, []);

    React.useEffect(load, [load]);

    /**
     * 所有写操作走这里：统一 busy / 错误 / 用回包替换整页状态。
     * 返回「成没成」——表单据此决定要不要清空输入（失败了还清掉，人就白输了）。
     */
    const run = React.useCallback(async (action: () => Promise<ModelConfigSnapshot>): Promise<boolean> => {
        setBusy(true);
        setError(undefined);
        try {
            setSnapshot(await action());
            return true;
        } catch (cause) {
            setError(messageOf(cause));
            // 服务端可能只写了一半（比如 spec 写了、账号没写）：拉一份真相回来
            load();
            return false;
        } finally {
            setBusy(false);
        }
    }, [load]);

    if (snapshot === undefined) {
        return (
            <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
                {error === undefined ? '正在读取模型配置 …' : `读不到模型配置：${error}`}
            </div>
        );
    }

    const providers = snapshot.providers;
    const connected = providers.filter((provider) => provider.configured);
    const rest = providers.filter((provider) => !provider.configured);
    const keyword = query.trim().toLowerCase();
    const match = (provider: ModelConfigProvider): boolean =>
        keyword === '' ||
        provider.id.toLowerCase().includes(keyword) ||
        provider.name.toLowerCase().includes(keyword);
    const current = providers.find((provider) => provider.id === selected) ?? connected[0] ?? rest[0];

    return (
        <div className="grid h-full min-h-0 grid-cols-[minmax(232px,288px)_1fr] bg-background text-foreground">
            <aside className="flex min-h-0 flex-col border-r border-border">
                <div className="space-y-2.5 border-b border-border p-3">
                    <DefaultModelCard
                        snapshot={snapshot}
                        busy={busy}
                        onPick={(modelKey) => void run(() => modelConfig.saveDefaultModel(modelKey))}
                    />
                    <input
                        value={query}
                        onChange={(event) => setQuery(event.target.value)}
                        placeholder={`搜索服务商（${String(providers.length)} 家）`}
                        className="w-full rounded-lg border border-border bg-card px-2 py-1.5 text-xs outline-none focus:border-ring"
                    />
                </div>
                <div className="min-h-0 flex-1 overflow-auto px-2 py-2">
                    {connected.length > 0 ? (
                        <Group label="已连接" count={connected.length}>
                            {connected.filter(match).map((provider) => (
                                <ProviderRow
                                    key={provider.id}
                                    provider={provider}
                                    selected={current?.id === provider.id}
                                    onSelect={() => setSelected(provider.id)}
                                />
                            ))}
                        </Group>
                    ) : null}
                    <Group label={connected.length > 0 ? '全部服务商' : '服务商'} count={rest.filter(match).length}>
                        {rest.filter(match).map((provider) => (
                            <ProviderRow
                                key={provider.id}
                                provider={provider}
                                selected={current?.id === provider.id}
                                onSelect={() => setSelected(provider.id)}
                            />
                        ))}
                    </Group>
                    {providers.length === 0 ? (
                        <p className="px-2 py-3 text-xs leading-relaxed text-muted-foreground">
                            目录里一家都没有 —— 缺 <code className="text-foreground">data/models.dev.json</code>
                            （标准 provider 的规格全在它里面）。在仓库根跑{' '}
                            <code className="text-foreground">./scripts/seed-run-home.sh &lt;数据根&gt;</code>
                            ，或点下面的「添加自定义服务商」手写一家。
                        </p>
                    ) : null}
                </div>
                <AddCustomProvider
                    known={providers.map((provider) => provider.id)}
                    busy={busy}
                    onRun={run}
                    onAdded={setSelected}
                />
            </aside>

            <main className="min-h-0 overflow-auto">
                {error !== undefined ? (
                    <div className="border-b border-red-500/40 bg-red-500/10 px-4 py-2 text-xs text-red-300">{error}</div>
                ) : null}
                {current === undefined ? (
                    <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
                        左边选一家服务商
                    </div>
                ) : (
                    <ProviderDetail
                        key={current.id}
                        provider={current}
                        snapshot={snapshot}
                        busy={busy}
                        onRun={run}
                        onRemoved={() => setSelected('')}
                    />
                )}
            </main>
        </div>
    );
}

function Group({ label, count, children }: { label: string; count: number; children: React.ReactNode }) {
    if (count === 0) return null;
    return (
        <div className="mb-1">
            <div className="flex items-center gap-2 px-1.5 pb-1 pt-2 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
                <span>{label}</span>
                <span className="h-px flex-1 bg-border" />
                <span>{count}</span>
            </div>
            {children}
        </div>
    );
}

function ProviderRow({
    provider,
    selected,
    onSelect,
}: {
    provider: ModelConfigProvider;
    selected: boolean;
    onSelect: () => void;
}) {
    const accounts = accountsConfigured(provider);
    return (
        <button
            onClick={onSelect}
            className={`flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-[13px] ${
                selected ? 'bg-muted font-semibold text-foreground' : 'text-foreground/90 hover:bg-muted/60'
            }`}
        >
            <span className="size-1.5 shrink-0 rounded-full" style={{ background: colorOf(provider.id) }} />
            <span className="min-w-0 flex-1 truncate">{provider.name}</span>
            <span className="shrink-0 text-[11px] tabular-nums text-muted-foreground">
                {accounts > 0 ? `${String(accounts)} 账号` : `${String(provider.models.length)} 模型`}
            </span>
        </button>
    );
}

// ── 默认模型 ──────────────────────────────────────────────────────────────────

/**
 * 默认模型卡：新建任务 / 项目 / bot 都继承它（`model.yaml` 顶层 `defaultModel`）。
 *
 * 只列「真能发出去」的组合：provider 有填了 key 的账号、模型是勾选过的。
 * 列这些东西本身就是在告诉人「现在这个实例能用什么」——所以没配置时它是空态，不是一个空下拉。
 */
function DefaultModelCard({
    snapshot,
    busy,
    onPick,
}: {
    snapshot: ModelConfigSnapshot;
    busy: boolean;
    onPick: (modelKey: string | null) => void;
}) {
    const options = React.useMemo(() => {
        const out: Array<{ key: string; label: string }> = [];
        for (const provider of snapshot.providers) {
            const account = provider.accounts.find((item) => item.configured);
            if (account === undefined) continue;
            for (const model of provider.models) {
                if (!model.enabled) continue;
                out.push({
                    key: `${account.name}@${provider.id}/${model.id}`,
                    label: `${model.name} · ${provider.name}`,
                });
            }
        }
        return out;
    }, [snapshot]);

    const value = snapshot.defaultModelKey ?? '';
    const missing = value !== '' && !options.some((option) => option.key === value);

    return (
        <div className="rounded-lg border border-border border-l-2 border-l-ring bg-card px-2.5 py-2">
            <div className="flex items-center justify-between gap-2">
                <span className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">默认模型</span>
                {value === '' ? null : (
                    <button
                        onClick={() => onPick(null)}
                        disabled={busy}
                        className="text-[11px] text-muted-foreground hover:text-foreground"
                    >
                        清空
                    </button>
                )}
            </div>
            {options.length === 0 ? (
                <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
                    还没有可用的组合 —— 先在右边填一家服务的 key，再勾选模型。
                </p>
            ) : (
                <select
                    value={value}
                    disabled={busy}
                    onChange={(event) => onPick(event.target.value === '' ? null : event.target.value)}
                    className="mt-1 w-full rounded-md border border-border bg-background px-1.5 py-1 text-xs outline-none"
                >
                    <option value="">（没设 · 发送时才知道用什么）</option>
                    {options.map((option) => (
                        <option key={option.key} value={option.key}>
                            {option.label}
                        </option>
                    ))}
                    {missing ? <option value={value}>{value}（目录里没有）</option> : null}
                </select>
            )}
            {missing ? (
                <p className="mt-1 text-[11px] text-amber-400">
                    现在指向的模型在目录里不存在了 —— 换一个，或清空。
                </p>
            ) : null}
        </div>
    );
}

// ── 详情 ──────────────────────────────────────────────────────────────────────

function ProviderDetail({
    provider,
    snapshot,
    busy,
    onRun,
    onRemoved,
}: {
    provider: ModelConfigProvider;
    snapshot: ModelConfigSnapshot;
    busy: boolean;
    onRun: (action: () => Promise<ModelConfigSnapshot>) => Promise<boolean>;
    onRemoved: () => void;
}) {
    const accounts = accountsConfigured(provider);
    const enabledCount = provider.models.filter((model) => model.enabled).length;
    const endpointMissing = provider.api === undefined;
    /** 待确认移除（空 = 没在问）：连账号带开关一起删，不可撤销 */
    const [removing, setRemoving] = React.useState(false);

    return (
        <div className="mx-auto max-w-3xl px-5 py-4">
            <header className="flex items-start gap-3 border-b border-border pb-3">
                <span className="mt-1.5 size-2 rounded-full" style={{ background: colorOf(provider.id) }} />
                <div className="min-w-0 flex-1">
                    <h2 className="truncate text-sm font-semibold">{provider.name}</h2>
                    <p className="mt-0.5 text-[11px] text-muted-foreground">
                        <code>{provider.id}</code> · {String(provider.models.length)} 个模型 ·{' '}
                        {provider.configured ? (
                            <span className="text-emerald-400">已接入{accounts > 0 ? `（${String(accounts)} 账号）` : ''}</span>
                        ) : (
                            <span className="text-amber-400">未接入</span>
                        )}
                        {endpointMissing ? <span className="text-amber-400"> · 目录没给 api</span> : null}
                    </p>
                </div>
                {provider.configured ? (
                    <button
                        disabled={busy}
                        onClick={() => setRemoving(true)}
                        className="rounded-md border border-red-500/40 px-2 py-1 text-[11px] text-red-300 hover:bg-red-500/10 disabled:opacity-50"
                    >
                        移除
                    </button>
                ) : null}
            </header>

            {removing ? (
                <Modal title={`移除「${provider.name}」`} onClose={() => setRemoving(false)}>
                    <p className="text-xs leading-relaxed text-muted-foreground">
                        {provider.kind === 'custom'
                            ? '这家是自定义的：接口规格（providers.custom.yaml）也一起删 —— 再加回来要重写 api 基址与模型。'
                            : '账号与模型开关从 model.yaml 里删掉。目录里这家还在，随时能再接入。'}
                    </p>
                    <div className="mt-4 flex justify-end gap-2">
                        <button
                            onClick={() => setRemoving(false)}
                            className="rounded-md border border-border px-3 py-1.5 text-xs hover:bg-muted"
                        >
                            取消
                        </button>
                        <button
                            disabled={busy}
                            onClick={() => {
                                setRemoving(false);
                                void onRun(() => modelConfig.removeProvider(provider.id)).then(onRemoved);
                            }}
                            className="rounded-md border border-red-500/40 bg-red-500/10 px-3 py-1.5 text-xs text-red-300 hover:bg-red-500/20 disabled:opacity-50"
                        >
                            移除
                        </button>
                    </div>
                </Modal>
            ) : null}

            <Section title="凭据" note={accounts > 0 ? '密钥只写不回显' : '填了这家立刻上移到「已连接」'}>
                <Accounts
                    provider={provider}
                    busy={busy}
                    onRun={onRun}
                />
            </Section>

            <Section
                title="模型"
                note={
                    endpointMissing
                        ? '这家没 api · 勾了也发不出去'
                        : accounts > 0
                          ? `已启用 ${String(enabledCount)} / ${String(provider.models.length)}`
                          : '未填 key · 可以先勾好'
                }
            >
                <Models provider={provider} busy={busy} onRun={onRun} />
            </Section>

            <Section title="接口" note="来自目录快照，不用手填">
                <SpecForm provider={provider} busy={busy} onRun={onRun} />
            </Section>

            <p className="mt-4 text-[11px] leading-relaxed text-muted-foreground">
                写在哪：<code className="text-foreground">{snapshot.modelConfigPath}</code>
                {provider.kind === 'custom' ? (
                    <>
                        {' '}
                        · 这家的规格在{' '}
                        <code className="text-foreground">
                            {snapshot.home}/providers.custom.yaml
                        </code>
                    </>
                ) : null}
            </p>
        </div>
    );
}

function Section({ title, note, children }: { title: string; note: string; children: React.ReactNode }) {
    return (
        <section className="border-b border-border py-3">
            <div className="mb-2 flex flex-wrap items-baseline gap-x-3 gap-y-1">
                <h3 className="text-xs font-semibold uppercase tracking-wide text-foreground/80">{title}</h3>
                <span className="text-[11px] text-muted-foreground">{note}</span>
            </div>
            {children}
        </section>
    );
}

// ── 凭据 ──────────────────────────────────────────────────────────────────────

function Accounts({
    provider,
    busy,
    onRun,
}: {
    provider: ModelConfigProvider;
    busy: boolean;
    onRun: (action: () => Promise<ModelConfigSnapshot>) => Promise<boolean>;
}) {
    const [adding, setAdding] = React.useState(false);
    const [rotating, setRotating] = React.useState('');
    /** 正在改名的那个账号（空 = 没有）—— 就地输入，不用 window.prompt */
    const [renaming, setRenaming] = React.useState('');
    /** 待确认删除的账号名（空 = 没在问）—— 删 key 不可撤销，问一句 */
    const [removing, setRemoving] = React.useState('');
    const taken = provider.accounts.map((account) => account.name);

    return (
        <div className="space-y-2">
            {provider.accounts.map((account) => (
                <div key={account.name} className="rounded-lg border border-border bg-card px-3 py-2">
                    <div className="flex items-center gap-2">
                        <span
                            className={`size-1.5 shrink-0 rounded-full ${
                                account.configured ? 'bg-emerald-400' : 'bg-amber-400'
                            }`}
                        />
                        <div className="min-w-0 flex-1">
                            {renaming === account.name ? (
                                <RenameInput
                                    value={account.name}
                                    busy={busy}
                                    // 改成已有的名字 = 两个账号同名，写下去会把那个的 key 盖掉
                                    validate={(next) =>
                                        next === account.name ? undefined : validAccountName(next, taken)
                                    }
                                    onCancel={() => setRenaming('')}
                                    onCommit={(next) => {
                                        // 名字没变 / 清空都不算改：直接退出编辑态，别发一条空写入
                                        if (next === '' || next === account.name) {
                                            setRenaming('');
                                            return;
                                        }
                                        void onRun(() =>
                                            modelConfig.renameAccount({ providerId: provider.id, from: account.name, to: next }),
                                        ).then((ok) => {
                                            if (ok) setRenaming('');
                                        });
                                    }}
                                />
                            ) : (
                                <div className="text-xs font-semibold">{account.name}</div>
                            )}
                            <div className="font-mono text-[11px] text-muted-foreground">
                                {account.configured
                                    ? account.env
                                        ? '环境变量引用（发送时展开）'
                                        : `•••••••• ${String(account.chars ?? 0)} 字符`
                                    : '没填 key'}
                            </div>
                        </div>
                        <button
                            disabled={busy}
                            onClick={() => setRotating(rotating === account.name ? '' : account.name)}
                            className="rounded border border-border px-1.5 py-0.5 text-[11px] hover:bg-muted disabled:opacity-50"
                        >
                            {account.configured ? '换钥' : '填 key'}
                        </button>
                        <button
                            disabled={busy || renaming === account.name}
                            onClick={() => setRenaming(account.name)}
                            className="rounded border border-border px-1.5 py-0.5 text-[11px] hover:bg-muted disabled:opacity-50"
                        >
                            改名
                        </button>
                        <button
                            disabled={busy}
                            onClick={() => setRemoving(account.name)}
                            className="rounded border border-border px-1.5 py-0.5 text-[11px] text-red-300 hover:bg-red-500/10 disabled:opacity-50"
                        >
                            删除
                        </button>
                    </div>
                    {rotating === account.name ? (
                        <KeyForm
                            providerId={provider.id}
                            kind={provider.configured ? undefined : provider.kind}
                            defaultName={account.name}
                            lockName
                            busy={busy}
                            onDone={() => setRotating('')}
                            onRun={onRun}
                        />
                    ) : null}
                </div>
            ))}

            {provider.accounts.length === 0 ? (
                <KeyForm
                    providerId={provider.id}
                    kind={provider.configured ? undefined : provider.kind}
                    defaultName="main"
                    taken={taken}
                    busy={busy}
                    onRun={onRun}
                />
            ) : adding ? (
                <KeyForm
                    providerId={provider.id}
                    kind={provider.configured ? undefined : provider.kind}
                    defaultName=""
                    taken={taken}
                    busy={busy}
                    onDone={() => setAdding(false)}
                    onRun={onRun}
                />
            ) : (
                <button
                    onClick={() => setAdding(true)}
                    disabled={busy}
                    className="rounded-md border border-dashed border-border px-2 py-1 text-[11px] text-muted-foreground hover:border-ring hover:text-foreground disabled:opacity-50"
                >
                    ＋ 追加一个账号
                </button>
            )}

            {removing === '' ? null : (
                <Modal title={`删掉账号「${removing}」`} onClose={() => setRemoving('')}>
                    <p className="text-xs leading-relaxed text-muted-foreground">
                        它的 key 一并从 <code className="text-foreground">model.yaml</code> 里消失，不可撤销。
                    </p>
                    <div className="mt-4 flex justify-end gap-2">
                        <button
                            onClick={() => setRemoving('')}
                            className="rounded-md border border-border px-3 py-1.5 text-xs hover:bg-muted"
                        >
                            取消
                        </button>
                        <button
                            disabled={busy}
                            onClick={() => {
                                const name = removing;
                                setRemoving('');
                                void onRun(() => modelConfig.removeAccount({ providerId: provider.id, name }));
                            }}
                            className="rounded-md border border-red-500/40 bg-red-500/10 px-3 py-1.5 text-xs text-red-300 hover:bg-red-500/20 disabled:opacity-50"
                        >
                            删除
                        </button>
                    </div>
                </Modal>
            )}
        </div>
    );
}

/**
 * 账号改名：行内输入。
 *
 * 为什么不用 `window.prompt`：本应用的改名一律是就地输入（见 entity-chat 的 `EditableName`
 * ——回车提交、Esc 取消、失焦提交），页面里蹦一个系统对话框既不像这个应用，也不能被
 * 键盘打断 / 恢复。行为照抄那一份：**回车提交、Esc 取消、失焦提交**。
 */
function RenameInput({
    value,
    busy,
    validate,
    onCommit,
    onCancel,
}: {
    value: string;
    busy: boolean;
    /** 返回一句人话 = 这个名字不能用：就地标红且**不提交**（提交了也只能等服务端拦下） */
    validate?: (next: string) => string | undefined;
    onCommit: (next: string) => void;
    onCancel: () => void;
}) {
    const [draft, setDraft] = React.useState(value);
    const [error, setError] = React.useState<string>();
    /** 回车已经提交过：紧接着的 blur 不要再提交一次（那次会把刚改好的名字再写一遍） */
    const done = React.useRef(false);

    /** 试提交：不过校验就留在编辑态把错因亮出来（不是静默放弃，也不是关掉输入框） */
    const commit = (next: string): void => {
        const message = validate?.(next);
        if (message !== undefined) {
            setError(message);
            return;
        }
        done.current = true;
        onCommit(next);
    };

    return (
        <div>
            <input
                autoFocus
                value={draft}
                disabled={busy}
                aria-invalid={error !== undefined}
                onChange={(event) => {
                    setDraft(event.target.value);
                    setError(undefined);
                }}
                onKeyDown={(event) => {
                    if (event.key === 'Enter') {
                        commit(draft.trim());
                    } else if (event.key === 'Escape') {
                        done.current = true;
                        onCancel();
                    }
                }}
                onBlur={() => {
                    if (done.current) return;
                    commit(draft.trim());
                }}
                className={`w-full rounded border bg-background px-1.5 py-0.5 text-xs font-semibold outline-none ${
                    error === undefined ? 'border-ring' : 'border-red-500/60'
                }`}
            />
            {error === undefined ? null : (
                <span className="mt-0.5 block text-[11px] leading-relaxed text-red-300">{error}</span>
            )}
        </div>
    );
}

/**
 * 填 key 的表单。`value` 是**唯一**会离开浏览器的密钥，送出去就不再回来：
 * 成功后本地立刻清空输入框（回包里只有字符数）。
 *
 * 校验走 TanStack Form 的字段级 validator：空 key / 带空白的 key / 撞名字的账号名都
 * 就地标红，而不再是「按下保存什么也没发生」。
 */
function KeyForm({
    providerId,
    kind,
    defaultName,
    lockName = false,
    taken = [],
    busy,
    onDone,
    onRun,
}: {
    providerId: string;
    kind?: 'std' | 'custom';
    defaultName: string;
    lockName?: boolean;
    /** 这家已经有的账号名：新名字撞上就是「两个 main」，写下去一个会盖掉另一个 */
    taken?: readonly string[];
    busy: boolean;
    onDone?: () => void;
    onRun: (action: () => Promise<ModelConfigSnapshot>) => Promise<boolean>;
}) {
    const form = useForm({
        defaultValues: { name: defaultName, value: '' },
        onSubmit: ({ value }) => {
            // 进到这里 = 两根输入都过了校验：只管写，写失败的话由 `run` 抛到页头
            void onRun(async () => {
                // `saveAccount` 回的是 `{ config, saved }`：写面统一用整页快照，key 只回长度
                const next = await modelConfig.saveAccount({
                    providerId,
                    name: value.name.trim(),
                    value: value.value.trim(),
                    ...(kind === undefined ? {} : { kind }),
                });
                return next.config;
            }).then((ok) => {
                if (!ok) return;
                // 密钥送出去就不再回来：本地立刻清空（名字留着 —— 换钥的人还要看它）
                form.setFieldValue('value', '');
                onDone?.();
            });
        },
    });

    return (
        <form
            className="mt-2 flex flex-wrap items-start gap-2"
            onSubmit={(event) => {
                event.preventDefault();
                event.stopPropagation();
                void form.handleSubmit();
            }}
        >
            {lockName ? null : (
                <form.Field
                    name="name"
                    validators={{
                        onChange: ({ value }) => validAccountName(value, taken),
                        onSubmit: ({ value }) => validAccountName(value, taken),
                    }}
                >
                    {(field) => (
                        <Field
                            label="账号名"
                            value={field.state.value}
                            onChange={field.handleChange}
                            onBlur={field.handleBlur}
                            error={errorOf(field.state.meta.errors)}
                            placeholder="main"
                            className="w-32 shrink-0"
                        />
                    )}
                </form.Field>
            )}
            <form.Field
                name="value"
                validators={{
                    onChange: ({ value }) => validSecret(value),
                    onSubmit: ({ value }) => validSecret(value),
                }}
            >
                {(field) => (
                    <Field
                        label="key（只写不回显）"
                        value={field.state.value}
                        onChange={field.handleChange}
                        onBlur={field.handleBlur}
                        error={errorOf(field.state.meta.errors)}
                        placeholder="粘贴密钥"
                        type="password"
                        // 浏览器会把它当登录密码栏：不关掉会弹「保存密码」/自动填上一次的密码
                        autoComplete="new-password"
                        mono
                        className="min-w-0 flex-1"
                    />
                )}
            </form.Field>
            <button
                type="submit"
                disabled={busy}
                className="mt-[18px] rounded-md border border-ring bg-muted px-2.5 py-1 text-xs font-semibold hover:bg-muted/70 disabled:opacity-50"
            >
                保存
            </button>
        </form>
    );
}

// ── 模型表 ────────────────────────────────────────────────────────────────────

function Models({
    provider,
    busy,
    onRun,
}: {
    provider: ModelConfigProvider;
    busy: boolean;
    onRun: (action: () => Promise<ModelConfigSnapshot>) => Promise<boolean>;
}) {
    const [query, setQuery] = React.useState('');
    const [adding, setAdding] = React.useState(false);
    const keyword = query.trim().toLowerCase();
    const rows = provider.models.filter(
        (model) =>
            keyword === '' ||
            model.id.toLowerCase().includes(keyword) ||
            model.name.toLowerCase().includes(keyword),
    );
    const enabled = provider.models.filter((model) => model.enabled).length;

    /** 勾选 / 取消一个模型 = 重写 exclude 列表（`include` 一律清空：白名单与黑名单不混着用） */
    const toggle = (modelId: string): void => {
        const nextEnabled = new Set(provider.models.filter((model) => model.enabled).map((model) => model.id));
        if (nextEnabled.has(modelId)) nextEnabled.delete(modelId);
        else nextEnabled.add(modelId);
        const excluded = provider.models.filter((model) => !nextEnabled.has(model.id)).map((model) => model.id);
        void onRun(() =>
            modelConfig.saveProvider({
                providerId: provider.id,
                ...(provider.configured ? {} : { kind: provider.kind }),
                filter: { include: null, exclude: excluded.length === 0 ? null : excluded },
            }),
        );
    };

    return (
        <div className="space-y-2">
            <div className="flex flex-wrap items-center gap-2">
                <input
                    value={query}
                    onChange={(event) => setQuery(event.target.value)}
                    placeholder="筛选模型"
                    className="min-w-0 flex-1 rounded border border-border bg-card px-2 py-1 text-xs outline-none"
                />
                <span className="text-[11px] tabular-nums text-muted-foreground">
                    {enabled} / {provider.models.length}
                </span>
                {enabled < provider.models.length ? (
                    <button
                        disabled={busy}
                        onClick={() =>
                            void onRun(() =>
                                modelConfig.saveProvider({
                                    providerId: provider.id,
                                    ...(provider.configured ? {} : { kind: provider.kind }),
                                    filter: { include: null, exclude: null },
                                }),
                            )
                        }
                        className="rounded border border-border px-1.5 py-0.5 text-[11px] hover:bg-muted disabled:opacity-50"
                    >
                        全部启用
                    </button>
                ) : null}
                {provider.kind === 'custom' ? (
                    <button
                        onClick={() => setAdding((value) => !value)}
                        className="rounded border border-dashed border-border px-1.5 py-0.5 text-[11px] text-muted-foreground hover:border-ring hover:text-foreground"
                    >
                        ＋ 添加模型
                    </button>
                ) : null}
            </div>

            {adding && provider.kind === 'custom' ? (
                <AddModelForm
                    providerId={provider.id}
                    existing={provider.models.map((model) => model.id)}
                    busy={busy}
                    onDone={() => setAdding(false)}
                    onRun={onRun}
                />
            ) : null}

            {rows.length === 0 ? (
                <p className="py-2 text-xs text-muted-foreground">
                    {provider.models.length === 0
                        ? '这家还没有模型 —— 自定义服务商要自己加模型（id / 名字 / 上下文 / 价目）。'
                        : '没有匹配的模型'}
                </p>
            ) : (
                <div className="max-h-[46vh] overflow-auto rounded-lg border border-border">
                    <table className="w-full text-left text-xs">
                        <thead className="sticky top-0 bg-muted/80 text-[11px] text-muted-foreground backdrop-blur">
                            <tr>
                                <th className="w-8 py-1.5 pl-2" />
                                <th className="py-1.5">模型</th>
                                <th className="w-16 py-1.5 text-right">上下文</th>
                                <th className="w-28 py-1.5 pr-2 text-right">价目 (in/out)</th>
                            </tr>
                        </thead>
                        <tbody>
                            {rows.map((model) => (
                                <tr key={model.id} className="border-t border-border/60 hover:bg-muted/40">
                                    <td className="py-1 pl-2">
                                        <input
                                            type="checkbox"
                                            checked={model.enabled}
                                            disabled={busy}
                                            onChange={() => toggle(model.id)}
                                            className="size-3 accent-current"
                                        />
                                    </td>
                                    <td className="py-1 pr-2">
                                        <div className="truncate font-medium">{model.name}</div>
                                        <code className="text-[10.5px] text-muted-foreground">{model.id}</code>
                                    </td>
                                    <td className="py-1 text-right tabular-nums text-muted-foreground">
                                        {contextLabel(model.contextWindow)}
                                    </td>
                                    <td className="py-1 pr-2 text-right tabular-nums text-muted-foreground">
                                        {costLabel(model.cost)}
                                    </td>
                                </tr>
                            ))}
                        </tbody>
                    </table>
                </div>
            )}
        </div>
    );
}

function AddModelForm({
    providerId,
    existing,
    busy,
    onDone,
    onRun,
}: {
    providerId: string;
    /** 这家已经有的模型 id：撞了就是覆盖——得先告诉人，而不是默默改写一个现有模型 */
    existing: readonly string[];
    busy: boolean;
    onDone: () => void;
    onRun: (action: () => Promise<ModelConfigSnapshot>) => Promise<boolean>;
}) {
    const form = useForm({
        defaultValues: { id: '', name: '', context: '', input: '', output: '' },
        onSubmit: ({ value }) => {
            const modelId = value.id.trim();
            const contextWindow = value.context.trim() === '' ? undefined : Number(value.context);
            const costInput = value.input.trim() === '' ? undefined : Number(value.input);
            const costOutput = value.output.trim() === '' ? undefined : Number(value.output);
            void onRun(() =>
                modelConfig.saveProvider({
                    providerId,
                    models: {
                        [modelId]: {
                            ...(value.name.trim() === '' ? {} : { name: value.name.trim() }),
                            ...(contextWindow === undefined ? {} : { contextWindow }),
                            ...(costInput === undefined || costOutput === undefined
                                ? {}
                                : { cost: { input: costInput, output: costOutput } }),
                        },
                    },
                }),
                // 失败就留住输入（重打一遍 id 没意义）；成功才收工
            ).then((ok) => {
                if (!ok) return;
                form.reset();
                onDone();
            });
        },
    });

    /** 两项价格是「只能配对」：只填一半的话库里那个模型的价格就是假的 */
    const pairError = (inputText: string, outputText: string): string | undefined =>
        (inputText.trim() === '') !== (outputText.trim() === '')
            ? 'input / output 要一起填（或都留空）'
            : undefined;

    return (
        <form
            className="grid grid-cols-2 gap-2 rounded-lg border border-dashed border-border p-2"
            onSubmit={(event) => {
                event.preventDefault();
                event.stopPropagation();
                void form.handleSubmit();
            }}
        >
            <form.Field
                name="id"
                validators={{
                    onChange: ({ value }) => validModelId(value, existing),
                    onSubmit: ({ value }) => validModelId(value, existing),
                }}
            >
                {(field) => (
                    <Field
                        label="模型 id"
                        value={field.state.value}
                        onChange={field.handleChange}
                        onBlur={field.handleBlur}
                        error={errorOf(field.state.meta.errors)}
                        placeholder="gpt-6-astra"
                        mono
                    />
                )}
            </form.Field>
            <form.Field name="name">
                {(field) => (
                    <Field
                        label="显示名"
                        value={field.state.value}
                        onChange={field.handleChange}
                        onBlur={field.handleBlur}
                        placeholder="GPT-6 Astra"
                    />
                )}
            </form.Field>
            <form.Field
                name="context"
                validators={{
                    onChange: ({ value }) =>
                        validOptionalNumber(value, '上下文', { integer: true, min: 1 }),
                    onSubmit: ({ value }) =>
                        validOptionalNumber(value, '上下文', { integer: true, min: 1 }),
                }}
            >
                {(field) => (
                    <Field
                        label="上下文 tokens"
                        value={field.state.value}
                        onChange={field.handleChange}
                        onBlur={field.handleBlur}
                        error={errorOf(field.state.meta.errors)}
                        placeholder="1050000"
                    />
                )}
            </form.Field>
            <div className="grid grid-cols-2 gap-2">
                <form.Field
                    name="input"
                    validators={{
                        onChange: ({ value, fieldApi }) =>
                            validOptionalNumber(value, 'input 价格', { min: 0 }) ??
                            pairError(value, String(fieldApi.form.getFieldValue('output') ?? '')),
                        onSubmit: ({ value, fieldApi }) =>
                            validOptionalNumber(value, 'input 价格', { min: 0 }) ??
                            pairError(value, String(fieldApi.form.getFieldValue('output') ?? '')),
                    }}
                >
                    {(field) => (
                        <Field
                            label="input ($/1M)"
                            value={field.state.value}
                            onChange={field.handleChange}
                            onBlur={field.handleBlur}
                            error={errorOf(field.state.meta.errors)}
                            placeholder="10"
                        />
                    )}
                </form.Field>
                <form.Field
                    name="output"
                    validators={{
                        onChange: ({ value, fieldApi }) =>
                            validOptionalNumber(value, 'output 价格', { min: 0 }) ??
                            pairError(String(fieldApi.form.getFieldValue('input') ?? ''), value),
                        onSubmit: ({ value, fieldApi }) =>
                            validOptionalNumber(value, 'output 价格', { min: 0 }) ??
                            pairError(String(fieldApi.form.getFieldValue('input') ?? ''), value),
                    }}
                >
                    {(field) => (
                        <Field
                            label="output ($/1M)"
                            value={field.state.value}
                            onChange={field.handleChange}
                            onBlur={field.handleBlur}
                            error={errorOf(field.state.meta.errors)}
                            placeholder="50"
                        />
                    )}
                </form.Field>
            </div>
            <div className="col-span-2 flex justify-end gap-2">
                <button type="button" onClick={onDone} className="rounded border border-border px-2 py-1 text-[11px]">
                    取消
                </button>
                <button
                    type="submit"
                    disabled={busy}
                    className="rounded-md border border-ring bg-muted px-2.5 py-1 text-[11px] font-semibold disabled:opacity-50"
                >
                    添加
                </button>
            </div>
        </form>
    );
}

/**
 * 一根输入 + 它的错误行。
 *
 * 为什么不直接把 `<input>` 铺在表单里：错误必须出现在**这一根**下面。
 * 全挤到页头会变成「上面说错了，但你得自己找是哪根」——而这一页光凭据段就可能有三根输入。
 */
function Field({
    label,
    value,
    onChange,
    onBlur,
    error,
    placeholder,
    mono = false,
    type = 'text',
    autoComplete,
    className = '',
}: {
    label: string;
    value: string;
    onChange: (next: string) => void;
    onBlur?: () => void;
    /** 校验没过时的那句话（`undefined` = 没问题，边框回到常态） */
    error?: string | undefined;
    placeholder?: string;
    mono?: boolean;
    type?: 'text' | 'password';
    autoComplete?: string;
    className?: string;
}) {
    return (
        <label className={`block text-[11px] ${className}`}>
            <span className="mb-0.5 block text-muted-foreground">{label}</span>
            <input
                value={value}
                onChange={(event) => onChange(event.target.value)}
                onBlur={onBlur}
                type={type}
                autoComplete={autoComplete}
                aria-invalid={error !== undefined}
                placeholder={placeholder}
                className={`w-full rounded border bg-background px-1.5 py-1 text-xs outline-none ${
                    error === undefined ? 'border-border' : 'border-red-500/60'
                } ${mono ? 'font-mono' : ''}`}
            />
            {error === undefined ? null : (
                <span className="mt-0.5 block text-[11px] leading-relaxed text-red-300">{error}</span>
            )}
        </label>
    );
}

// ── 接口（api / npm）─────────────────────────────────────────────────────────

/**
 * spec 段。`std` provider 的 api / npm 来自目录快照（**不可改**：改了下次快照更新就打架），
 * `custom` 的才在 `providers.custom.yaml` 里，可以就地编辑。
 */
function SpecForm({
    provider,
    busy,
    onRun,
}: {
    provider: ModelConfigProvider;
    busy: boolean;
    onRun: (action: () => Promise<ModelConfigSnapshot>) => Promise<boolean>;
}) {
    const form = useForm({
        defaultValues: { api: provider.api ?? '', npm: provider.npm ?? '' },
        onSubmit: ({ value }) => {
            void onRun(() =>
                modelConfig.saveProvider({
                    providerId: provider.id,
                    kind: 'custom',
                    spec: {
                        api: value.api.trim(),
                        ...(value.npm.trim() === '' ? {} : { npm: value.npm.trim() }),
                    },
                }),
            );
        },
    });

    if (provider.kind === 'std') {
        return (
            <div className="grid grid-cols-[64px_1fr] items-baseline gap-x-3 gap-y-1 text-[11px]">
                <span className="text-muted-foreground">api</span>
                <code className="break-all text-foreground">
                    {provider.api ?? '（目录没给 · 走 SDK 内置 endpoint，diy2 现在发不出去）'}
                </code>
                <span className="text-muted-foreground">npm</span>
                <code className="break-all text-foreground">{provider.npm ?? '—'}</code>
                <span className="text-muted-foreground">环境变量</span>
                <code className="break-all text-foreground">{provider.envKeys.join(' · ') || '—'}</code>
                {provider.doc === undefined ? null : (
                    <>
                        <span className="text-muted-foreground">文档</span>
                        <a href={provider.doc} target="_blank" rel="noreferrer" className="break-all underline">
                            {provider.doc}
                        </a>
                    </>
                )}
            </div>
        );
    }

    return (
        <form
            className="flex flex-wrap items-start gap-2"
            onSubmit={(event) => {
                event.preventDefault();
                event.stopPropagation();
                void form.handleSubmit();
            }}
        >
            <form.Field
                name="api"
                validators={{
                    onChange: ({ value }) => validBaseUrl(value),
                    onSubmit: ({ value }) => validBaseUrl(value),
                }}
            >
                {(field) => (
                    <Field
                        label="api 基址"
                        value={field.state.value}
                        onChange={field.handleChange}
                        onBlur={field.handleBlur}
                        error={errorOf(field.state.meta.errors)}
                        placeholder="https://api.example.com/v1"
                        mono
                        className="min-w-0 flex-[2]"
                    />
                )}
            </form.Field>
            <form.Field
                name="npm"
                validators={{
                    onChange: ({ value }) => validNpm(value),
                    onSubmit: ({ value }) => validNpm(value),
                }}
            >
                {(field) => (
                    <Field
                        label="npm（ai-sdk 包）"
                        value={field.state.value}
                        onChange={field.handleChange}
                        onBlur={field.handleBlur}
                        error={errorOf(field.state.meta.errors)}
                        placeholder="@ai-sdk/openai-compatible"
                        mono
                        className="min-w-0 flex-1"
                    />
                )}
            </form.Field>
            <button
                type="submit"
                disabled={busy}
                className="mt-[18px] rounded-md border border-ring bg-muted px-2.5 py-1 text-xs font-semibold disabled:opacity-50"
            >
                保存
            </button>
        </form>
    );
}

// ── 添加自定义服务商 ──────────────────────────────────────────────────────────

function AddCustomProvider({
    known,
    busy,
    onRun,
    onAdded,
}: {
    /** 已经在目录 / 配置里的 id：再新建一家同名的不算新建，只会跟它的设置打架 */
    known: readonly string[];
    busy: boolean;
    onRun: (action: () => Promise<ModelConfigSnapshot>) => Promise<boolean>;
    /** 加完就选中它 —— 否则新那家混进「全部服务商」的几百行里，人得自己找回来 */
    onAdded: (providerId: string) => void;
}) {
    const [open, setOpen] = React.useState(false);
    const form = useForm({
        defaultValues: { id: '', api: '', npm: '@ai-sdk/openai-compatible' },
        onSubmit: ({ value }) => {
            const providerId = value.id.trim();
            void onRun(() =>
                modelConfig.saveProvider({
                    providerId,
                    kind: 'custom',
                    spec: {
                        api: value.api.trim(),
                        ...(value.npm.trim() === '' ? {} : { npm: value.npm.trim() }),
                    },
                }),
            ).then((ok) => {
                // 失败时保留输入（服务端那句错已经在页头，重打一遍 id 没意义）
                if (!ok) return;
                form.reset();
                setOpen(false);
                onAdded(providerId);
            });
        },
    });

    if (!open) {
        return (
            <div className="border-t border-border p-2">
                <button
                    onClick={() => setOpen(true)}
                    className="w-full rounded-md border border-dashed border-border py-1.5 text-[11px] text-muted-foreground hover:border-ring hover:text-foreground"
                >
                    ＋ 添加自定义服务商
                </button>
            </div>
        );
    }

    return (
        <form
            className="space-y-1.5 border-t border-border p-2"
            onSubmit={(event) => {
                event.preventDefault();
                event.stopPropagation();
                void form.handleSubmit();
            }}
        >
            <p className="text-[11px] leading-relaxed text-muted-foreground">
                目录里没有的那家（自建 / 局域网网关）。规格写进{' '}
                <code className="text-foreground">providers.custom.yaml</code>，模型要自己加。
            </p>
            <form.Field
                name="id"
                validators={{
                    onChange: ({ value }) => validProviderId(value, known),
                    onSubmit: ({ value }) => validProviderId(value, known),
                }}
            >
                {(field) => (
                    <Field
                        label="id"
                        value={field.state.value}
                        onChange={field.handleChange}
                        onBlur={field.handleBlur}
                        error={errorOf(field.state.meta.errors)}
                        placeholder="my-gateway"
                        mono
                    />
                )}
            </form.Field>
            <form.Field
                name="api"
                validators={{
                    onChange: ({ value }) => validBaseUrl(value),
                    onSubmit: ({ value }) => validBaseUrl(value),
                }}
            >
                {(field) => (
                    <Field
                        label="api 基址"
                        value={field.state.value}
                        onChange={field.handleChange}
                        onBlur={field.handleBlur}
                        error={errorOf(field.state.meta.errors)}
                        placeholder="https://…/v1"
                        mono
                    />
                )}
            </form.Field>
            <form.Field
                name="npm"
                validators={{
                    onChange: ({ value }) => validNpm(value),
                    onSubmit: ({ value }) => validNpm(value),
                }}
            >
                {(field) => (
                    <Field
                        label="npm"
                        value={field.state.value}
                        onChange={field.handleChange}
                        onBlur={field.handleBlur}
                        error={errorOf(field.state.meta.errors)}
                        placeholder="@ai-sdk/openai-compatible"
                        mono
                    />
                )}
            </form.Field>
            <div className="flex justify-end gap-2 pt-0.5">
                <button type="button" onClick={() => setOpen(false)} className="rounded border border-border px-2 py-1 text-[11px]">
                    取消
                </button>
                <button
                    type="submit"
                    disabled={busy}
                    className="rounded-md border border-ring bg-muted px-2.5 py-1 text-[11px] font-semibold disabled:opacity-50"
                >
                    添加
                </button>
            </div>
        </form>
    );
}

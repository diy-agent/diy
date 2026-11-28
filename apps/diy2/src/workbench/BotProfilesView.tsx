// BotProfilesView.tsx —— 「机器人」页（工作台设置页的第二段，地址 `/settings/botProfiles`）。
//
// 机器人是**预制角色**（2026-11-26 用户裁）：每类房间（项目 / 任务）固定一批席位，
// 由 seed 建好。这里不新建、不删除、不改名 —— 只能改人格 / 模型 / 推理强度并保存。
// 所以左栏只列项目 / 任务两类的预制机器人，没有「＋ 新建」；右栏没有删除 / 改名。
//
// 三条硬约束（与模型配置页同一套，别在这一页另发明一种手感）：
//   · 校验在这一根输入下面说 —— TanStack Form 的字段级 validator（人格超长）
//   · 写完即刷新 —— `botProfiles.update` 会让 store 重拉配置表，房间头成员胶囊立刻跟上
//   · 失败要看见 —— 服务端的话原样带到右栏顶部（「只剩这一个角色」这类话只有它知道）

import {
    EffortButtons,
    ModelSelectButton,
    modelOfKey,
    botProfiles,
    useBotProfileDefaults,
    useBotProfiles,
    useEffortOptions,
    useProviders,
    type BotProfile,
} from '@diy-agent/entity-chat';
import { useForm } from '@tanstack/react-form';
import * as React from 'react';
import { DefaultModelCard } from './DefaultModelCard';

/** 服务端的话原样带出来（「只剩这一个角色」比「保存失败」有用得多） */
function messageOf(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

/** 类型的显示名。预制角色只有 project / task，其余原样显示（老数据兼容） */
const TYPE_LABEL: Record<string, string> = { project: '项目', task: '任务' };

function typeLabel(type: string): string {
    return TYPE_LABEL[type] ?? type;
}

/** 从 TanStack Form 的 `meta.errors` 里拿第一条能显示的话 */
function errorOf(errors: readonly unknown[]): string | undefined {
    for (const item of errors) {
        if (typeof item === 'string' && item !== '') return item;
    }
    return undefined;
}

// ── 机器人编辑器（右栏）────────────────────────────────────────────────────────

function BotProfileEditor({ profile }: { profile: BotProfile }) {
    const role = profile;
    const [error, setError] = React.useState<string>();
    const [busy, setBusy] = React.useState(false);
    const [saved, setSaved] = React.useState(false);

    // 当前模型决定 effort 候选（来自 models.dev 的 reasoning_options）
    const [currentModelKey, setCurrentModelKey] = React.useState(role.modelKey ?? '');
    const { efforts } = useEffortOptions(currentModelKey);
    const providers = useProviders();

    const form = useForm({
        defaultValues: {
            instructions: role.instructions,
            modelKey: role.modelKey ?? '',
            reasoningEffort: role.reasoningEffort ?? '',
        },
        onSubmit: async ({ value }) => {
            setBusy(true);
            setError(undefined);
            setSaved(false);
            try {
                await botProfiles.update({
                    id: role.id,
                    // 空串 = 清空 → 继续继承（服务端把 '' 与 null 当同一件事）
                    modelKey: value.modelKey === '' ? null : value.modelKey,
                    reasoningEffort: value.reasoningEffort === '' ? null : value.reasoningEffort,
                    instructions: value.instructions,
                });
                setSaved(true);
            } catch (cause) {
                setError(messageOf(cause));
            } finally {
                setBusy(false);
            }
        },
    });

    return (
        <div className="flex h-full min-h-0 flex-col">
            <header className="flex items-center gap-2 border-b border-border px-4 py-2.5">
                <span className="text-sm font-semibold">{role.name}</span>
                <span className="rounded border px-1.5 py-0.5 text-[10px] text-muted-foreground">
                    {typeLabel(role.type)}机器人
                </span>
                <span className="ml-auto flex items-center gap-2 text-xs">
                    {saved ? <span className="text-muted-foreground">已保存</span> : null}
                    <button
                        type="button"
                        onClick={() => void form.handleSubmit()}
                        disabled={busy}
                        className="rounded-lg bg-primary px-3 py-1 text-primary-foreground disabled:opacity-40"
                    >
                        保存
                    </button>
                </span>
            </header>

            {error === undefined ? null : (
                <div className="border-b border-destructive/40 bg-destructive/10 px-4 py-2 text-xs text-destructive">
                    {error}
                </div>
            )}

            <form
                className="min-h-0 flex-1 space-y-1 overflow-y-auto p-4"
                onSubmit={(event) => {
                    event.preventDefault();
                    void form.handleSubmit();
                }}
            >
                <form.Field
                    name="instructions"
                    validators={{
                        onChange: ({ value }) =>
                            value.length > 8000 ? `人格段太长了（${String(value.length)} 字，最多 8000）` : undefined,
                    }}
                >
                    {(field) => {
                        const problem = errorOf(field.state.meta.errors);
                        return (
                            <section className="border-b border-border/60 py-3 first:pt-0">
                                <div className="mb-1 text-xs text-muted-foreground">人格段（拼进系统提示词）</div>
                                <textarea
                                    value={field.state.value}
                                    onChange={(event) => {
                                        field.handleChange(event.target.value);
                                        setSaved(false);
                                    }}
                                    onBlur={field.handleBlur}
                                    rows={5}
                                    placeholder="例如：工程视角：先结论后理由，改动要给影响面与回滚。"
                                    className={`w-full resize-y rounded-lg border bg-card px-2 py-1.5 text-sm outline-none ${
                                        problem === undefined ? '' : 'border-destructive'
                                    }`}
                                />
                                {problem === undefined ? null : (
                                    <span className="mt-1 block text-[11px] text-destructive">{problem}</span>
                                )}
                            </section>
                        );
                    }}
                </form.Field>

                <form.Field name="modelKey">
                    {(field) => (
                        <section className="border-b border-border/60 py-3">
                            <div className="mb-1.5 flex items-center justify-between text-xs text-muted-foreground">
                                <span>模型</span>
                                {field.state.value === '' ? null : (
                                    <button
                                        type="button"
                                        onClick={() => {
                                            field.handleChange('');
                                            setSaved(false);
                                        }}
                                        className="rounded border px-1.5 py-0.5 text-[11px] hover:bg-muted"
                                    >
                                        改回跟随
                                    </button>
                                )}
                            </div>
                            <ModelSelectButton
                                value={field.state.value}
                                onPick={(key) => {
                                    field.handleChange(key);
                                    setCurrentModelKey(key);
                                    // 换模型 = 默认取该模型第一档 effort（models.dev），没有就清空
                                    form.setFieldValue(
                                        'reasoningEffort',
                                        modelOfKey(providers, key)?.reasoning?.defaultEffort ?? '',
                                    );
                                    setSaved(false);
                                }}
                            />
                        </section>
                    )}
                </form.Field>

                <form.Field name="reasoningEffort">
                    {(field) => (
                        <section className="py-3">
                            <div className="mb-1.5 text-xs text-muted-foreground">推理强度</div>
                            <EffortButtons
                                value={field.state.value}
                                efforts={efforts}
                                busy={busy}
                                onChange={(value) => {
                                    field.handleChange(value);
                                    setSaved(false);
                                }}
                            />
                            <p className="mt-1.5 text-[10px] text-muted-foreground">
                                档位来自当前模型的推理规格；「缺省」= 不指定，交给模型/服务商。
                            </p>
                        </section>
                    )}
                </form.Field>
            </form>
        </div>
    );
}

// ── 类型默认编辑器（右栏，role_config）──────────────────────────────────────
//
// 与 BotProfileEditor 一个手感，但写的是**类型默认**（`bot_profile_defaults`）：project / task 各一套。
// 几百个任务 bot 共享这套，个别机器人配置才在 BotProfileEditor 里 override。

function TypeDefaultsEditor({ type }: { type: string }) {
    const configs = useBotProfileDefaults();
    const config = configs.find((entry) => entry.type === type);
    const [error, setError] = React.useState<string>();
    const [busy, setBusy] = React.useState(false);
    const [saved, setSaved] = React.useState(false);
    const [currentModelKey, setCurrentModelKey] = React.useState(config?.modelKey ?? '');
    const { efforts } = useEffortOptions(currentModelKey);
    const providers = useProviders();

    const form = useForm({
        defaultValues: {
            modelKey: config?.modelKey ?? '',
            reasoningEffort: config?.reasoningEffort ?? '',
        },
        onSubmit: async ({ value }) => {
            setBusy(true);
            setError(undefined);
            setSaved(false);
            try {
                await botProfiles.defaults({
                    type,
                    // 空串 = 清空 → 该类 bot 继续继承房间 → 全局默认
                    modelKey: value.modelKey === '' ? null : value.modelKey,
                    reasoningEffort: value.reasoningEffort === '' ? null : value.reasoningEffort,
                });
                setSaved(true);
            } catch (cause) {
                setError(messageOf(cause));
            } finally {
                setBusy(false);
            }
        },
    });

    return (
        <div className="flex h-full min-h-0 flex-col">
            <header className="flex items-center gap-2 border-b border-border px-4 py-2.5">
                <span className="text-sm font-semibold">{typeLabel(type)}机器人 · 默认设置</span>
                <span className="rounded border px-1.5 py-0.5 text-[10px] text-muted-foreground">
                    所有这类机器人都用这套（个别可在左边单独改）
                </span>
                <span className="ml-auto flex items-center gap-2 text-xs">
                    {saved ? <span className="text-muted-foreground">已保存</span> : null}
                    <button
                        type="button"
                        onClick={() => void form.handleSubmit()}
                        disabled={busy}
                        className="rounded-lg bg-primary px-3 py-1 text-primary-foreground disabled:opacity-40"
                    >
                        保存
                    </button>
                </span>
            </header>

            {error === undefined ? null : (
                <div className="border-b border-destructive/40 bg-destructive/10 px-4 py-2 text-xs text-destructive">
                    {error}
                </div>
            )}

            <form
                className="min-h-0 flex-1 space-y-1 overflow-y-auto p-4"
                onSubmit={(event) => {
                    event.preventDefault();
                    void form.handleSubmit();
                }}
            >
                <form.Field name="modelKey">
                    {(field) => (
                        <section className="border-b border-border/60 py-3 first:pt-0">
                            <div className="mb-1.5 flex items-center justify-between text-xs text-muted-foreground">
                                <span>默认模型（所有这类机器人）</span>
                                {field.state.value === '' ? null : (
                                    <button
                                        type="button"
                                        onClick={() => {
                                            field.handleChange('');
                                            setSaved(false);
                                        }}
                                        className="rounded border px-1.5 py-0.5 text-[11px] hover:bg-muted"
                                    >
                                        清空（跟随房间/全局）
                                    </button>
                                )}
                            </div>
                            <ModelSelectButton
                                value={field.state.value}
                                onPick={(key) => {
                                    field.handleChange(key);
                                    setCurrentModelKey(key);
                                    form.setFieldValue(
                                        'reasoningEffort',
                                        modelOfKey(providers, key)?.reasoning?.defaultEffort ?? '',
                                    );
                                    setSaved(false);
                                }}
                            />
                        </section>
                    )}
                </form.Field>

                <form.Field name="reasoningEffort">
                    {(field) => (
                        <section className="py-3">
                            <div className="mb-1.5 text-xs text-muted-foreground">默认推理强度</div>
                            <EffortButtons
                                value={field.state.value}
                                efforts={efforts}
                                busy={busy}
                                onChange={(value) => {
                                    field.handleChange(value);
                                    setSaved(false);
                                }}
                            />
                            <p className="mt-1.5 text-[10px] text-muted-foreground">
                                档位来自当前模型的推理规格；「缺省」= 不指定，交给模型/服务商。
                            </p>
                        </section>
                    )}
                </form.Field>
            </form>
        </div>
    );
}

// ── 页面 ─────────────────────────────────────────────────────────────────────

export function BotProfilesView({ initialType }: { initialType?: string | undefined } = {}) {
    const all = useBotProfiles();
    const [selected, setSelected] = React.useState('');
    // 选中的「类型默认」；与 selected（角色）互斥 —— 同时选中两个会让右栏不知道该显示谁
    const [selectedType, setSelectedType] = React.useState<string>();

    // 只显示预制类型（project / task）。老数据里若有别的类型也照列，但不提供新建。
    const types: string[] = [];
    for (const role of all) if (!types.includes(role.type)) types.push(role.type);
    // 选中顺序：用户点过的角色 → 深链类型的第一个 → 整表第一个
    const current =
        all.find((role) => role.id === selected) ??
        all.find((role) => initialType !== undefined && role.type === initialType) ??
        all[0];
    const showTypeConfig = selectedType !== undefined;

    return (
        <div className="grid h-full min-h-0 grid-cols-[minmax(232px,288px)_1fr] bg-background text-foreground">
            <aside className="flex min-h-0 flex-col border-r border-border">
                <div className="border-b border-border p-3">
                    <span className="text-sm font-medium">机器人</span>
                </div>

                {/* 默认模型（2026-11-28 从模型配置页搬来）：管的是「新建时继承哪个」 */}
                <div className="border-b border-border p-2">
                    <DefaultModelCard />
                </div>

                <div className="min-h-0 flex-1 overflow-y-auto p-2">
                    {types.length === 0 ? (
                        <p className="p-2 text-xs text-muted-foreground">还没有机器人。</p>
                    ) : (
                        types.map((type) => (
                            <section key={type} className="mb-3">
                                <div className="px-2 py-1 text-[11px] font-medium text-muted-foreground">
                                    {typeLabel(type)}
                                    <span className="ml-1 opacity-60">
                                        {all.filter((role) => role.type === type).length} 个
                                    </span>
                                </div>
                                <button
                                    type="button"
                                    onClick={() => {
                                        setSelectedType(type);
                                        setSelected('');
                                    }}
                                    className={`flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left text-sm ${
                                        showTypeConfig && selectedType === type ? 'bg-muted' : 'hover:bg-muted/60'
                                    }`}
                                >
                                    <span className="truncate">默认设置</span>
                                    <span className="ml-auto text-[10px] text-muted-foreground">共享</span>
                                </button>
                                {all
                                    .filter((role) => role.type === type)
                                    .map((role) => (
                                        <button
                                            key={role.id}
                                            type="button"
                                            onClick={() => {
                                                setSelected(role.id);
                                                setSelectedType(undefined);
                                            }}
                                            className={`flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left text-sm ${
                                                !showTypeConfig && current?.id === role.id
                                                    ? 'bg-muted'
                                                    : 'hover:bg-muted/60'
                                            }`}
                                        >
                                            <span className="truncate">{role.name}</span>
                                        </button>
                                    ))}
                            </section>
                        ))
                    )}
                </div>
            </aside>

            {showTypeConfig && selectedType !== undefined ? (
                <TypeDefaultsEditor key={selectedType} type={selectedType} />
            ) : current === undefined ? (
                <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
                    左边还没有机器人
                </div>
            ) : (
                // key = 角色 id：切换角色 = 换一份表单初始值（不然会把上一个角色的输入带过去）
                <BotProfileEditor key={current.id} profile={current} />
            )}
        </div>
    );
}

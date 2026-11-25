// RolesView.tsx —— 「机器人」页（工作台设置页的第二段，地址 `/settings/roles`）。
//
// 机器人是**预制角色**（2026-11-26 用户裁）：每类房间（项目 / 任务）固定一批席位，
// 由 seed 建好。这里不新建、不删除、不改名 —— 只能改人格 / 模型 / 推理强度并保存。
// 所以左栏只列项目 / 任务两类的预制机器人，没有「＋ 新建」；右栏没有删除 / 改名。
//
// 三条硬约束（与模型配置页同一套，别在这一页另发明一种手感）：
//   · 校验在这一根输入下面说 —— TanStack Form 的字段级 validator（人格超长）
//   · 写完即刷新 —— `roles.update` 会让 store 重拉角色表，房间头成员胶囊立刻跟上
//   · 失败要看见 —— 服务端的话原样带到右栏顶部（「只剩这一个角色」这类话只有它知道）

import { ModelSelectButton, roles, useRoles, type BotRole } from '@diy-agent/entity-chat';
import { useForm } from '@tanstack/react-form';
import * as React from 'react';

/** 服务端的话原样带出来（「只剩这一个角色」比「保存失败」有用得多） */
function messageOf(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

/** 类型的显示名。预制角色只有 project / task，其余原样显示（老数据兼容） */
const TYPE_LABEL: Record<string, string> = { project: '项目', task: '任务' };

function typeLabel(type: string): string {
    return TYPE_LABEL[type] ?? type;
}

/** 推理强度档位：空 = 跟随模型/服务商缺省。选项按钮组而非下拉，方便一眼看全、一点即改 */
const EFFORTS: ReadonlyArray<{ value: string; label: string }> = [
    { value: '', label: '跟随' },
    { value: 'minimal', label: 'minimal' },
    { value: 'low', label: 'low' },
    { value: 'medium', label: 'medium' },
    { value: 'high', label: 'high' },
];

/** 从 TanStack Form 的 `meta.errors` 里拿第一条能显示的话 */
function errorOf(errors: readonly unknown[]): string | undefined {
    for (const item of errors) {
        if (typeof item === 'string' && item !== '') return item;
    }
    return undefined;
}

// ── 机器人编辑器（右栏）────────────────────────────────────────────────────────

function RoleEditor({ role }: { role: BotRole }) {
    const [error, setError] = React.useState<string>();
    const [busy, setBusy] = React.useState(false);
    const [saved, setSaved] = React.useState(false);

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
                await roles.update({
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
                    {typeLabel(role.type)} · 预制机器人
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
                            <div className="flex flex-wrap gap-1.5">
                                {EFFORTS.map((item) => (
                                    <button
                                        key={item.value}
                                        type="button"
                                        aria-pressed={field.state.value === item.value}
                                        onClick={() => {
                                            field.handleChange(item.value);
                                            setSaved(false);
                                        }}
                                        className={`rounded-full border px-2.5 py-0.5 text-[11px] ${
                                            field.state.value === item.value
                                                ? 'border-ring bg-muted font-medium'
                                                : 'border-border text-muted-foreground hover:bg-muted/60'
                                        }`}
                                    >
                                        {item.label}
                                    </button>
                                ))}
                            </div>
                        </section>
                    )}
                </form.Field>
            </form>
        </div>
    );
}

// ── 页面 ─────────────────────────────────────────────────────────────────────

export function RolesView({ initialType }: { initialType?: string | undefined } = {}) {
    const all = useRoles();
    const [selected, setSelected] = React.useState('');

    // 只显示预制类型（project / task）。老数据里若有别的类型也照列，但不提供新建。
    const types: string[] = [];
    for (const role of all) if (!types.includes(role.type)) types.push(role.type);
    // 选中顺序：用户点过的 → 深链类型的第一个 → 整表第一个
    const current =
        all.find((role) => role.id === selected) ??
        all.find((role) => initialType !== undefined && role.type === initialType) ??
        all[0];

    return (
        <div className="grid h-full min-h-0 grid-cols-[minmax(232px,288px)_1fr] bg-background text-foreground">
            <aside className="flex min-h-0 flex-col border-r border-border">
                <div className="border-b border-border p-3">
                    <span className="text-sm font-medium">机器人</span>
                </div>

                <div className="min-h-0 flex-1 overflow-y-auto p-2">
                    {types.length === 0 ? (
                        <p className="p-2 text-xs text-muted-foreground">还没有预制机器人。</p>
                    ) : (
                        types.map((type) => (
                            <section key={type} className="mb-3">
                                <div className="px-2 py-1 text-[11px] font-medium text-muted-foreground">
                                    {typeLabel(type)}
                                    <span className="ml-1 opacity-60">
                                        {all.filter((role) => role.type === type).length} 个
                                    </span>
                                </div>
                                {all
                                    .filter((role) => role.type === type)
                                    .map((role) => (
                                        <button
                                            key={role.id}
                                            type="button"
                                            onClick={() => setSelected(role.id)}
                                            className={`flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left text-sm ${
                                                current?.id === role.id ? 'bg-muted' : 'hover:bg-muted/60'
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

            {current === undefined ? (
                <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
                    左边还没有机器人
                </div>
            ) : (
                // key = 角色 id：切换角色 = 换一份表单初始值（不然会把上一个角色的输入带过去）
                <RoleEditor key={current.id} role={current} />
            )}
        </div>
    );
}

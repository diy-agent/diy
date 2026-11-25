// RolesView.tsx —— 「角色」页（工作台设置页的第二段，地址 `/settings/roles`）。
//
// 这一页回答的是「谁在这类房间里说话」，不是「这间房里有哪些人」——
// 角色是**类型级**的固定席位（2026-11-24 裁，见 docs/plans/2026-11-24-bot-role.md）：
//   一个 project 角色 = 所有项目房间里的同一个席位；新建任务自动出现在任务房间里，
//   不存在「把这个 bot 拉进这间房」这个动作。
//
// 所以左栏按**类型**分组（项目 / 任务 / 任何自定义类型），右栏是选中那个角色的编辑面：
// 名字 / 颜色 / 人格 / 默认应答 / 模型 / 推理强度。
//
// 三条硬约束（与模型配置页同一套，别在这一页另发明一种手感）：
//   · 校验在**这一根**输入下面说 —— TanStack Form 的字段级 validator（重名 / 空白 / 超长）
//   · 写完即刷新 —— `roles.*` 每个方法都会让 store 重拉角色表，房间头的成员胶囊立刻跟上
//   · 失败要看见 —— 服务端的话原样带到右栏顶部（「只剩这一个角色」这类话只有它知道）
//
// 「哪些角色在哪个房间」不在这里算：成员是 `membersOfType(roles, room.type)` 派生出来的，
// 一个房间的成员名单 = 该类型的全部角色，所以这里没有「加入房间」按钮 —— 那不是漏了。

import { Modal, ModelPicker, roles, useRoles, type BotRole } from '@diy-agent/entity-chat';
import { useForm } from '@tanstack/react-form';
import * as React from 'react';

import { ROLES_TYPES } from './settings';

/** 服务端的话原样带出来（「只剩这一个角色」比「保存失败」有用得多） */
function messageOf(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

/** 类型的显示名。类型是开放字符串（`stock` 之类都可能出现），没登记的原样显示 */
const TYPE_LABEL: Record<string, string> = { project: '项目', task: '任务' };

function typeLabel(type: string): string {
    return TYPE_LABEL[type] ?? type;
}

/** 推理强度：空 = 用模型/服务商缺省（不是每个模型都支持，所以给「跟随」这一档） */
const EFFORTS: ReadonlyArray<{ value: string; label: string }> = [
    { value: '', label: '跟随模型缺省' },
    { value: 'minimal', label: 'minimal' },
    { value: 'low', label: 'low' },
    { value: 'medium', label: 'medium' },
    { value: 'high', label: 'high' },
];

/** 从 TanStack Form 的 `meta.errors` 里拿第一条能显示的话（错误项可能是字符串或对象） */
function errorOf(errors: readonly unknown[]): string | undefined {
    for (const item of errors) {
        if (typeof item === 'string' && item !== '') return item;
    }
    return undefined;
}

const NAME_MAX = 24;

/** 名字：这类房间里要能当 @ 名字用 —— 空白与超长会让补全选不中 */
function validName(name: string, taken: readonly string[]): string | undefined {
    const value = name.trim();
    if (value === '') return '填个名字（房间头与 @ 补全都用它）';
    if (/\s/.test(value)) return '不能有空格（@ 补全按整串匹配）';
    if (value.length > NAME_MAX) return `太长了（${String(value.length)} 字，最多 ${String(NAME_MAX)}）`;
    if (taken.includes(value)) return '这类房间里已经有同名角色';
    return undefined;
}

// ── 新建角色（弹窗）──────────────────────────────────────────────────────────

function CreateRoleDialog({
    onClose,
    onDone,
}: {
    onClose: () => void;
    onDone: (role: BotRole) => void;
}) {
    const all = useRoles();
    const [error, setError] = React.useState<string>();
    const [busy, setBusy] = React.useState(false);

    const form = useForm({
        defaultValues: { type: ROLES_TYPES[0] as string, name: '' },
        onSubmit: async ({ value }) => {
            const type = value.type.trim();
            const name = value.name.trim();
            const taken = all.filter((role) => role.type === type).map((role) => role.name);
            const problem = validName(name, taken);
            if (problem !== undefined) {
                setError(problem);
                return;
            }
            setBusy(true);
            setError(undefined);
            try {
                const role = await roles.create({ type, name });
                onDone(role);
            } catch (cause) {
                setError(messageOf(cause));
            } finally {
                setBusy(false);
            }
        },
    });

    return (
        <Modal title="新建角色" onClose={onClose}>
            <form
                className="space-y-3 text-sm"
                onSubmit={(event) => {
                    event.preventDefault();
                    void form.handleSubmit();
                }}
            >
                <form.Field
                    name="type"
                    validators={{
                        onChange: ({ value }) =>
                            (ROLES_TYPES as readonly string[]).includes(value) ? undefined : '只能选项目或任务',
                    }}
                >
                    {(field) => {
                        const error = errorOf(field.state.meta.errors);
                        return (
                            <label className="block">
                                <span className="mb-1 block text-xs text-muted-foreground">归属类型</span>
                                <select
                                    value={field.state.value}
                                    onChange={(event) => field.handleChange(event.target.value)}
                                    onBlur={field.handleBlur}
                                    className="w-full rounded-lg border bg-card px-2 py-1.5 outline-none"
                                >
                                    {ROLES_TYPES.map((type) => (
                                        <option key={type} value={type}>
                                            {typeLabel(type)}
                                        </option>
                                    ))}
                                </select>
                                {error === undefined ? null : (
                                    <span className="mt-1 block text-[11px] text-destructive">{error}</span>
                                )}
                            </label>
                        );
                    }}
                </form.Field>

                <form.Field
                    name="name"
                    validators={{
                        onChange: ({ value, fieldApi }) => {
                            // 依赖同表单的 type：拿它的当前值算「这类房间里有没有重名」
                            const type = fieldApi.form.state.values.type.trim();
                            const taken = all
                                .filter((role) => role.type === type)
                                .map((role) => role.name);
                            return validName(value, taken);
                        },
                    }}
                >
                    {(field) => {
                        const error = errorOf(field.state.meta.errors);
                        return (
                            <label className="block">
                                <span className="mb-1 block text-xs text-muted-foreground">名字</span>
                                <input
                                    value={field.state.value}
                                    onChange={(event) => field.handleChange(event.target.value)}
                                    onBlur={field.handleBlur}
                                    placeholder="例如 架构 / 产品"
                                    className={`w-full rounded-lg border bg-card px-2 py-1.5 outline-none ${
                                        error === undefined ? '' : 'border-destructive'
                                    }`}
                                />
                                {error === undefined ? null : (
                                    <span className="mt-1 block text-[11px] text-destructive">{error}</span>
                                )}
                            </label>
                        );
                    }}
                </form.Field>

                {error === undefined ? null : <p className="text-[11px] text-destructive">{error}</p>}
                <div className="flex justify-end gap-2 pt-1">
                    <button type="button" onClick={onClose} className="rounded-lg border px-3 py-1.5">
                        取消
                    </button>
                    <button
                        type="submit"
                        disabled={busy}
                        className="rounded-lg bg-primary px-3 py-1.5 text-primary-foreground disabled:opacity-40"
                    >
                        创建
                    </button>
                </div>
            </form>
        </Modal>
    );
}

// ── 角色编辑器（右栏）────────────────────────────────────────────────────────

function RoleEditor({ role, onDeleted }: { role: BotRole; onDeleted: () => void }) {
    const all = useRoles();
    const [error, setError] = React.useState<string>();
    const [busy, setBusy] = React.useState(false);
    const [confirming, setConfirming] = React.useState(false);
    const [saved, setSaved] = React.useState(false);

    const siblings = all.filter((entry) => entry.type === role.type && entry.id !== role.id);
    const lastOfType = all.filter((entry) => entry.type === role.type).length <= 1;

    const form = useForm({
        defaultValues: {
            name: role.name,
            color: role.color,
            instructions: role.instructions,
            primary: role.primary,
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
                    name: value.name,
                    color: value.color,
                    instructions: value.instructions,
                    primary: value.primary,
                    // 空串 = 清空 → 继续继承（服务端把 '' 与 null 当同一件事）
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

    const remove = async (): Promise<void> => {
        setBusy(true);
        setError(undefined);
        try {
            await roles.remove(role.id);
            setConfirming(false);
            onDeleted();
        } catch (cause) {
            setError(messageOf(cause));
            setConfirming(false);
        } finally {
            setBusy(false);
        }
    };

    return (
        <div className="flex h-full min-h-0 flex-col">
            <header className="flex items-center gap-2 border-b border-border px-4 py-2.5">
                <span className="text-sm font-semibold">{role.name}</span>
                <span className="rounded border px-1.5 py-0.5 text-[10px] text-muted-foreground">
                    {typeLabel(role.type)}
                </span>
                <span className="ml-auto flex items-center gap-2 text-xs">
                    {saved ? <span className="text-muted-foreground">已保存</span> : null}
                    <button
                        type="button"
                        onClick={() => setConfirming(true)}
                        disabled={busy}
                        className="rounded-lg border px-2 py-1 text-destructive hover:bg-destructive/10 disabled:opacity-40"
                    >
                        删除
                    </button>
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
                    name="name"
                    validators={{
                        onChange: ({ value }) =>
                            validName(
                                value,
                                siblings.map((entry) => entry.name),
                            ),
                    }}
                >
                    {(field) => {
                        const problem = errorOf(field.state.meta.errors);
                        return (
                            <section className="border-b border-border/60 py-3 first:pt-0">
                                <div className="mb-1 text-xs text-muted-foreground">名字</div>
                                <input
                                    value={field.state.value}
                                    onChange={(event) => {
                                        field.handleChange(event.target.value);
                                        setSaved(false);
                                    }}
                                    onBlur={field.handleBlur}
                                    className={`w-64 rounded-lg border bg-card px-2 py-1.5 text-sm outline-none ${
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
                            <section className="border-b border-border/60 py-3">
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
                            <div className="mb-1.5 truncate font-mono text-[11px] text-foreground" title={field.state.value}>
                                {field.state.value === '' ? '跟随全局默认' : field.state.value}
                            </div>
                            <ModelPicker
                                value={field.state.value}
                                onChange={(key) => {
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
                            <div className="mb-1 text-xs text-muted-foreground">推理强度</div>
                            <select
                                value={field.state.value}
                                onChange={(event) => {
                                    field.handleChange(event.target.value);
                                    setSaved(false);
                                }}
                                className="w-48 rounded-lg border bg-card px-2 py-1.5 text-sm outline-none"
                            >
                                {EFFORTS.map((item) => (
                                    <option key={item.value} value={item.value}>
                                        {item.label}
                                    </option>
                                ))}
                            </select>
                        </section>
                    )}
                </form.Field>
            </form>

            {confirming ? (
                <Modal title={`删除角色「${role.name}」？`} onClose={() => setConfirming(false)}>
                    <p className="text-sm">
                        {lastOfType
                            ? `「${typeLabel(role.type)}」只剩这一个角色 —— 删了那类房间就没人应答。服务端会拦下来。`
                            : `它在该类型的所有房间里都会消失，那间房的会话与未答提问一起清掉。`}
                    </p>
                    <div className="mt-4 flex justify-end gap-2">
                        <button type="button" onClick={() => setConfirming(false)} className="rounded-lg border px-3 py-1.5">
                            取消
                        </button>
                        <button
                            type="button"
                            onClick={() => void remove()}
                            disabled={busy}
                            className="rounded-lg bg-destructive px-3 py-1.5 text-white disabled:opacity-40"
                        >
                            删除
                        </button>
                    </div>
                </Modal>
            ) : null}
        </div>
    );
}

// ── 页面 ─────────────────────────────────────────────────────────────────────

export function RolesView({ initialType }: { initialType?: string | undefined } = {}) {
    const all = useRoles();
    const [selected, setSelected] = React.useState('');
    const [creating, setCreating] = React.useState(false);

    // 类型按首次出现的顺序（服务端已按 type / primary / createdAt 排好序）
    const types: string[] = [];
    for (const role of all) if (!types.includes(role.type)) types.push(role.type);
    // 选中顺序：用户点过的 → 深链类型的第一个（primary 优先）→ 整表第一个。
    // 深链（`/settings/roles/task`）就靠中间那行落到它那类角色上；用户之后点别的角色，
    // `selected` 有值就不再被地址抢回去。
    const current =
        all.find((role) => role.id === selected) ??
        all.find((role) => initialType !== undefined && role.type === initialType) ??
        all[0];

    return (
        <div className="grid h-full min-h-0 grid-cols-[minmax(232px,288px)_1fr] bg-background text-foreground">
            <aside className="flex min-h-0 flex-col border-r border-border">
                <div className="space-y-1 border-b border-border p-3">
                    <div className="flex items-center justify-between">
                        <span className="text-sm font-medium">机器人</span>
                        <button
                            type="button"
                            onClick={() => setCreating(true)}
                            className="rounded-lg border px-2 py-1 text-xs hover:bg-muted"
                        >
                            ＋ 新建
                        </button>
                    </div>
                </div>

                <div className="min-h-0 flex-1 overflow-y-auto p-2">
                    {types.length === 0 ? (
                        <p className="p-2 text-xs text-muted-foreground">还没有角色 —— 点右上「＋ 新建」。</p>
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
                    左边还没有角色
                </div>
            ) : (
                // key = 角色 id：切换角色 = 换一份表单初始值（不然会把上一个角色的输入带过去）
                <RoleEditor key={current.id} role={current} onDeleted={() => setSelected('')} />
            )}

            {creating ? (
                <CreateRoleDialog
                    onClose={() => setCreating(false)}
                    onDone={(role) => {
                        setCreating(false);
                        setSelected(role.id);
                    }}
                />
            ) : null}
        </div>
    );
}

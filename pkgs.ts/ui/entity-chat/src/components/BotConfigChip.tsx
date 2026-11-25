// BotConfigChip.tsx —— 聊天页输入框底栏的「机器人配置」入口（三处同构的第三处）。
//
// 用户 2026-11-26：聊天页就地改**该类型 bot 的全局**（role 级 modelKey / reasoningEffort），
// 不走房间级、不跳配置页；点模型名弹二级 panel，effort 与模型分开放，都写回 role。
// main 重构删掉了旧房间头（含原来的配置面板），这一枚 chip 是那个面板的新落点。
//
// L1 = 这枚 chip（极简 `account@provider/model low`）；L2 = 点开的 Modal（标题栏 + 模型 /
// effort + 「去配置页」）；L3 = 设置页机器人段（宿主经 onManageRoles 注入深链）。

import { ChevronRight, Cpu } from 'lucide-react';
import * as React from 'react';

import type { Room } from '../model';
import { roles } from '../roles';
import { useDefaultModelKey, useRoles } from '../store';
import { Modal } from './Dialogs';
import { ModelSelectButton } from './ModelSelectPanel';

/** 推理强度：空 = 跟随模型/服务商缺省。选项按钮组，一眼看全、一点即改 */
const EFFORTS: ReadonlyArray<{ value: string; label: string }> = [
    { value: '', label: '跟随' },
    { value: 'minimal', label: 'minimal' },
    { value: 'low', label: 'low' },
    { value: 'medium', label: 'medium' },
    { value: 'high', label: 'high' },
];

function typeLabel(type: string): string {
    return type === 'task' ? '任务' : type === 'project' ? '项目' : type;
}

export function BotConfigChip({ room, onManageRoles }: { room: Room; onManageRoles?: () => void }) {
    const allRoles = useRoles();
    const defaultKey = useDefaultModelKey();
    // 该类型 primary 优先的角色 —— chip 改的是「这类 bot 的全局」，不是某个房间私有 bot
    const role = allRoles.find((item) => item.type === room.type && item.primary) ?? allRoles.find((item) => item.type === room.type);
    const modelValue = role?.modelKey?.trim() ?? '';
    const effort = role?.reasoningEffort?.trim() ?? '';
    const effective = modelValue === '' ? (defaultKey ?? '') : modelValue;

    const [open, setOpen] = React.useState(false);
    const [busy, setBusy] = React.useState(false);
    const [error, setError] = React.useState<string>();

    const save = React.useCallback(
        async (patch: { modelKey?: string | null; reasoningEffort?: string | null }): Promise<void> => {
            if (role === undefined) return;
            setBusy(true);
            setError(undefined);
            try {
                await roles.update({ id: role.id, ...patch });
            } catch (cause) {
                setError(cause instanceof Error ? cause.message : String(cause));
            } finally {
                setBusy(false);
            }
        },
        [role],
    );

    // 极简：`account@provider/model` + effort（有才显示）。空模型时退回默认 key。
    const label = effective === '' ? '未配置模型' : `${effective}${effort === '' ? '' : ` ${effort}`}`;

    return (
        <>
            <button
                onClick={() => setOpen(true)}
                title={`${label} · 点击配置该类型机器人`}
                className="flex max-w-[280px] items-center gap-1 truncate rounded-md border px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground hover:bg-muted"
            >
                <Cpu className="size-3 shrink-0" />
                <span className="truncate">{label}</span>
            </button>
            {open ? (
                <Modal title={`机器人配置 · ${typeLabel(room.type)}`} onClose={() => setOpen(false)}>
                    <div className="space-y-3 text-xs">
                        <p className="text-[11px] text-muted-foreground">
                            {typeLabel(room.type)}类型 · 所有{typeLabel(room.type)}机器人共享，改一处全类型生效
                        </p>
                        {error === undefined ? null : <p className="text-[11px] text-destructive">{error}</p>}

                        <section>
                            <div className="mb-1.5 text-[11px] text-muted-foreground">模型</div>
                            <ModelSelectButton
                                value={modelValue}
                                onPick={(key) => void save({ modelKey: key })}
                            />
                        </section>

                        <section>
                            <div className="mb-1.5 text-[11px] text-muted-foreground">推理强度</div>
                            <div className="flex flex-wrap gap-1.5">
                                {EFFORTS.map((item) => (
                                    <button
                                        key={item.value}
                                        type="button"
                                        aria-pressed={effort === item.value}
                                        disabled={busy}
                                        onClick={() => void save({ reasoningEffort: item.value === '' ? null : item.value })}
                                        className={`rounded-full border px-2.5 py-0.5 text-[11px] disabled:opacity-40 ${
                                            effort === item.value
                                                ? 'border-ring bg-muted font-medium'
                                                : 'border-border text-muted-foreground hover:bg-muted/60'
                                        }`}
                                    >
                                        {item.label}
                                    </button>
                                ))}
                            </div>
                        </section>

                        {onManageRoles === undefined ? null : (
                            <div className="border-t pt-2">
                                <button
                                    type="button"
                                    onClick={onManageRoles}
                                    className="flex items-center gap-1 rounded px-1 py-0.5 text-[11px] text-muted-foreground hover:bg-muted hover:text-foreground"
                                >
                                    去配置页 <ChevronRight className="size-3" />
                                </button>
                            </div>
                        )}
                    </div>
                </Modal>
            ) : null}
        </>
    );
}

// BotConfigChip.tsx —— 聊天页输入框底栏的机器人配置入口（三处同构的第三处）。
//
// 用户 2026-11-26：选模型 / 选 effort 拆成两枚独立按钮，选模型按钮**直接**打开模型列表
// （少一步：不再先弹二级面板再点模型名）。两枚都就地改**该类型 bot 的全局**（role 级），
// 不走房间级、不跳配置页；「去配置页」收进 effort 面板，保持底栏只有两枚 chip。
//
// L1 = 底栏两枚 chip：`account@provider/model` 与 effort；
// 模型按钮 → ModelSelectPanel（同构搜索表格）；effort 按钮 → 小面板（档位 + 去配置页）。

import { ChevronRight, Cpu, SlidersHorizontal } from 'lucide-react';
import * as React from 'react';

import type { Room } from '../model';
import { modelOfKey } from '../models';
import { roles } from '../roles';
import { useDefaultModelKey, useProviders, useRoles } from '../store';
import { EffortButtons, useEffortOptions } from './EffortButtons';
import { Modal } from './Dialogs';
import { ModelSelectPanel } from './ModelSelectPanel';

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
    const { efforts } = useEffortOptions(modelValue);
    const providers = useProviders();

    const [modelOpen, setModelOpen] = React.useState(false);
    const [effortOpen, setEffortOpen] = React.useState(false);
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

    const modelLabel = effective === '' ? '未配置模型' : effective;
    const effortLabel = effort === '' ? '缺省' : effort;

    return (
        <>
            <div className="flex items-center gap-1">
                <button
                    onClick={() => setModelOpen(true)}
                    title={`模型：${modelLabel} · 点击直接选`}
                    className="flex max-w-[240px] items-center gap-1 truncate rounded-md border px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground hover:bg-muted"
                >
                    <Cpu className="size-3 shrink-0" />
                    <span className="truncate">{modelLabel}</span>
                </button>
                <button
                    onClick={() => setEffortOpen(true)}
                    title={`推理强度：${effortLabel} · 点击切换`}
                    className="flex items-center gap-1 rounded-md border px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground hover:bg-muted"
                >
                    <SlidersHorizontal className="size-3 shrink-0" />
                    <span>{effortLabel}</span>
                </button>
                {error === undefined ? null : <span className="max-w-[120px] truncate text-[10px] text-destructive" title={error}>保存失败</span>}
            </div>

            {/* 选模型：直接弹同构搜索表格，不再经过二级面板 */}
            {modelOpen ? (
                <ModelSelectPanel
                    current={modelValue}
                    onPick={(key) => {
                        setModelOpen(false);
                        // 换模型 = 默认取该模型第一档 effort，没有就清空
                        void save({
                            modelKey: key,
                            reasoningEffort: modelOfKey(providers, key)?.reasoning?.defaultEffort ?? null,
                        });
                    }}
                    onClose={() => setModelOpen(false)}
                />
            ) : null}

            {/* effort + 去配置页收进一个小面板，底栏保持两枚 chip */}
            {effortOpen ? (
                <Modal title={`推理强度 · ${typeLabel(room.type)}机器人`} onClose={() => setEffortOpen(false)}>
                    <div className="space-y-3 text-xs">
                        <p className="text-[11px] text-muted-foreground">
                            {typeLabel(room.type)}类型 · 所有{typeLabel(room.type)}机器人共享；「缺省」= 不指定，交给模型/服务商。
                        </p>
                        {error === undefined ? null : <p className="text-[11px] text-destructive">{error}</p>}
                        <EffortButtons
                            value={effort}
                            efforts={efforts}
                            busy={busy}
                            onChange={(value) => void save({ reasoningEffort: value === '' ? null : value })}
                        />
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

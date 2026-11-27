// EffortButtons.tsx —— 推理强度选项按钮组（三处同构共用）。
//
// 用户 2026-11-26：effort 档位来自模型（models.dev 的 reasoning_options，沿目录链路透传），
// 不是 UI 硬编码。永远显示一档「缺省」占位符（对齐 dsh 的 Provider default 认知）：
//   · 有 efforts 的模型 → [缺省, ...efforts]
//   · 无 efforts 的模型（toggle / budget / 不推理）→ 只有「缺省」占位符
// 选「缺省」= 值 ''（存 null，不传 reasoningEffort 参数，交给模型/服务商）。
//
// 本组件无状态：只收当前值 + 候选 + 回调，三处（配置页 / bot 页 / 聊天页）共用同一手感。

import * as React from 'react';

import { modelOfKey } from '../models';
import { useDefaultModelKey, useProviders } from '../store';

/** 从 modelKey 查该模型的 effort 候选；空 key（跟随默认）时查默认模型 */
export function useEffortOptions(modelKey: string): { efforts: readonly string[]; defaultEffort: string } {
    const providers = useProviders();
    const defaultKey = useDefaultModelKey();
    const effective = modelKey.trim() === '' ? defaultKey : modelKey;
    const reasoning = modelOfKey(providers, effective)?.reasoning;
    return React.useMemo(
        () => ({ efforts: reasoning?.efforts ?? [], defaultEffort: reasoning?.defaultEffort ?? '' }),
        [reasoning],
    );
}

export function EffortButtons({
    value,
    efforts,
    onChange,
    busy = false,
}: {
    /** 当前 effort（'' = 缺省） */
    value: string;
    efforts: readonly string[];
    onChange: (value: string) => void;
    busy?: boolean;
}) {
    // 去重：缺省 + 模型候选（有些模型 efforts 里就含 none，跟缺省同名也不重复画）
    const options = React.useMemo(() => {
        const out: string[] = [''];
        for (const effort of efforts) if (effort !== '' && !out.includes(effort)) out.push(effort);
        return out;
    }, [efforts]);

    return (
        <div className="flex flex-wrap gap-1.5">
            {options.map((effort) => (
                <button
                    key={effort}
                    type="button"
                    aria-pressed={value === effort}
                    disabled={busy}
                    onClick={() => onChange(effort)}
                    className={`rounded-full border px-2.5 py-0.5 text-[11px] disabled:opacity-40 ${
                        value === effort
                            ? 'border-ring bg-muted font-medium'
                            : 'border-border text-muted-foreground hover:bg-muted/60'
                    }`}
                >
                    {effort === '' ? '缺省' : effort}
                </button>
            ))}
        </div>
    );
}

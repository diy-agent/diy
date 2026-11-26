// AttachmentsRow —— 待发附件的缩略图行（输入框上方那一排）
//
// 用语义变量 + Tailwind 刻度，不写 hex / 不写任意值（DESIGN.md：`rounded-[7px]` 这类一律不要；
// 颜色只走 `bg-muted` / `border` / `foreground`）。这样暗色主题跟着走，不会出现
// 「亮色下好看、暗色下一块死黑」。
//
// 2026-11-26 曾在两个 surface（shadcn / Astryx）之间共用，所以当时用了内联样式；
// Astryx 面已删，理由消失，改回正常写法。

import * as React from 'react';

import type { AttachmentRef } from '@diy-agent/protocol';

import type { PendingAttachment } from './useComposerAttachments';

/** 非图片附件显示「扩展名 + 大小」 —— 没有缩略图也要能看出这是什么 */
function fallbackLabel(ref: AttachmentRef): string {
    const ext = ref.displayName.includes('.') ? ref.displayName.split('.').at(-1) ?? '' : ref.kind;
    const kb = ref.bytes / 1024;
    const size = kb < 1024 ? `${Math.max(1, Math.round(kb))}K` : `${(kb / 1024).toFixed(1)}M`;
    return `${ext.toUpperCase()}\n${size}`;
}

export function AttachmentsRow({
    items,
    onRemove,
    busy,
}: {
    items: readonly PendingAttachment[];
    onRemove: (ref: AttachmentRef) => void;
    busy?: boolean;
}): React.ReactElement | null {
    if (items.length === 0 && busy !== true) return null;
    return (
        <div className="flex flex-wrap gap-2 py-1" aria-label="待发送的附件">
            {items.map((item) => (
                <div
                    key={item.ref.id}
                    className="relative flex size-14 items-center justify-center overflow-hidden rounded-lg border bg-muted p-0.5 text-center text-[10px] leading-tight"
                    title={`${item.name}（${item.ref.mime}）`}
                >
                    {item.preview === undefined ? (
                        <span className="whitespace-pre-line">{fallbackLabel(item.ref)}</span>
                    ) : (
                        <img src={item.preview} alt={item.name} className="size-full object-cover" />
                    )}
                    <button
                        type="button"
                        className="absolute right-0.5 top-0.5 size-4 cursor-pointer rounded-full bg-foreground/70 text-[10px] leading-4 text-background"
                        title="移除"
                        onClick={() => onRemove(item.ref)}
                    >
                        ×
                    </button>
                </div>
            ))}
            {busy === true && (
                <div className="flex size-14 items-center justify-center rounded-lg border bg-muted text-[10px]">
                    上传中…
                </div>
            )}
        </div>
    );
}

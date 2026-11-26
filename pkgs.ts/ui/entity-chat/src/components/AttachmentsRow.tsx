// AttachmentsRow —— 待发附件的缩略图行（输入框上方那一排）
//
// 为什么用内联样式而不是 Tailwind / 设计系统组件：这一排要同时出现在两面
// （shadcn 全裸 Tailwind、Astryx 走设计系统）。两套样式里各写一份 = 将来必然漂移，
// 而它只有「一行可滚的方块 + 一个叉」，用不着任何框架能力。

import * as React from 'react';

import type { AttachmentRef } from '@diy-agent/protocol';

import type { PendingAttachment } from './useComposerAttachments';

const THUMB = 56;

const rowStyle: React.CSSProperties = {
    display: 'flex',
    gap: 8,
    flexWrap: 'wrap',
    padding: '4px 0',
};

const chipStyle: React.CSSProperties = {
    position: 'relative',
    width: THUMB,
    height: THUMB,
    borderRadius: 8,
    overflow: 'hidden',
    border: '1px solid rgba(127,127,127,0.35)',
    background: 'rgba(127,127,127,0.12)',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    fontSize: 10,
    lineHeight: 1.2,
    textAlign: 'center',
    padding: 2,
};

const removeStyle: React.CSSProperties = {
    position: 'absolute',
    top: 1,
    right: 1,
    width: 16,
    height: 16,
    borderRadius: 8,
    border: 'none',
    cursor: 'pointer',
    background: 'rgba(0,0,0,0.65)',
    color: '#fff',
    fontSize: 11,
    lineHeight: '16px',
    padding: 0,
};

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
        <div style={rowStyle} aria-label="待发送的附件">
            {items.map((item) => (
                <div key={item.ref.id} style={chipStyle} title={`${item.name}（${item.ref.mime}）`}>
                    {item.preview === undefined ? (
                        <span style={{ whiteSpace: 'pre-line' }}>{fallbackLabel(item.ref)}</span>
                    ) : (
                        <img src={item.preview} alt={item.name} style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
                    )}
                    <button type="button" style={removeStyle} title="移除" onClick={() => onRemove(item.ref)}>
                        ×
                    </button>
                </div>
            ))}
            {busy === true && <div style={{ ...chipStyle, fontSize: 10 }}>上传中…</div>}
        </div>
    );
}

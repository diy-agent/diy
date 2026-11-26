// useComposerAttachments —— 输入框旁的「待发附件」状态（粘贴 / 拖拽 / 选图 → 上传 → ref）
//
// 为什么是一个共享 hook 而不是两面各写一份：
//   · 上传时机（发送**之前**）、上限、失败提示、预览 URL 的回收，这些规则两面必须一致；
//   · 两个界面（shadcn / Astryx）都只是「把 files 递进来 + 把缩略图摆出去」，
//     真正的判断没有一处与框架有关。
//
// 关键判据（2026-11-26）：
//   ① **先上传再发送**：一次可能带几张，任何一张失败都该在发送前报出来（用户还看得见、还能重试），
//      而不是发出去之后在气泡里出现一个裂图。
//   ② 预览用 `URL.createObjectURL`（本地、零拷贝）；移除 / 发送时必须 `revokeObjectURL`，
//      否则一次会话贴几十张图就是几十 MB 的泄漏。
//   ③ 后端不支持附件（没有 `putAttachment`）⇒ `supported=false`，界面据此禁用入口，
//      而不是让人贴完再发现发不出去。
//   ④ **拖一个目录进来** = 浏览器把目录里的文件逐个给过来（`webkitRelativePath` 带层级）。
//      这里按「多条平铺附件」处理，并用相对路径当显示名 —— 这样 `login/a.png` 与 `home/a.png`
//      在气泡里分得清。不打包：浏览器拿不到目录路径，也打不了 tar；而模型要看的就是那几张图本身。

import * as React from 'react';

import type { AttachmentRef } from '@diy-agent/protocol';
import type { ConversationModel } from '@diy-agent/chat-core';

/** 一条待发附件 */
export interface PendingAttachment {
    readonly ref: AttachmentRef;
    /** 本地预览 URL（`blob:`）；非图片为 undefined */
    readonly preview?: string;
    /** 显示名（服务端嗅探后的真名） */
    readonly name: string;
}

/** 一次发送最多带几个（与 protocol 的 `MAX_ATTACHMENTS_PER_MESSAGE` 同一个数） */
export const MAX_PENDING_ATTACHMENTS = 8;

export interface ComposerAttachments {
    readonly items: readonly PendingAttachment[];
    /** 后端是否支持附件（老服务端 = false） */
    readonly supported: boolean;
    readonly busy: boolean;
    readonly error: string | undefined;
    /** 接 `onPaste` / `onDrop` / 选择器给的 File 列表 */
    addFiles: (files: readonly File[]) => void;
    remove: (ref: AttachmentRef) => void;
    /** 发送成功后调用：清空并回收预览 URL */
    clear: () => void;
    /** 发送时的 refs（没有就 undefined，别给空数组） */
    refs: readonly AttachmentRef[] | undefined;
}

function previewOf(file: File): string | undefined {
    if (!file.type.startsWith('image/')) return undefined;
    // 测试环境 / 无 URL.createObjectURL 的地方退化成「没有预览」
    if (typeof URL === 'undefined' || typeof URL.createObjectURL !== 'function') return undefined;
    try {
        return URL.createObjectURL(file);
    } catch {
        return undefined;
    }
}

function messageOf(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

/**
 * 一个 `File` 的显示名。
 *
 * 拖**目录**进来时浏览器逐个给文件，`webkitRelativePath` 才带层级（`dir/sub/a.png`）——
 * 用它当显示名，气泡里才分得清 `login/a.png` 与 `home/a.png`。
 */
export function displayNameOf(file: { name: string; webkitRelativePath?: string }): string {
    const relative = file.webkitRelativePath;
    return relative !== undefined && relative !== '' ? relative : file.name;
}

/**
 * 超上限时的提示。说清「这次一共来了几个」——
 * 拖目录时用户只看到「没传完」，不给总数他不知道是漏了 1 个还是 100 个。
 */
export function limitMessage(total: number, limit: number = MAX_PENDING_ATTACHMENTS): string {
    return total > limit
        ? `这次有 ${total} 个文件，一次最多发 ${limit} 个（先发这些，剩下的再拖一次）`
        : `一次最多 ${limit} 个附件`;
}

/**
 * @param model 会话模型（`ConversationStore`）；`putAttachment` 缺省 = 后端不支持
 * @param roomId 换房间时要清空（草稿按房间分开，附件同理）
 */
export function useComposerAttachments(model: ConversationModel, roomId: string): ComposerAttachments {
    const [items, setItems] = React.useState<PendingAttachment[]>([]);
    const [busy, setBusy] = React.useState(false);
    const [error, setError] = React.useState<string | undefined>(undefined);
    const supported = model.putAttachment !== undefined;
    // 预览 URL 记在 ref 里：clear / 卸载时要能同步回收（state 里那份可能已经过期）
    const previews = React.useRef<string[]>([]);

    const dropAll = React.useCallback(() => {
        for (const url of previews.current) URL.revokeObjectURL?.(url);
        previews.current = [];
        setItems([]);
    }, []);

    // 换房间 = 换上下文：上一个房间没发出去的图不该跟着走
    React.useEffect(() => {
        dropAll();
        setError(undefined);
    }, [roomId, dropAll]);

    // 组件卸载（关掉对话页）时把 blob URL 一起放掉
    React.useEffect(() => () => dropAll(), [dropAll]);

    const addFiles = React.useCallback(
        (files: readonly File[]) => {
            if (files.length === 0) return;
            const put = model.putAttachment;
            if (put === undefined) {
                setError('当前后端不支持附件');
                return;
            }
            setBusy(true);
            setError(undefined);
            void (async () => {
                const added: PendingAttachment[] = [];
                try {
                    for (const file of files) {
                        // 上限按「已经收下的 + 这一批」算：超出的部分不再上传（省一次往返）
                        if (items.length + added.length >= MAX_PENDING_ATTACHMENTS) {
                            setError(limitMessage(files.length));
                            break;
                        }
                        const bytes = new Uint8Array(await file.arrayBuffer());
                        if (bytes.byteLength === 0) continue;
                        const name = displayNameOf(file);
                        const ref = await put.call(model, {
                            bytes,
                            ...(name === '' ? {} : { name }),
                            ...(file.type === '' ? {} : { mime: file.type }),
                            // 剪贴板来的图没有有意义的文件名，用它区分来源
                            source: file.name === '' ? 'paste' : 'drop',
                        });
                        const preview = previewOf(file);
                        if (preview !== undefined) previews.current.push(preview);
                        added.push({ ref, name: ref.displayName, ...(preview === undefined ? {} : { preview }) });
                    }
                    if (added.length > 0) setItems((current) => [...current, ...added]);
                } catch (failure) {
                    setError(`附件上传失败：${messageOf(failure)}`);
                    // 已经传上去的那几张仍然留着（用户能删），不要因为最后一张失败就全丢
                    if (added.length > 0) setItems((current) => [...current, ...added]);
                } finally {
                    setBusy(false);
                }
            })();
        },
        [model, items.length],
    );

    const remove = React.useCallback((ref: AttachmentRef) => {
        setItems((current) => {
            const target = current.find((item) => item.ref.id === ref.id);
            if (target?.preview !== undefined) {
                URL.revokeObjectURL?.(target.preview);
                previews.current = previews.current.filter((url) => url !== target.preview);
            }
            return current.filter((item) => item.ref.id !== ref.id);
        });
    }, []);

    return {
        items,
        supported,
        busy,
        error,
        addFiles,
        remove,
        clear: dropAll,
        refs: items.length === 0 ? undefined : items.map((item) => item.ref),
    };
}

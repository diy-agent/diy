// MessageAttachments —— 气泡里的附件（图直接看图，其余给一个文件条）
//
// 为什么图要「按需拉」而不是随消息一起回：消息走 RPC 快照 / 事件流，图是 blobs 里的字节。
// 把 base64 塞进每条消息的快照 = 一屏历史几十 MB 的 JSON，每次打开房间都传一遍。
// 所以：消息里只有 ref（几百字节），这里按需 pull 一次并缓存在模块级 Map 里。
//
// 缓存不带淘汰：附件 id 全局唯一且不可变（stored 的 id 就是它的路径），而一次会话里
// 人贴的图通常几十张 —— 真要清，刷新页面就没了（这是渲染进程内存，不是磁盘）。

import * as React from 'react';

import type { AttachmentRef } from '@diy-agent/protocol';

/** id → data URL（同一张图在时间线里重渲多次只拉一次） */
const urlCache = new Map<string, string>();
/** 正在拉的（同一条消息重渲时不重复发请求） */
const inflight = new Map<string, Promise<string>>();

async function loadUrl(
    ref: AttachmentRef,
    read: (ref: AttachmentRef) => Promise<{ base64: string; mime: string }>,
): Promise<string> {
    const cached = urlCache.get(ref.id);
    if (cached !== undefined) return cached;
    const running = inflight.get(ref.id);
    if (running !== undefined) return running;
    const task = read(ref).then(({ base64, mime }) => {
        const url = `data:${mime};base64,${base64}`;
        urlCache.set(ref.id, url);
        inflight.delete(ref.id);
        return url;
    });
    inflight.set(ref.id, task);
    return task;
}

function useAttachmentUrl(
    ref: AttachmentRef,
    read: ((ref: AttachmentRef) => Promise<{ base64: string; mime: string }>) | undefined,
): { url?: string; failed: boolean } {
    const [state, setState] = React.useState<{ url?: string; failed: boolean }>(() => {
        const cached = urlCache.get(ref.id);
        return cached === undefined ? { failed: false } : { url: cached, failed: false };
    });

    React.useEffect(() => {
        if (read === undefined || ref.kind !== 'image') return;
        if (urlCache.has(ref.id)) {
            setState({ url: urlCache.get(ref.id), failed: false });
            return;
        }
        let live = true;
        void loadUrl(ref, read).then(
            (url) => {
                if (live) setState({ url, failed: false });
            },
            () => {
                if (live) setState({ failed: true });
            },
        );
        return () => {
            live = false;
        };
    }, [ref, read]);

    return state;
}

function ImageAttachment({
    // prop 名不能叫 `ref`：React Compiler 会把它当 React ref，于是 render 里读它的字段就报
    // `Cannot access refs during render`（实测 4 处全出在这个名字上）。它就是个普通数据对象。
    attachment,
    read,
    onOpen,
}: {
    attachment: AttachmentRef;
    read?: (ref: AttachmentRef) => Promise<{ base64: string; mime: string }>;
    onOpen?: (url: string) => void;
}): React.ReactElement {
    const { url, failed } = useAttachmentUrl(attachment, read);
    if (failed) {
        return <Box title={attachment.displayName}>图裂了（文件已不在）</Box>;
    }
    if (url === undefined) {
        return <Box title={attachment.displayName}>加载中…</Box>;
    }
    return (
        <img
            src={url}
            alt={attachment.displayName}
            title={attachment.displayName}
            onClick={() => onOpen?.(url)}
            // 尺寸用 Tailwind 刻度（max-h-56 = 224px / max-w-72 = 288px），不写任意值
            className={`max-h-56 max-w-72 rounded-lg object-contain ${onOpen === undefined ? '' : 'cursor-zoom-in'}`}
        />
    );
}

function Box({ children, title }: { children: React.ReactNode; title: string }): React.ReactElement {
    return (
        <div title={title} className="rounded-lg border px-2.5 py-1.5 text-[11px] text-muted-foreground">
            {children}
        </div>
    );
}

/** 非图片：一条能看出「是什么、多大」的文件条（点开才知道内容，点不了就只显示） */
function FileChip({ attachment }: { attachment: AttachmentRef }): React.ReactElement {
    const kb = attachment.bytes / 1024;
    const size = kb < 1024 ? `${Math.max(1, Math.round(kb))} KB` : `${(kb / 1024).toFixed(1)} MB`;
    const label =
        attachment.kind === 'dir'
            ? `📁 ${attachment.displayName}${attachment.listing === undefined ? '' : `（${attachment.listing.count} 个文件）`}`
            : attachment.kind === 'archive'
              ? `🗜 ${attachment.displayName}（${size}）`
              : `📄 ${attachment.displayName}（${size}）`;
    // 判别键两支：`stored` 有 relPath、`linked` 有 path（不能直接去拿另一个）
    const where = attachment.type === 'linked' ? attachment.path : attachment.relPath;
    return <Box title={where}>{label}</Box>;
}

export interface MessageAttachmentsProps {
    refs?: readonly AttachmentRef[];
    /** 拉取内容（缺省 = 不支持，图会显示成占位） */
    read?: (ref: AttachmentRef) => Promise<{ base64: string; mime: string }>;
    /** 点图放大（两面各有自己的灯箱实现；不给就不响应点击） */
    onOpenImage?: (url: string) => void;
}

/** 一条消息的附件区；没有附件时返回 null（不占任何空间） */
export function MessageAttachments({ refs, read, onOpenImage }: MessageAttachmentsProps): React.ReactElement | null {
    if (refs === undefined || refs.length === 0) return null;
    return (
        <div className="mb-1 flex flex-wrap gap-1.5">
            {refs.map((attachment) =>
                attachment.kind === 'image' ? (
                    <ImageAttachment
                        key={attachment.id}
                        attachment={attachment}
                        {...(read === undefined ? {} : { read })}
                        {...(onOpenImage === undefined ? {} : { onOpen: onOpenImage })}
                    />
                ) : (
                    <FileChip key={attachment.id} attachment={attachment} />
                ),
            )}
        </div>
    );
}

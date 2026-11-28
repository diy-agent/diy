// session-images.ts —— 把「带附件的 transcript 条目」展开成 ai-sdk 的 messages
//
// 为什么要单独一层（2026-11-26）：
//   ① transcript 里**只存 ref**（`entry.attachments`），message 仍是纯文本 —— 因为 transcript
//      会进快照落库（`saveSession`），一张 2MB 截图 base64 化会让 db 永久膨胀，且每条历史都带一遍。
//   ② 字节只在「发请求那一刻」读：组装 messages 时把 ref 换成 ai-sdk 的 file part。
//   ③ 读过的字节按 sha256 缓存在内存里（同一张图在整个会话生命周期里只读一次盘）。
//
// 只送图（`kind: 'image'`）：pdf / 音频 / 目录一律不塞进 content，而是留一行说明让模型知道
// 「这里本来有个附件，要看就用工具去开」。理由：图片是唯一「模型直接能看」的形态，
// 其余塞进去只会在上游被拒或变成一堆乱码 token。
//
// 读不到时（reader 没注入 / 文件被清 / 老消息指向已删的 blob）**不静默丢**：补一行
// `[附图未送达：xxx]`。模型的症状是「答非所问」，而一句「图没送到」能让它当场说清。
// `vision-guard` 只在这里留下事实，怎么提示用户是 UI 的事。

import type { FilePart, ModelMessage, TextPart, ToolResultPart } from 'ai';

import type { AttachmentRef } from '@diy-agent/attachment/types';

import type { TranscriptEntry } from './compaction';

/** 读一个附件的字节（由宿主注入：diy2 里是 blobs，测试里是内存表） */
export type AttachmentReader = (ref: AttachmentRef) => Promise<Uint8Array>;

/** 缓存上限：一张截图 1~3 MB，64 MB 够放二三十张，超了按插入顺序淘汰最旧的 */
const DEFAULT_CACHE_BYTES = 64 * 1024 * 1024;

/**
 * 按内容指纹缓存读出来的字节。
 *
 * 键用 `sha256 ?? id`：同一张图被贴进多个房间 / 多次引用时（sha256 相同）只占一份。
 * 值是 `Uint8Array`（不存 base64 字符串：base64 是 1.33 倍，而 ai-sdk 自己会做编码）。
 */
export class AttachmentBytesCache {
    private readonly store = new Map<string, Uint8Array>();
    private used = 0;

    constructor(private readonly maxBytes: number = DEFAULT_CACHE_BYTES) {}

    get(ref: AttachmentRef): Uint8Array | undefined {
        return this.store.get(keyOf(ref));
    }

    set(ref: AttachmentRef, bytes: Uint8Array): void {
        const key = keyOf(ref);
        if (this.store.has(key)) return;
        // 单张就超上限（> 64 MB 的图本来就该被 maxBytes 挡在 blob 外）：不进缓存，但照用
        if (bytes.byteLength > this.maxBytes) return;
        while (this.used + bytes.byteLength > this.maxBytes) {
            const oldest = this.store.keys().next();
            if (oldest.done === true) break;
            const evicted = this.store.get(oldest.value);
            this.store.delete(oldest.value);
            this.used -= evicted?.byteLength ?? 0;
        }
        this.store.set(key, bytes);
        this.used += bytes.byteLength;
    }
}

function keyOf(ref: AttachmentRef): string {
    return ref.sha256 ?? ref.id;
}

/** 这条附件要不要进模型 content（只有图进） */
function sendable(ref: AttachmentRef): boolean {
    return ref.kind === 'image';
}

/** 一行人话说明（给模型看；不进 UI） */
function describe(ref: AttachmentRef): string {
    const size = ref.image === undefined ? '' : `，${ref.image.width}×${ref.image.height}`;
    return `${ref.displayName}（${ref.mime}，${formatBytes(ref.bytes)}${size}）`;
}

function formatBytes(bytes: number): string {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

/**
 * 一条 transcript 条目 → 真正发给模型的 message。
 *
 * 无附件（99% 的消息）原样返回，一个数组都不建 —— 别让常规路径为多模态付代价。
 */
export async function messageWithAttachments(
    entry: TranscriptEntry,
    read: AttachmentReader | undefined,
    cache: AttachmentBytesCache = new AttachmentBytesCache(),
    options: { acceptsImages?: boolean } = {},
): Promise<ModelMessage> {
    const refs = entry.attachments ?? [];
    if (refs.length === 0) return entry.message;
    // 人的消息：图片直接进 user content（原来就有的路）。
    // 工具的消息（2026-11-28）：`view_image` 这类工具**看过的图**也要进模型 —— 否则同一轮
    // 内模型看不到自己刚调的工具产出的图（实测症状：“只回传了 PNG 的原始字节”）。
    if (entry.message.role === 'tool') return toolMessageWithAttachments(entry, refs, read, cache, options);
    if (entry.message.role !== 'user') return entry.message;

    const text = typeof entry.message.content === 'string' ? entry.message.content : '';
    const parts: Array<TextPart | FilePart> = [];
    if (text !== '') parts.push({ type: 'text', text });

    const acceptsImages = options.acceptsImages ?? true;
    for (const ref of refs) {
        if (sendable(ref) && !acceptsImages) {
            // 本模型不收图：**不塞 image part**（塞了换回来的是 400），但也不静默丢 ——
            // 留一句话，模型才知道「这里本来有张图、要看得靠工具或换个模型」
            parts.push({ type: 'text', text: `[附图未送达：${describe(ref)} —— 当前模型不收图]` });
            continue;
        }
        if (!sendable(ref)) {
            // 非图片：说明一行，别把 pdf / 目录塞进 content
            parts.push({ type: 'text', text: `[附件：${describe(ref)} —— 未送进上下文，要看得用工具打开]` });
            continue;
        }
        const bytes = await loadBytes(ref, read, cache);
        if (bytes === undefined) {
            parts.push({ type: 'text', text: `[附图未送达：${describe(ref)}]` });
            continue;
        }
        parts.push({ type: 'file', mediaType: ref.mime, data: bytes, filename: ref.displayName });
    }

    // 只有图、没有正文时不能是空数组（上游会拒）：补一行占位，模型才知道这是人贴的图
    if (parts.length === 0) parts.push({ type: 'text', text: '[附图]' });
    return { role: 'user', content: parts };
}

/**
 * tool 消息带附件（`view_image` 看过的图）→ 把它的 output 从纯文本换成 content 型。
 *
 * 形状（ai-sdk 的 ToolResultOutput）：
 *   `{ type:'content', value:[{type:'text'}, ...{type:'file', mediaType, data}] }`
 *
 * 为什么必须走 content 型而不是重开一条 user 消息：**它得挂回那次 tool_call**（toolCallId），
 * 否则模型不知道这图是谁给的。而且上游 OpenAI 兼容协议里 tool 消息本来就支持多部分
 * （opencode-go 实测可用，见 provider 的 strategy 注释）。
 */
async function toolMessageWithAttachments(
    entry: TranscriptEntry,
    refs: readonly AttachmentRef[],
    read: AttachmentReader | undefined,
    cache: AttachmentBytesCache,
    options: { acceptsImages?: boolean },
): Promise<ModelMessage> {
    const message = entry.message;
    if (message.role !== 'tool' || !Array.isArray(message.content)) return message;
    const acceptsImages = options.acceptsImages ?? true;
    const content: ToolResultPart[] = [];
    let replaced = false;
    for (const part of message.content) {
        if (part.type !== 'tool-result') continue;
        const text = toolOutputText(part.output);
        // tool-result 的 file 用的是 `FileData` **标签联合**（与 user 消息的 FilePart.data 不同）：
        // `{ type:'data', data: Uint8Array }`，不是裸的 Uint8Array。
        const files: Array<{
            type: 'file';
            mediaType: string;
            data: { type: 'data'; data: Uint8Array };
            filename?: string;
        }> = [];
        // 不收图的模型：不塞 file part（塞了换回 400）。也不留占位 —— tool 结果正文仍完整。
        if (acceptsImages) {
            for (const ref of refs) {
                if (!sendable(ref)) continue;
                const bytes = await loadBytes(ref, read, cache);
                if (bytes === undefined) continue;
                files.push({
                    type: 'file',
                    mediaType: ref.mime,
                    data: { type: 'data', data: bytes },
                    filename: ref.displayName,
                });
            }
        }
        if (files.length === 0) {
            content.push(part); // 没图可送：原样保留
            continue;
        }
        content.push({ ...part, output: { type: 'content', value: [{ type: 'text', text }, ...files] } });
        replaced = true;
    }
    if (!replaced) return message;
    return { role: 'tool', content };
}

/**
 * tool-result 的 output → 纯文本（重建 file part 时与它们拼在一起）。
 *
 * 三种形状：
 *   · `text` 型：直接取 value（工具结果的常态）
 *   · `content` 型：**scrub 之后的形状** —— 它原本是 `[text, file]`，字节被 `media-scrub`
 *     换成了 `[xxx 已交给模型看过…]` 的说明。图已经按 ref 重新读回来了，那行说明就是
 *     噪音（同一张图说两遍）⇒ **丢掉**，只拼剩下的文本。
 *   · 其余：JSON（不吞信息）
 */
function toolOutputText(output: unknown): string {
    if (output === null || typeof output !== 'object') return '';
    const record = output as { type?: unknown; value?: unknown };
    if (record.type === 'text' && typeof record.value === 'string') return record.value;
    if (record.type === 'content' && Array.isArray(record.value)) {
        return (record.value as Array<{ type?: unknown; text?: unknown }>)
            .filter((part): part is { type: 'text'; text: string } =>
                part?.type === 'text' && typeof part.text === 'string',
            )
            .map((part) => part.text)
            .filter((text) => !text.includes('已交给模型看过')) // scrub 留下的占位，图已回来
            .join('\n');
    }
    return record.value === undefined ? '' : JSON.stringify(record.value);
}

async function loadBytes(
    ref: AttachmentRef,
    read: AttachmentReader | undefined,
    cache: AttachmentBytesCache,
): Promise<Uint8Array | undefined> {
    const cached = cache.get(ref);
    if (cached !== undefined) return cached;
    if (read === undefined) return undefined;
    try {
        const bytes = await read(ref);
        cache.set(ref, bytes);
        return bytes;
    } catch {
        // 文件不存在 / 读坏 / blob 被清：留一行「未送达」，不要把整轮对话带崩
        return undefined;
    }
}

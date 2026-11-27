// ref.ts — `AttachmentRef` 的校验（形状不对一律炸，不「容错一下」）
//
// 为什么要有这一层（2026-11-26）：ref 会从**消息 json / sqlite / RPC 回包**里读回来 ——
// 全是外部输入。一个拼错的键（`relpath`）、一个漏掉的 `kind`、一个 `../` 的 relPath，
// 后果分别是「图悄悄不显示」「UI 崩」「读到 blobs 外的文件」。静默降级的代价远大于报错，
// 所以这里按 diy 规范（rule.code#discriminated-union + 未知键即错）逐字段验。
//
// 边界：**只验形状，不验存在性**（文件在不在是 store.read 的事 —— 校验层不碰磁盘）。

import { AttachmentError } from './errors.js';
import type { AttachmentKind, AttachmentListing, AttachmentOrigin, AttachmentRef, AttachmentSource } from './types.js';

/** 类别全集 */
export const ATTACHMENT_KINDS: readonly AttachmentKind[] = ['image', 'file', 'archive', 'dir'];

/** 来源全集（见 types.ts 的 AttachmentSource 注释） */
export const ATTACHMENT_SOURCES: readonly AttachmentSource[] = [
    'paste',
    'drop',
    'pick',
    'path',
    'url',
    'tool',
    'relay',
];

const BASE_KEYS = [
    'type',
    'id',
    'kind',
    'mime',
    'bytes',
    'displayName',
    'source',
    'createdAt',
    'sha256',
    'image',
    'origin',
    'listing',
] as const;

const STORED_KEYS = [...BASE_KEYS, 'relPath'] as const;
const LINKED_KEYS = [...BASE_KEYS, 'path'] as const;

function fail(message: string, path: string): never {
    throw new AttachmentError('attachment/ref-invalid', message, path);
}

function takeObject(value: unknown, path: string): Record<string, unknown> {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
        fail(`期望对象，拿到 ${value === null ? 'null' : typeof value}`, path);
    }
    return value as Record<string, unknown>;
}

function takeString(value: unknown, path: string): string {
    if (typeof value !== 'string') fail(`期望字符串，拿到 ${typeof value}`, path);
    return value;
}

function takeNonEmpty(value: unknown, path: string): string {
    const text = takeString(value, path);
    if (text === '') fail('期望非空字符串', path);
    return text;
}

function takeNonNegativeInt(value: unknown, path: string): number {
    if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) {
        fail(`期望非负整数，拿到 ${String(value)}`, path);
    }
    return value;
}

function rejectUnknown(obj: Record<string, unknown>, allowed: readonly string[], path: string): void {
    for (const key of Object.keys(obj)) {
        if (!allowed.includes(key)) fail(`未知字段 \`${key}\`（允许：${allowed.join(' / ')}）`, `${path}.${key}`);
    }
}

function parseListing(value: unknown, path: string): AttachmentListing {
    const obj = takeObject(value, path);
    rejectUnknown(obj, ['count', 'bytes', 'sample', 'truncated'], path);
    const sample = obj.sample;
    if (!Array.isArray(sample) || sample.some((item) => typeof item !== 'string')) {
        fail('sample 必须是字符串数组', `${path}.sample`);
    }
    const listing: AttachmentListing = {
        count: takeNonNegativeInt(obj.count, `${path}.count`),
        sample: sample as string[],
        ...(obj.bytes === undefined ? {} : { bytes: takeNonNegativeInt(obj.bytes, `${path}.bytes`) }),
        ...(obj.truncated === undefined ? {} : { truncated: obj.truncated === true }),
    };
    return listing;
}

function parseOrigin(value: unknown, path: string): AttachmentOrigin {
    const obj = takeObject(value, path);
    rejectUnknown(obj, ['url', 'toolCallId', 'roomId', 'originalPath'], path);
    const origin: AttachmentOrigin = {
        ...(obj.url === undefined ? {} : { url: takeString(obj.url, `${path}.url`) }),
        ...(obj.toolCallId === undefined ? {} : { toolCallId: takeString(obj.toolCallId, `${path}.toolCallId`) }),
        ...(obj.roomId === undefined ? {} : { roomId: takeString(obj.roomId, `${path}.roomId`) }),
        ...(obj.originalPath === undefined
            ? {}
            : { originalPath: takeString(obj.originalPath, `${path}.originalPath`) }),
    };
    return origin;
}

/**
 * 校验一条 ref（从消息 / db / RPC 读回来的都要过这里）。
 *
 * @param value 待验的原始值
 * @param path  出错时点路径的根（缺省 `attachment`）
 */
export function parseAttachmentRef(value: unknown, path = 'attachment'): AttachmentRef {
    const obj = takeObject(value, path);
    const type = takeString(obj.type, `${path}.type`);
    if (type !== 'stored' && type !== 'linked') {
        fail(`未知形态 ${type}（允许：stored / linked）`, `${path}.type`);
    }
    rejectUnknown(obj, type === 'stored' ? STORED_KEYS : LINKED_KEYS, path);

    const kind = takeString(obj.kind, `${path}.kind`);
    if (!ATTACHMENT_KINDS.includes(kind as AttachmentKind)) {
        fail(`未知类别 ${kind}（允许：${ATTACHMENT_KINDS.join(' / ')}）`, `${path}.kind`);
    }
    const source = takeString(obj.source, `${path}.source`);
    if (!ATTACHMENT_SOURCES.includes(source as AttachmentSource)) {
        fail(`未知来源 ${source}（允许：${ATTACHMENT_SOURCES.join(' / ')}）`, `${path}.source`);
    }
    const sha256 = obj.sha256 === undefined ? undefined : takeString(obj.sha256, `${path}.sha256`);
    if (sha256 !== undefined && !/^[0-9a-f]{64}$/.test(sha256)) {
        fail('sha256 必须是 64 位小写 hex', `${path}.sha256`);
    }
    const image =
        obj.image === undefined
            ? undefined
            : (() => {
                  const size = takeObject(obj.image, `${path}.image`);
                  rejectUnknown(size, ['width', 'height'], `${path}.image`);
                  const width = takeNonNegativeInt(size.width, `${path}.image.width`);
                  const height = takeNonNegativeInt(size.height, `${path}.image.height`);
                  if (width === 0 || height === 0) fail('宽高必须为正', `${path}.image`);
                  return { width, height };
              })();
    if (kind === 'dir' && type === 'stored') {
        fail('目录不可能 stored（要么 linked 引用，要么 archive 打包）', `${path}.kind`);
    }

    const base = {
        id: takeNonEmpty(obj.id, `${path}.id`),
        kind: kind as AttachmentKind,
        mime: takeNonEmpty(obj.mime, `${path}.mime`),
        bytes: takeNonNegativeInt(obj.bytes, `${path}.bytes`),
        displayName: takeNonEmpty(obj.displayName, `${path}.displayName`),
        source: source as AttachmentSource,
        createdAt: takeNonNegativeInt(obj.createdAt, `${path}.createdAt`),
        ...(sha256 === undefined ? {} : { sha256 }),
        ...(image === undefined ? {} : { image }),
        ...(obj.origin === undefined ? {} : { origin: parseOrigin(obj.origin, `${path}.origin`) }),
        ...(obj.listing === undefined ? {} : { listing: parseListing(obj.listing, `${path}.listing`) }),
    };

    if (type === 'stored') {
        const relPath = takeNonEmpty(obj.relPath, `${path}.relPath`);
        if (relPath.startsWith('/') || relPath.split(/[/\\]/).includes('..')) {
            fail('relPath 必须是 blobs 内的相对路径', `${path}.relPath`);
        }
        return { ...base, type: 'stored', relPath };
    }
    const absolute = takeNonEmpty(obj.path, `${path}.path`);
    if (!absolute.startsWith('/')) fail('path 必须是绝对路径', `${path}.path`);
    return { ...base, type: 'linked', path: absolute };
}

/** 一批 ref（消息里的 `data.attachments`） */
export function parseAttachmentRefs(value: unknown, path = 'attachments'): AttachmentRef[] {
    if (!Array.isArray(value)) fail(`期望数组，拿到 ${typeof value}`, path);
    return value.map((item, index) => parseAttachmentRef(item, `${path}[${index}]`));
}

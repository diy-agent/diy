// image-size.ts — 从文件头读位图尺寸（只读，不解码）
//
// 为什么要：① UI 要按真实宽高排版（否则缩略图先塌成一条线再跳）；
// ② 模型侧要判「这张太大，得缩」（一张 4000px 截图按原样发，token 与请求体都翻倍）。
//
// 只支持 png / jpeg / gif / webp —— 覆盖截图与网页产物的 99%；HEIC 等认不出就返回
// `undefined`（UI 退化成固定比例的占位），**不猜**。

import type { AttachmentImageSize } from './types.js';

/** JPEG 的段扫描上限：SOF 一般在前几 KB，给 256 KB 足够对付塞了大 EXIF 的照片 */
const JPEG_SCAN_LIMIT = 256 * 1024;

/** 大端读 16 位 */
function be16(bytes: Uint8Array, offset: number): number {
    return ((bytes[offset] ?? 0) << 8) | (bytes[offset + 1] ?? 0);
}

/** 小端读 16 位 */
function le16(bytes: Uint8Array, offset: number): number {
    return ((bytes[offset + 1] ?? 0) << 8) | (bytes[offset] ?? 0);
}

/** 小端读 24 位 */
function le24(bytes: Uint8Array, offset: number): number {
    return (bytes[offset] ?? 0) | ((bytes[offset + 1] ?? 0) << 8) | ((bytes[offset + 2] ?? 0) << 16);
}

function pngSize(bytes: Uint8Array): AttachmentImageSize | undefined {
    // IHDR 紧跟在 8 字节签名 + 4 字节长度 + 4 字节类型之后：宽 16..20、高 20..24
    if (bytes.length < 24) return undefined;
    const width = (be16(bytes, 16) << 16) | be16(bytes, 18);
    const height = (be16(bytes, 20) << 16) | be16(bytes, 22);
    return width > 0 && height > 0 ? { width, height } : undefined;
}

function gifSize(bytes: Uint8Array): AttachmentImageSize | undefined {
    if (bytes.length < 10) return undefined;
    const width = le16(bytes, 6);
    const height = le16(bytes, 8);
    return width > 0 && height > 0 ? { width, height } : undefined;
}

function webpSize(bytes: Uint8Array): AttachmentImageSize | undefined {
    // 三段格式各读各的：VP8X / VP8L / VP8（lossy）
    const chunk = String.fromCharCode(...bytes.subarray(12, 16));
    if (chunk === 'VP8X') {
        const width = le24(bytes, 24) + 1;
        const height = le24(bytes, 27) + 1;
        return { width, height };
    }
    if (chunk === 'VP8L') {
        // 14 位宽 / 14 位高，从 offset 21 起按位打包
        const b0 = bytes[21] ?? 0;
        const b1 = bytes[22] ?? 0;
        const b2 = bytes[23] ?? 0;
        const b3 = bytes[24] ?? 0;
        const width = 1 + (((b1 & 0x3f) << 8) | b0);
        const height = 1 + (((b3 & 0x0f) << 10) | (b2 << 2) | ((b1 & 0xc0) >> 6));
        return { width, height };
    }
    // VP8（lossy）：帧头 0x9d 0x01 0x2a 之后读宽高（各 14 位）
    if (bytes.length >= 30 && (bytes[23] ?? 0) === 0x9d && (bytes[24] ?? 0) === 0x01 && (bytes[25] ?? 0) === 0x2a) {
        const width = le16(bytes, 26) & 0x3fff;
        const height = le16(bytes, 28) & 0x3fff;
        return width > 0 && height > 0 ? { width, height } : undefined;
    }
    return undefined;
}

/** SOF 段（帧头）编码：里面带真实宽高 */
const SOF_MARKERS = new Set([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf]);

function jpegSize(bytes: Uint8Array): AttachmentImageSize | undefined {
    let offset = 2; // 跳过 SOI（FF D8）
    const limit = Math.min(bytes.length, JPEG_SCAN_LIMIT);
    while (offset + 9 < limit) {
        if (bytes[offset] !== 0xff) {
            offset += 1; // 容错：遇到填充字节就往前走
            continue;
        }
        const marker = bytes[offset + 1] ?? 0;
        // 无载荷段：填充(FF) / RST0-7 / SOI / EOI
        if (marker === 0xff) {
            offset += 1;
            continue;
        }
        if (marker === 0xd8 || (marker >= 0xd0 && marker <= 0xd9)) {
            offset += 2;
            continue;
        }
        const length = be16(bytes, offset + 2);
        if (length < 2) return undefined;
        if (SOF_MARKERS.has(marker)) {
            // 段内：精度(1) 高(2) 宽(2)
            const height = be16(bytes, offset + 5);
            const width = be16(bytes, offset + 7);
            return width > 0 && height > 0 ? { width, height } : undefined;
        }
        offset += 2 + length;
    }
    return undefined;
}

/**
 * 读位图尺寸。认不出就 `undefined`（不抛错：尺寸是锦上添花，不该让一次贴图失败）。
 *
 * @param head 文件开头（建议给前 256 KB 以内；JPEG 的 SOF 可能在大 EXIF 之后）
 */
export function imageSizeOf(head: Uint8Array): AttachmentImageSize | undefined {
    if (head.length < 12) return undefined;
    if (head[0] === 0x89 && head[1] === 0x50 && head[2] === 0x4e && head[3] === 0x47) return pngSize(head);
    if (head[0] === 0xff && head[1] === 0xd8) return jpegSize(head);
    if (head[0] === 0x47 && head[1] === 0x49 && head[2] === 0x46) return gifSize(head);
    if (
        head[0] === 0x52 &&
        head[1] === 0x49 &&
        head[2] === 0x46 &&
        head[3] === 0x46 &&
        head[8] === 0x57 &&
        head[9] === 0x45 &&
        head[10] === 0x42 &&
        head[11] === 0x50
    ) {
        return webpSize(head);
    }
    return undefined;
}

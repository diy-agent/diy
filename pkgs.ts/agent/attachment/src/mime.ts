// mime.ts — 字节嗅探：**以内容为准，不听声明**
//
// 为什么必须嗅探（2026-11-26）：附件最常见的两种坏数据是「.png 里装 jpeg」（截图工具 / 导出
// 工具乱起名）和「没有后缀的剪贴板图」。声明错了的后果不是显示难看，而是**上游直接 400**
// （OpenAI 兼容面对 image/png 里塞 jpeg 字节会拒），所以 mime 一律从魔数推；
// 推不出来才退回调用方声明的 mime，再退回后缀表，最后 `application/octet-stream`。
//
// 不做的事：不解析完整文件头（不做 EXIF / 不判是否是合法图片）—— 那是解码器的事。
// 这里只回答「这是什么格式」，够扩展名与模型选择用。

import { extname } from 'node:path';

/** 后缀 → mime（嗅探不出魔数时的兜底；只收常见附件类型，别当 mime 库用） */
const MIME_BY_EXT: Readonly<Record<string, string>> = {
    png: 'image/png',
    jpg: 'image/jpeg',
    jpeg: 'image/jpeg',
    gif: 'image/gif',
    webp: 'image/webp',
    heic: 'image/heic',
    tif: 'image/tiff',
    tiff: 'image/tiff',
    bmp: 'image/bmp',
    svg: 'image/svg+xml',
    pdf: 'application/pdf',
    txt: 'text/plain',
    md: 'text/markdown',
    json: 'application/json',
    csv: 'text/csv',
    yaml: 'application/yaml',
    yml: 'application/yaml',
    zip: 'application/zip',
    gz: 'application/gzip',
    tgz: 'application/gzip',
    tar: 'application/x-tar',
    mp3: 'audio/mpeg',
    wav: 'audio/wav',
    m4a: 'audio/mp4',
    mp4: 'video/mp4',
    mov: 'video/quicktime',
    webm: 'video/webm',
};

/** mime → 落盘用的扩展名（**扩展名由 mime 定，不信用户后缀**） */
const EXT_BY_MIME: Readonly<Record<string, string>> = {
    'image/png': 'png',
    'image/jpeg': 'jpg',
    'image/gif': 'gif',
    'image/webp': 'webp',
    'image/heic': 'heic',
    'image/tiff': 'tiff',
    'image/bmp': 'bmp',
    'image/svg+xml': 'svg',
    'application/pdf': 'pdf',
    'text/plain': 'txt',
    'text/markdown': 'md',
    'application/json': 'json',
    'text/csv': 'csv',
    'application/yaml': 'yaml',
    'application/zip': 'zip',
    'application/gzip': 'tar.gz',
    'application/x-tar': 'tar',
    'audio/mpeg': 'mp3',
    'audio/wav': 'wav',
    'audio/mp4': 'm4a',
    'video/mp4': 'mp4',
    'video/quicktime': 'mov',
    'video/webm': 'webm',
};

/** 判定需要读多少个字节（最长的是 HEIC 的 ftyp 检查，12 字节够） */
const SNIFF_BYTES = 16;

/** 魔数表：能认出就赢，认不出继续往下 */
function sniffByMagic(head: Uint8Array): string | undefined {
    const at = (index: number): number => head[index] ?? -1;
    // PNG：89 50 4E 47 0D 0A 1A 0A
    if (at(0) === 0x89 && at(1) === 0x50 && at(2) === 0x4e && at(3) === 0x47) return 'image/png';
    // JPEG：FF D8 FF
    if (at(0) === 0xff && at(1) === 0xd8 && at(2) === 0xff) return 'image/jpeg';
    // GIF：GIF8
    if (at(0) === 0x47 && at(1) === 0x49 && at(2) === 0x46 && at(3) === 0x38) return 'image/gif';
    // RIFF....WEBP
    if (
        at(0) === 0x52 &&
        at(1) === 0x49 &&
        at(2) === 0x46 &&
        at(3) === 0x46 &&
        at(8) === 0x57 &&
        at(9) === 0x45 &&
        at(10) === 0x42 &&
        at(11) === 0x50
    ) {
        return 'image/webp';
    }
    // PDF：%PDF
    if (at(0) === 0x25 && at(1) === 0x50 && at(2) === 0x44 && at(3) === 0x46) return 'application/pdf';
    // ZIP：PK\x03\x04（docx / xlsx 也走这里 —— 不去细分，附件层不关心）
    if (at(0) === 0x50 && at(1) === 0x4b && at(2) === 0x03 && at(3) === 0x04) return 'application/zip';
    // gzip：1F 8B
    if (at(0) === 0x1f && at(1) === 0x8b) return 'application/gzip';
    // BMP：BM
    if (at(0) === 0x42 && at(1) === 0x4d) return 'image/bmp';
    // TIFF：II*\0 / MM\0*
    if (at(0) === 0x49 && at(1) === 0x49 && at(2) === 0x2a) return 'image/tiff';
    if (at(0) === 0x4d && at(1) === 0x4d && at(2) === 0x00 && at(3) === 0x2a) return 'image/tiff';
    // HEIC / HEIF：offset 4 = 'ftyp'，brand 在 8..12
    if (at(4) === 0x66 && at(5) === 0x74 && at(6) === 0x79 && at(7) === 0x70) {
        const brand = String.fromCharCode(...head.subarray(8, 12));
        if (brand.startsWith('hei') || brand === 'mif1' || brand === 'msf1') return 'image/heic';
        if (brand === 'isom' || brand === 'iso2' || brand === 'mp41') return 'video/mp4';
        if (brand.startsWith('qt')) return 'video/quicktime';
    }
    return undefined;
}

/** 文本类兜底：SVG 是 XML，魔数嗅不出来，只能看开头几个字符 */
function sniffByText(head: Uint8Array): string | undefined {
    const text = new TextDecoder('utf-8', { fatal: false }).decode(head).trimStart();
    if (text.startsWith('<?xml') || text.startsWith('<svg')) {
        return text.includes('<svg') ? 'image/svg+xml' : undefined;
    }
    return undefined;
}

/** 文件名后缀 → mime（兜底） */
export function mimeOfPath(path: string): string | undefined {
    const ext = extname(path).replace(/^\./, '').toLowerCase();
    if (ext === '') return undefined;
    // .tar.gz 这类双后缀先看全
    if (path.toLowerCase().endsWith('.tar.gz')) return 'application/gzip';
    return MIME_BY_EXT[ext];
}

/**
 * 判一批字节的 mime。
 *
 * @param head      文件开头（至少 16 字节；短文件给全部即可）
 * @param declared  调用方声明的 mime（嗅探失败才用）
 * @param name      文件名（声明的 mime 也没有时按后缀兜底）
 */
export function sniffMime(head: Uint8Array, declared?: string, name?: string): string {
    const magic = sniffByMagic(head.subarray(0, SNIFF_BYTES));
    if (magic !== undefined) return magic;
    const text = sniffByText(head.subarray(0, SNIFF_BYTES));
    if (text !== undefined) return text;
    if (declared !== undefined && declared !== '' && declared !== 'application/octet-stream') return declared;
    return (name === undefined ? undefined : mimeOfPath(name)) ?? 'application/octet-stream';
}

/** 落盘扩展名：mime 说了算；不认识的 mime 走 `bin`（**不用用户后缀**，它骗人） */
export function extOfMime(mime: string): string {
    return EXT_BY_MIME[mime] ?? 'bin';
}

/** 是不是可看图片（== 唯一会进模型 content 的那一类） */
export function isImageMime(mime: string): boolean {
    return mime.startsWith('image/') && mime !== 'image/svg+xml';
}

// tests/format.test.ts — 名归一 / mime 嗅探 / 尺寸解析（三件纯函数的硬事实）
//
// 这三件都是「用户随手丢个文件进来」时最先出事的地方：名字带路径、后缀骗人、
// 剪贴板图没有名字。纯函数 ⇒ 直接喂反例，不需要碰磁盘。

import { describe, expect, it } from 'vitest';

import { extOfMime, fileNameOf, imageSizeOf, isImageMime, sniffMime, sanitizeStem, splitName } from '../src/index.js';
import { gifBytes, jpegBytes, pngBytes } from './fixtures.js';

describe('sanitizeStem（磁盘名归一）', () => {
    it('只取最后一段：路径不可能逃出批次目录', () => {
        expect(sanitizeStem('../../etc/passwd', 'x')).toBe('passwd');
        expect(sanitizeStem('/etc/passwd', 'x')).toBe('passwd');
        // 中段不管扩展名（扩展名由 mime 定，拆名是 fileNameOf 的事）
        expect(sanitizeStem('a/b/c.png', 'x')).toBe('c.png');
        expect(sanitizeStem('..', 'x')).toBe('x');
        expect(sanitizeStem('', 'x')).toBe('x');
        expect(sanitizeStem(undefined, 'paste')).toBe('paste');
    });

    it('非法字符替换、前导点去掉（隐藏文件不该藏在批次目录里）', () => {
        expect(sanitizeStem('.env', 'x')).toBe('env');
        expect(sanitizeStem('a:b*c?d"e<f>g|h', 'x')).toBe('a_b_c_d_e_f_g_h');
        expect(sanitizeStem('换\n行', 'x')).toBe('换_行');
    });

    it('中文名按字节截断（不切坏多字节字符）', () => {
        const long = '财'.repeat(60); // 180 字节
        const stem = sanitizeStem(long, 'x');
        expect(Buffer.byteLength(stem, 'utf8')).toBeLessThanOrEqual(80);
        expect(stem.length).toBeGreaterThan(0);
        expect(stem).toBe('财'.repeat(26)); // 3 字节/字 ⇒ 26 字 = 78 字节，第 27 字会超
    });

    it('尾部空格 / 前后空白折掉', () => {
        expect(sanitizeStem('  报告.pdf  ', 'x')).toBe('报告.pdf');
        expect(sanitizeStem('   ', 'x')).toBe('x');
    });
});

describe('splitName / fileNameOf', () => {
    it('拆中段与后缀（`.env` 的 dot 不算扩展名）', () => {
        expect(splitName('a.b.png')).toEqual({ stem: 'a.b', ext: 'png' });
        expect(splitName('.env')).toEqual({ stem: '.env', ext: '' });
        expect(splitName('a/b/noext')).toEqual({ stem: 'noext', ext: '' });
    });

    it('NN 补两位保序；扩展名用 mime 的、不用原名的', () => {
        expect(fileNameOf(1, 'shot.png', 'png')).toBe('01-shot.png');
        expect(fileNameOf(12, 'shot.png', 'jpg')).toBe('12-shot.jpg');
        expect(fileNameOf(3, undefined, 'png')).toBe('03-paste.png');
        expect(fileNameOf(4, '../../evil.png', 'png')).toBe('04-evil.png');
    });
});

describe('sniffMime（以内容为准）', () => {
    it('认得出 png / jpeg / gif / pdf / zip / gzip', () => {
        expect(sniffMime(pngBytes())).toBe('image/png');
        expect(sniffMime(jpegBytes())).toBe('image/jpeg');
        expect(sniffMime(gifBytes())).toBe('image/gif');
        expect(sniffMime(Uint8Array.from([0x25, 0x50, 0x44, 0x46]))).toBe('application/pdf');
        expect(sniffMime(Uint8Array.from([0x50, 0x4b, 0x03, 0x04]))).toBe('application/zip');
        expect(sniffMime(Uint8Array.from([0x1f, 0x8b, 8, 0]))).toBe('application/gzip');
    });

    it('SVG 是文本，靠开头几个字符认', () => {
        const svg = new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg"></svg>');
        expect(sniffMime(svg)).toBe('image/svg+xml');
    });

    it('嗅不出来 ⇒ 声明的 mime ⇒ 后缀 ⇒ octet-stream', () => {
        const junk = Uint8Array.from([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16]);
        expect(sniffMime(junk, 'text/csv')).toBe('text/csv');
        expect(sniffMime(junk, undefined, 'notes.md')).toBe('text/markdown');
        expect(sniffMime(junk)).toBe('application/octet-stream');
        // 声明了 octet-stream 等于没声明 —— 仍然按后缀试一次
        expect(sniffMime(junk, 'application/octet-stream', 'a.json')).toBe('application/json');
    });

    it('扩展名由 mime 定；不认识的给 bin', () => {
        expect(extOfMime('image/png')).toBe('png');
        expect(extOfMime('image/jpeg')).toBe('jpg');
        expect(extOfMime('application/gzip')).toBe('tar.gz');
        expect(extOfMime('application/x-weird')).toBe('bin');
    });

    it('svg 不算「可看图片」（上游不接受 svg 当 image part）', () => {
        expect(isImageMime('image/png')).toBe(true);
        expect(isImageMime('image/svg+xml')).toBe(false);
    });
});

describe('imageSizeOf', () => {
    it('png / jpeg / gif 读得出真实宽高', () => {
        expect(imageSizeOf(pngBytes(1440, 900))).toEqual({ width: 1440, height: 900 });
        expect(imageSizeOf(jpegBytes(1920, 1080))).toEqual({ width: 1920, height: 1080 });
        expect(imageSizeOf(gifBytes(320, 200))).toEqual({ width: 320, height: 200 });
    });

    it('认不出就 undefined（不猜、不抛）', () => {
        expect(imageSizeOf(Uint8Array.from([1, 2, 3]))).toBeUndefined();
        expect(imageSizeOf(Uint8Array.from([0x89, 0x50, 0x4e, 0x47]))).toBeUndefined(); // 截断的 png
    });
});

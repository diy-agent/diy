// media-scrub.test.ts —— 落库前把图片字节换成一行说明
//
// 为什么这条要钉死：模型看图和「db 别长胖」是两件事。工具结果里的字节必须
// 送到模型眼前（ai-sdk 负责），但**不能**顺着事件 / transcript 落进 db ——
// 一张 1 MB 截图 base64 后 1.33 MB，看三张就 4 MB，而且是永久的。

import { describe, expect, it } from 'vitest';

import { mediaNoteOf, scrubMedia } from '../src/media-scrub';

const BYTES = new Uint8Array([0x89, 0x50, 0x4e, 0x47]);

const FILE_PART = {
    type: 'file',
    data: { type: 'data', data: BYTES },
    mediaType: 'image/png',
    filename: 'shot.png',
};

describe('scrubMedia', () => {
    it('ai-sdk 的媒体 part ⇒ 一行说明（字节不落库）', () => {
        const out = scrubMedia({ type: 'content', value: [{ type: 'text', text: '看一眼' }, FILE_PART] }) as {
            value: Array<{ type: string; text?: string }>;
        };
        expect(out.value).toHaveLength(2);
        expect(out.value[0]).toEqual({ type: 'text', text: '看一眼' });
        expect(out.value[1]?.type).toBe('text');
        expect(out.value[1]?.text).toContain('shot.png');
        expect(out.value[1]?.text).toContain('image/png');
        expect(JSON.stringify(out)).not.toContain('"data":{"type":"data"');
    });

    it('包在别的结构里（messages / output）也照样剥', () => {
        const out = scrubMedia([
            { role: 'tool', content: [{ type: 'tool-result', output: { type: 'content', value: [FILE_PART] } }] },
        ]);
        expect(JSON.stringify(out)).not.toContain('"type":"file"');
        expect(JSON.stringify(out)).toContain('shot.png');
    });

    it('普通结果原样保留（工具入参里的 path / name 不是媒体 part）', () => {
        const input = { ok: true, path: '/tmp/a.png', name: 'a.png', items: [1, 2] };
        expect(scrubMedia(input)).toEqual(input);
    });

    it('没有 filename 也给得出说明', () => {
        expect(mediaNoteOf(undefined, undefined)).toContain('附件');
    });
});

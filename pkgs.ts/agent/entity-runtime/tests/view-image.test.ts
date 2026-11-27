// view-image.test.ts —— 「自己截图自己看」的工具契约
//
// 它要成立的是三件事：
//   ① 真图片 ⇒ 返回 `{type:'content'}`，里面是 text + file part（模型同一步就能看见）
//   ② 不是图片 / 文件不存在 / 太大 ⇒ **响亮报错**（别塞给上游换一个 400）
//   ③ 工具集里真的有它（不然模型还是会去 bash+curl —— 那条路实测过）

import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, describe, expect, it } from 'vitest';

import { buildRoomTools } from '../src/tools/index';
import { viewImageTool } from '../src/tools/view-image';

/** 6×4 的 PNG 头（够嗅探 + 读尺寸） */
function pngBytes(width = 6, height = 4): Uint8Array {
    const be32 = (value: number): number[] => [
        (value >>> 24) & 0xff,
        (value >>> 16) & 0xff,
        (value >>> 8) & 0xff,
        value & 0xff,
    ];
    return Uint8Array.from([
        0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
        0, 0, 0, 0x0d,
        0x49, 0x48, 0x44, 0x52,
        ...be32(width),
        ...be32(height),
        8, 6, 0, 0, 0,
        0, 0, 0, 0,
    ]);
}

const dir = await mkdtemp(join(tmpdir(), 'diy2-view-'));
afterAll(() => rm(dir, { recursive: true, force: true }));

const tool = viewImageTool();
/** ai-sdk 的 tool.execute 类型很宽（可能返回异步迭代器等），测试里断言时收窄 */
const execute = tool.execute as unknown as (input: { path: string; question?: string }) => Promise<{
    type: string;
    value: Array<{ type: string; text?: string; mediaType?: string; filename?: string }>;
}>;

describe('view_image', () => {
    it('图片 ⇒ content（text + file part），问句原样带上', async () => {
        const path = join(dir, 'shot.png');
        await writeFile(path, pngBytes(1440, 900));

        const out = await execute({ path, question: '图里写了什么？' });
        expect(out.type).toBe('content');
        expect(out.value[0]).toEqual({ type: 'text', text: '图里写了什么？' });
        expect(out.value[1]).toMatchObject({ type: 'file', mediaType: 'image/png', filename: 'shot.png' });
    });

    it('不传问句也有说明（模型不会收到一张"无来由"的图）', async () => {
        const path = join(dir, 'bare.png');
        await writeFile(path, pngBytes());
        const out = await execute({ path });
        expect(out.value[0]?.text).toContain('bare.png');
    });

    it('不是图片 / 不存在 ⇒ 报错（不塞给上游）', async () => {
        const text = join(dir, 'note.txt');
        await writeFile(text, 'hello');
        await expect(execute({ path: text })).rejects.toThrow(/不是图片/);
        await expect(execute({ path: join(dir, 'missing.png') })).rejects.toThrow(/没有这个文件/);
    });
});

describe('工具集', () => {
    it('房间里有 view_image（不然模型只能去 bash+curl）', () => {
        const tools = buildRoomTools({ cwd: dir, shell: false });
        expect(Object.keys(tools)).toContain('view_image');
    });
});

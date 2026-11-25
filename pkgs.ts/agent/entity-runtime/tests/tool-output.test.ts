// tool-output.test.ts —— 投递层截断（toModelOutput）：预算 / marker / 原文落盘 / bash 头的 truncated 位
//
// 这一层的存在理由（2026-11-25 实测）：模型一步 `grep -rn` 撞上 4.5MB 的 sourcemap，
// 原文直接进这一轮请求 ⇒ context_length_exceeded，而压缩只管轮首，轮内够不着。
// 所以断言的重点不是"裁剪算法好不好看"，而是**超大输出进模型前一定被收住，且原文可回取**。

import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { TOOL_OUTPUT_MAX_LINES } from '@diy-agent/tools';
import { afterEach, describe, expect, it } from 'vitest';

import { createToolOutputCapper, toolOutDir } from '../src/tool-output';

const dirs: string[] = [];
async function homeOf(): Promise<string> {
    const dir = await mkdtemp(path.join(tmpdir(), 'diy2-toolout-'));
    dirs.push(dir);
    return dir;
}

afterEach(async () => {
    await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

function lines(n: number): string {
    return Array.from({ length: n }, (_, i) => `line ${i + 1}`).join('\n');
}

describe('createToolOutputCapper：未超限即逐字符原样', () => {
    it('小输出不动（不归一、不加 marker、不落盘）', async () => {
        const home = await homeOf();
        const cap = createToolOutputCapper({ home });
        const text = 'hello\nworld';
        expect(await cap(text, 'call_small')).toBe(text);
    });

    it('刚好 2000 行不裁（预算是上限，不是阈值）', async () => {
        const home = await homeOf();
        const cap = createToolOutputCapper({ home });
        const text = lines(TOOL_OUTPUT_MAX_LINES);
        expect(await cap(text, 'call_edge')).toBe(text);
    });
});

describe('createToolOutputCapper：超限 ⇒ 头尾 + marker + 原文落盘', () => {
    it('超限才裁：多 1 行仍会生成 marker 与落盘（净长度可能略长，不算问题）', async () => {
        const home = await homeOf();
        const cap = createToolOutputCapper({ home });
        const text = lines(TOOL_OUTPUT_MAX_LINES + 1);
        const out = await cap(text, 'call_over');

        expect(out).not.toBe(text);
        const orig = path.join(toolOutDir(home)!, 'call_over.txt');
        expect(out).toContain(orig); // marker 的 resume 就是它
        expect(await readFile(orig, 'utf8')).toBe(text); // 落的是**全文**
    });

    it('大输出确实收敛：头尾保留、中段省略', async () => {
        const home = await homeOf();
        const cap = createToolOutputCapper({ home });
        const text = lines(5000);
        const out = await cap(text, 'call_big');

        expect(out.length).toBeLessThan(text.length / 2);
        expect(out).toContain('line 1\n');
        expect(out).toContain('line 5000');
        expect(out).not.toContain('line 2500');
    });

    it('工具 id 里的特殊字符归一成合法文件名（不逃出 toolout 目录）', async () => {
        const home = await homeOf();
        const cap = createToolOutputCapper({ home });
        await cap(lines(TOOL_OUTPUT_MAX_LINES + 5), '../../etc/passwd');
        const out = await cap(lines(TOOL_OUTPUT_MAX_LINES + 5), 'call_a/b:c');
        expect(out).toContain(path.join(toolOutDir(home)!, 'call_a_b_c.txt'));
    });

    it('home 未知：只裁不落盘（marker 里没有 resume，绝不假装取得到）', async () => {
        const cap = createToolOutputCapper();
        const text = lines(5000);
        const out = await cap(text, 'call_nohome');
        expect(out.length).toBeLessThan(text.length);
        expect(out).not.toContain('resume=');
    });
});

describe('createToolOutputCapper：bash 结果头的 truncated 位', () => {
    const head = (flags: string) => [`---\nok: true\nexit_code: 0\ntruncated: ${flags}\ncwd: /x\n---`, lines(5000)].join('\n');

    it('真截断时把头里的 truncated: false 改写成 true（模型据此知道源级输出也不全）', async () => {
        const home = await homeOf();
        const cap = createToolOutputCapper({ home });
        const out = await cap(head('false'), 'call_bash_big');
        expect(out).toContain('truncated: true');
        expect(out).not.toContain('truncated: false');
    });

    it('未截断时头原样（不误报）', async () => {
        const home = await homeOf();
        const cap = createToolOutputCapper({ home });
        const small = '---\nok: true\ntruncated: false\n---\nhi';
        expect(await cap(small, 'call_bash_small')).toBe(small);
    });
});

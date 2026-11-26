// vision.probe.test.ts —— 「自己截图自己看」的验收探针（**默认不跑**，要显式开）
//
// 为什么是探针而不是普通测试：它做的是**真事** —— 起无头浏览器渲染一张带文字的图、
// 把 PNG 当附件发给真模型、看模型能不能把字念回来。跑它 = 花真钱、连真网、依赖本机有 Chrome。
// 所以缺省 `describe.skip`，靠 `VISION_PROBE=1` 打开：
//
//   VISION_PROBE=1 npx vitest run tests/vision.probe.test.ts
//
// 它证明的东西恰好是这条任务的目标：**截图能力 + 图进模型的链路合起来是通的**。
// 单元测试只能证明「messages 里出现了 file part」，证明不了「模型真的看见了」——
// 而后者才是用户要的。
//
// 图的内容由我们自己渲染（不用 `screencapture` 截屏）：截屏会把用户屏幕上的隐私内容
// 发给上游模型，那不是我该替用户决定的事。

import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

import { generateText } from 'ai';
import { describe, expect, it } from 'vitest';

import { modelOf } from '../src/providers';

const run = promisify(execFile);

/** 图里写的字（模型要把它念回来） */
const SECRET = '蓝鲸 42';
/** 探针用的模型：本机目录里标了收图的那个（key 在 `~/.diy/model.yaml`） */
const MODEL_KEY = process.env['VISION_PROBE_MODEL'] ?? 'chen56@deepseek/deepseek-v4-flash-vision-exp';

/** 用本机 Chrome 无头渲染一张 PNG（内容完全可控，不碰用户的屏幕） */
async function renderPng(html: string): Promise<Uint8Array> {
    const dir = await mkdtemp(join(tmpdir(), 'diy2-vision-'));
    const page = join(dir, 'probe.html');
    const shot = join(dir, 'probe.png');
    const { writeFile } = await import('node:fs/promises');
    await writeFile(page, html, 'utf-8');
    try {
        await run(
            '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
            [
                '--headless=new',
                '--disable-gpu',
                '--hide-scrollbars',
                '--window-size=640,360',
                `--screenshot=${shot}`,
                `file://${page}`,
            ],
            { timeout: 60_000 },
        );
        return new Uint8Array(await readFile(shot));
    } finally {
        await rm(dir, { recursive: true, force: true });
    }
}

describe.skipIf(process.env['VISION_PROBE'] !== '1')('图真的到模型眼前（验收探针）', () => {
    it('渲染一张图 → 当附件发给视觉模型 → 它把图里的字念回来', async () => {
        const png = await renderPng(
            `<!doctype html><html><body style="margin:0;display:flex;align-items:center;justify-content:center;height:100vh;font:600 56px -apple-system,'PingFang SC',sans-serif;background:#fff;color:#111">
               <div>项目代号：${SECRET}</div>
             </body></html>`,
        );
        expect(png.byteLength).toBeGreaterThan(1000);

        const model = modelOf(MODEL_KEY);
        const result = await generateText({
            model,
            messages: [
                {
                    role: 'user',
                    content: [
                        { type: 'text', text: '图里写的是什么？只回答图上的文字本身。' },
                        { type: 'file', mediaType: 'image/png', data: png, filename: 'probe.png' },
                    ],
                },
            ],
            // 视觉模型多是 reasoning 系：上限给小了会被思考过程吃光（实测 64 时 text 为空）
            maxOutputTokens: 2048,
        });

        // 失败时这几行是唯一线索：
        //   · text 为空 + finishReason='length' ⇒ 多半是**上限被 reasoning 吃光**（不是图没到）
        //   · inputTokens 只有几十 ⇒ 大概率图没送到（prompt 里只有问题文本）
        console.log('[probe]', JSON.stringify({ finishReason: result.finishReason, usage: result.usage, text: result.text }));

        // 不比对整句话（模型爱加引号 / 前缀），只要求关键字都在 —— 这就是「看见了」
        expect(result.text).toContain('蓝鲸');
        expect(result.text).toContain('42');
    }, 120_000);
});

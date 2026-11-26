// tools/view-image.ts —— 「自己截图自己看」的入口：**把本地图片给模型看**。
//
// 为什么必须是一个工具，而不是让模型自己想办法：
//   实测（2026-11-26，用户让 diy 测图片能力）：它 `screencapture` 截了图之后**看不到它** ——
//   工具产出的图进不了自己的上下文，于是它转头用 `bash` + `curl` 去调模型 raw API，
//   自己拼一份 `messages` 把 base64 塞进去。链路绕开整个 diy2，token 花了两遍，
//   人还看不到它到底测了哪张图。
//
// ai-sdk 的工具结果本来就支持带内容（`{ type:'content', value:[text, file] }`）：
// 模型在**同一个 step** 里就能看见这张图。所以这里只做两件事 —— 读文件、判 mime，
// 然后把字节交回给 SDK。落库那一侧由 `media-scrub.ts` 把字节换成一行说明
// （transcript 会进快照，1 MB 的截图不该在 db 里存成 base64）。

import { readFile, stat } from 'node:fs/promises';
import { basename } from 'node:path';

import { tool } from 'ai';
import { z } from 'zod';

import { sniffMime } from '@diy-agent/attachment';

/** 单张图的上限：再大就该先缩图（模型端也会自己缩，但传输与 db 记录都吃不消） */
const MAX_IMAGE_BYTES = 8 * 1024 * 1024;

export function viewImageTool() {
    return tool({
        description:
            '看一眼本地图片（截图 / 照片 / 图表）—— 把图片内容直接给模型看。' +
            '「自己截图自己看」就用它：先 screencapture 出 PNG，再用本工具打开。' +
            '不要用 bash + curl 去调模型 API 看图（那条路绕开了对话上下文，且白花 token）。',
        inputSchema: z.object({
            path: z.string().min(1).describe('图片文件路径（png / jpg / gif / webp）'),
            question: z.string().optional().describe('想从图里得到什么（没有就只说"看一眼"）'),
        }),
        execute: async ({ path, question }) => {
            const info = await stat(path).catch(() => undefined);
            if (info === undefined) throw new Error(`没有这个文件：${path}`);
            if (!info.isFile()) throw new Error(`不是文件：${path}`);
            if (info.size === 0) throw new Error(`文件是空的：${path}`);
            if (info.size > MAX_IMAGE_BYTES) {
                throw new Error(`图太大（${(info.size / 1024 / 1024).toFixed(1)} MB > 8 MB）：先缩一张再看`);
            }
            const bytes = new Uint8Array(await readFile(path));
            const mime = sniffMime(bytes);
            if (!mime.startsWith('image/')) {
                // 视频 / pdf 不在这里装作能看：模型端多数不收，塞进去只会换来一个 400
                throw new Error(`${path} 不是图片（嗅探到 ${mime}）—— 只支持图片`);
            }
            return {
                type: 'content' as const,
                value: [
                    {
                        type: 'text' as const,
                        text: question === undefined || question === '' ? `看一眼这张图：${basename(path)}` : question,
                    },
                    {
                        type: 'file' as const,
                        data: { type: 'data' as const, data: bytes },
                        mediaType: mime,
                        filename: basename(path),
                    },
                ],
            };
        },
    });
}

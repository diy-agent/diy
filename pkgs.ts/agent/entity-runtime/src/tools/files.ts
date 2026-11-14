// tools/files.ts —— 文件工具（read / write / edit）：从 @diy-agent/tools 移植的**精简版**。
//
// 为什么移植而不是直接依赖：那个包的构建产物（dist/）在本仓的 build 图里有断链，
// 而 diy2 是 tsx 直跑源码。移植版保留它的三条判据：
//   1. 路径必须落在房间目录内（越界直接抛）
//   2. 失败 **抛异常**（tool-error → UI 画 ✗），不返回"失败字符串"
//   3. edit 必须唯一命中（除非 replaceAll），改几行不要重写整个文件
//
// 等 build 图修好、或 diy2 需要更完整的窗口/diff 语义时，再换回 @diy-agent/tools。

import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, relative, resolve } from 'node:path';

import { tool, type ToolSet } from 'ai';
import { z } from 'zod';

const READ_MAX_LINES = 2000;
const READ_MAX_BYTES = 200_000;
const WRITE_MAX_BYTES = 400_000;
const SHELL_OUTPUT_MAX = 100_000;

/** 解析到房间目录内；越界抛错（软链不追，够用） */
function inside(cwd: string, filePath: string): string {
    const abs = isAbsolute(filePath) ? resolve(filePath) : resolve(cwd, filePath);
    const rel = relative(cwd, abs);
    if (rel.startsWith('..') || isAbsolute(rel)) throw new Error(`[越界] ${filePath} 不在房间目录 ${cwd} 内`);
    return abs;
}

function clip(text: string, max = SHELL_OUTPUT_MAX): string {
    return text.length <= max ? text : `${text.slice(0, max)}\n…（输出已截断，共 ${text.length} 字符）`;
}

export function readTool(cwd: string): ToolSet[string] {
    return tool({
        description:
            '读取文件的文本内容（带行号；相对路径按房间目录解析）。' +
            `单次最多 ${READ_MAX_LINES} 行 / ${Math.round(READ_MAX_BYTES / 1024)}KB；` +
            '超限时末尾会给出下一段 offset —— 用 offset 继续读，不要重复读同一段。',
        inputSchema: z.object({
            path: z.string().describe('文件路径'),
            offset: z.number().optional().describe('起始行，1-based（缺省 1）'),
            limit: z.number().optional().describe(`最大行数（缺省 ${READ_MAX_LINES}）`),
        }),
        execute: async ({ path: filePath, offset, limit }) => {
            const abs = inside(cwd, filePath);
            const info = await stat(abs).catch((error: unknown) => {
                throw new Error(`[读取失败] ${error instanceof Error ? error.message : String(error)}`);
            });
            if (info.isDirectory()) throw new Error(`[读取失败] ${filePath} 是目录`);
            if (info.size > READ_MAX_BYTES) throw new Error(`[读取失败] 文件 ${info.size} 字节，超过上限 ${READ_MAX_BYTES}`);

            const text = await readFile(abs, 'utf8');
            const lines = text.split('\n');
            const start = Math.max(1, offset ?? 1);
            const count = Math.max(1, Math.min(limit ?? READ_MAX_LINES, READ_MAX_LINES));
            const slice = lines.slice(start - 1, start - 1 + count);
            const body = slice.map((line, index) => `${start + index}\t${line}`).join('\n');
            const end = start - 1 + slice.length;
            const rest = lines.length - end;
            const tail = rest > 0 ? `\n\n… 还有 ${rest} 行，用 offset=${end + 1} 继续` : '';
            return `${filePath}（共 ${lines.length} 行）\n${body}${tail}`;
        },
    });
}

export function writeTool(cwd: string): ToolSet[string] {
    return tool({
        description:
            '整文件写入（新建或覆盖；相对路径按房间目录解析；父目录不存在会自动创建）。' +
            '改几行不要用本工具重写整个文件 —— 用 edit。',
        inputSchema: z.object({
            path: z.string().describe('文件路径'),
            content: z.string().describe('完整文件内容'),
        }),
        execute: async ({ path: filePath, content }) => {
            if (Buffer.byteLength(content, 'utf8') > WRITE_MAX_BYTES) throw new Error(`[写入失败] 内容超过上限 ${WRITE_MAX_BYTES} 字节`);
            const abs = inside(cwd, filePath);
            const before = await readFile(abs, 'utf8').catch(() => undefined);
            await mkdir(dirname(abs), { recursive: true });
            await writeFile(abs, content, 'utf8');
            const after = content.split('\n').length;
            if (before === undefined) return `已创建 ${filePath}（${after} 行）`;
            const old = before.split('\n').length;
            return `已写入 ${filePath}（${old} 行 → ${after} 行）`;
        },
    });
}

export function editTool(cwd: string): ToolSet[string] {
    return tool({
        description:
            '对**单个已存在的文件**做局部替换（改几行用它，不要用 write 重写整份）。' +
            'edits 是有序的：后一条基于前一条的结果匹配。每条 oldText 必须逐字来自文件且唯一命中；' +
            '确实要全改就传 replaceAll: true。',
        inputSchema: z.object({
            path: z.string().describe('目标文件路径'),
            edits: z
                .array(
                    z.object({
                        oldText: z.string().describe('要替换的原文（必须唯一命中，除非 replaceAll）'),
                        newText: z.string().describe('替换成什么（空串 = 删除）'),
                        replaceAll: z.boolean().optional(),
                    }),
                )
                .describe('有序的替换列表'),
        }),
        execute: async ({ path: filePath, edits }) => {
            const abs = inside(cwd, filePath);
            const original = await readFile(abs, 'utf8').catch((error: unknown) => {
                throw new Error(`[编辑失败] ${error instanceof Error ? error.message : String(error)}`);
            });
            let text = original;
            const notes: string[] = [];
            for (const [index, edit] of edits.entries()) {
                const hits = text.split(edit.oldText).length - 1;
                if (hits === 0) throw new Error(`[编辑失败] 第 ${index + 1} 条 oldText 未命中`);
                if (hits > 1 && edit.replaceAll !== true) {
                    throw new Error(`[编辑失败] 第 ${index + 1} 条 oldText 命中 ${hits} 处；要全改请传 replaceAll`);
                }
                text = edit.replaceAll === true ? text.split(edit.oldText).join(edit.newText) : text.replace(edit.oldText, edit.newText);
                notes.push(`第 ${index + 1} 条：替换 ${hits} 处`);
            }
            await writeFile(abs, text, 'utf8');
            const before = original.split('\n').length;
            const after = text.split('\n').length;
            return `${filePath} 已更新（${before} 行 → ${after} 行）\n${notes.join('\n')}`;
        },
    });
}

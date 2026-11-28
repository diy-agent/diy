// output-store.ts —— 工具输出**原文**落在库外（2026-11-28）。
//
// 起因：`diy2.db` 243MB，其中 186MB 是 `entity_items`，而 `tool` 条目独占 144MB
// （5 条 ≥4MB 的输出吃掉了 60MB，最大单条 31MB）。这些东西**没有任何查询价值**：
// 界面上要的是「跑了什么、成没成、最后几行」，模型要的是「头尾 + 需要时自己 read 回取」。
//
// 两条判据（不要发明第三条）：
//   · `data.result` 有值    ⇒ 老数据 / 小输出，正文就在条目里；
//   · `data.output` 有值    ⇒ 正文在文件里（`ref` 相对数据根）。
//
// 落盘位置：`<数据根>/runs/tool/<YYYY-MM-DD>/<roomId>/<toolCallId>.txt`
//   · 按日分区 —— GC 天然是「删 N 天前的目录」，不用扫全库；
//   · 按房间分一层 —— 删房间时整目录带走（现在删房间，`toolout/` 里的文件没人清）。
//
// 写盘失败**不假装成功**：返回 undefined，调用方退回把截断版存进 `data.result`（不带 ref），
// 模型至少知道被裁了、这次取不回原文 —— 与 `tool-output.ts` 已有的失败处置一致。

import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import type { ToolOutputRef } from '@diy-agent/protocol';
import { TOOL_OUTPUT_MAX_BYTES } from '@diy-agent/tools';

/** 超过这个字节数才外置 —— 与投递层同一个阈值（`limits.ts` 的 64KB） */
export const OUTPUT_OFFLOAD_BYTES = TOOL_OUTPUT_MAX_BYTES;

/** 预览每段最多这么多字符（防「一行 2MB」把 preview 自己变成大字段） */
const PREVIEW_MAX_CHARS = 8000;
const PREVIEW_LINES = 40;

/** 文件名里只留 `[A-Za-z0-9_.-]`（与 `session-file.ts` / `tool-output.ts` 同一套规矩） */
export function safeName(value: string): string {
    return value.replace(/[^\w.-]+/g, '_');
}

/**
 * 工具输出原文的**相对数据根**路径（投影层与投递层共用这一个函数 —— 两边路径不一致
 * 就会把同一份原文写两遍，那正是这轮要消掉的问题）。
 */
export function toolOutputRelPath(roomId: string, at: number, toolCallId: string): string {
    return ['runs', 'tool', dayOf(at), safeName(roomId), `${safeName(toolCallId)}.txt`].join('/');
}

/** `<YYYY-MM-DD>`（**本地时区**：人看的日期，不是 UTC 分片） */
function dayOf(at: number): string {
    const d = new Date(at);
    const pad = (n: number): string => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** 数行数而不 split（30MB 文本 split 出 80 万个元素，纯浪费内存） */
function countLines(text: string): number {
    let lines = 1;
    for (let i = 0; i < text.length; i += 1) if (text.charCodeAt(i) === 10) lines += 1;
    return lines;
}

/** 头尾各 40 行；单行过长时整体截到 PREVIEW_MAX_CHARS */
function previewOf(text: string): { head: string; tail: string } {
    const clip = (s: string): string => (s.length > PREVIEW_MAX_CHARS ? `${s.slice(0, PREVIEW_MAX_CHARS)}…` : s);
    const lines = text.split('\n');
    if (lines.length <= PREVIEW_LINES * 2) {
        const whole = clip(text);
        return { head: whole, tail: '' };
    }
    return {
        head: clip(lines.slice(0, PREVIEW_LINES).join('\n')),
        tail: clip(lines.slice(-PREVIEW_LINES).join('\n')),
    };
}

/** 数据根为 undefined（`:memory:` 库）⇒ 不外置，一切留在条目里 */
export function createOutputStore(options: { readonly dataRoot?: string }): {
    /**
     * 存一条工具输出：超阈值 → 写文件并返回 ref；没超 / 写失败 / 没有数据根 → undefined。
     * `roomId` / `at` 只影响放哪（分区与归属），不参与判据。
     */
    put(roomId: string, at: number, toolCallId: string, text: string): ToolOutputRef | undefined;
    /** ref → 绝对路径（读取端用；不校验是否越界 —— 调用方只该传自己存下来的 ref） */
    absolute(path: string): string | undefined;
} {
    const root = options.dataRoot;
    const absolute = (ref: string): string | undefined => (root === undefined ? undefined : join(root, ref));

    return {
        absolute,
        put(roomId, at, toolCallId, text) {
            if (root === undefined) return undefined;
            const bytes = Buffer.byteLength(text, 'utf8');
            if (bytes <= OUTPUT_OFFLOAD_BYTES) return undefined;

            const ref = toolOutputRelPath(roomId, at, toolCallId);
            const file = join(root, ref);
            try {
                mkdirSync(dirname(file), { recursive: true });
                writeFileSync(file, text, 'utf8');
            } catch (error) {
                console.error(`[output-store] 写盘失败，正文留在条目里：${(error as Error).message}`);
                return undefined;
            }
            return {
                ref,
                bytes,
                lines: countLines(text),
                truncated: true,
                preview: previewOf(text),
            };
        },
    };
}
